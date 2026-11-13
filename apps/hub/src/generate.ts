import { AgentSystem, fromOpenAIBody } from '@app/ai';
import {
  applyRegexScripts, assemblePrompt, buildChatRequest, estimateTokens, formatEnvironmentBlock, FREE_SCENE,
  parseControlTags, substituteMacros,
  type Message, type MessagePart, type ProactiveContext, type ProactiveCredentials, type Touchpoint,
} from '@app/shared';

/** 发给云端模型的一条消息：文字（没有文字时是语音的转写、配图的描述），再加上你发的照片（识图看到的内容） */
function messageText(m: Message): string {
  const base = m.text || m.parts.map((p) => (p.type === 'voice' ? p.transcript : p.type === 'image' && !p.photo ? `[图片：${p.caption}]` : '')).join(' ');
  const photos = m.parts.flatMap((p) => (p.type === 'image' && p.photo ? [p.seen ? `[照片：${p.seen}]` : '[照片]'] : []));
  return [base.trim(), ...photos].filter(Boolean).join(' ');
}

export function proactivePrompt(context: ProactiveContext, t: Touchpoint, now: number, model: string) {
  const { character: c, chat, persona, preset, history } = context;
  if (!preset) throw new Error('没有主动消息预设，请在 App 的预设页选择后同步');
  const date = new Date(now);
  const timeZone = context.environment.timezone;
  const macros = { char: c.name, user: persona.name, now: date, timeZone };
  const hint = substituteMacros(t.hint, macros);
  const time = substituteMacros('{{isodate}} {{time}}', macros);
  const quiet = `【主动消息】现在是 ${time}（${timeZone}），${persona.name}还没有来找你，由${c.name}先开口。这一次要做的事：${hint}。`;
  // 预设里"只改发给 AI 的"正则按深度改（0 = 最后一条），同 App 里发消息时
  const live = history.filter((m) => !m.deleted).map((m) => ({ m, text: messageText(m) })).filter((x) => x.text);
  const result = assemblePrompt({
    character: c, preset, user: persona, lorebooks: context.lorebooks,
    history: live.map(({ m, text }, i) => {
      const placement = m.role === 'user' ? 'user_input' : m.role === 'assistant' ? 'ai_output' : null;
      return {
        role: m.role === 'user' || m.role === 'assistant' ? m.role : 'system',
        name: m.role === 'user' ? persona.name : m.role === 'assistant' ? c.name : '',
        content: placement ? applyRegexScripts(preset.regex, text, { target: 'prompt', placement, depth: live.length - 1 - i, char: c.name, user: persona.name }) : text,
      };
    }),
    app: {
      // 手机拼好的两块（画像卡 + 时间线；每次都带的 + 最重要的 30 条）；旧版 App 上传的没有这两块时退回原来的写法
      summary: context.memoryBlocks
        ? { content: context.memoryBlocks.summary, source: '画像卡和时间线' }
        : { content: (chat.summaries ?? []).slice(-6).map((s) => s.text).join('\n'), source: '聊天摘要' },
      memory: context.memoryBlocks
        ? { content: context.memoryBlocks.memory, source: '记忆和关系' }
        : { content: context.memories.map((m) => `- ${m.content}`).join('\n') + `\n关系：${JSON.stringify(c.relationship)}`, source: '记忆和关系' },
      environment: { content: formatEnvironmentBlock({ now: date, timeZone }), source: `云端当前时间（${timeZone}）` },
      sceneRules: { content: FREE_SCENE.promptFragment, source: '日常聊天' },
      proactive: { content: quiet, source: '本次主动消息' },
    },
    type: 'quiet', now: date, timeZone, vars: chat.vars, loreState: chat.loreState, dryRun: true, model,
  });
  if (!result.blocks.some((b) => b.identifier === 'proactive' && b.sent)) {
    result.messages.push({ role: 'system', content: quiet, source: 'quiet', label: '本次主动消息' });
  }
  return fromOpenAIBody(buildChatRequest(result, preset, model));
}

export async function generateMessage(context: ProactiveContext, credentials: ProactiveCredentials, t: Touchpoint, now: number): Promise<Message> {
  const { character: c, chat } = context;
  let text = `${c.name}邀请你语音通话`;
  let parts: MessagePart[] = [{ type: 'call-log', durationSec: 0, missed: true }];
  let expression: string | null = null;
  let meta: Message['meta'] = { agent: 'proactive' };
  if (t.action !== 'call') {
    // The scheduler reserves the shared daily budget atomically in D1 before calling this.
    const system = new AgentSystem({ config: {
      routes: () => credentials.routes.map((r) => ({ ...r, dailyTokenBudget: 0 })),
      keyOf: (id) => credentials.keys[id] || null,
    }, outputFilters: credentials.outputFilters });
    const attempt = system.router.attempts('proactive')[0]!;
    const request = proactivePrompt(context, t, now, attempt.endpoint.model);
    request.names = { user: context.persona.name, char: c.name };
    const r = await system.chat('proactive', request, { stream: false, signal: AbortSignal.timeout(120_000) });
    // 预设里改存下来的消息的正则（作用在"她的回复"上的），同 App 里的回复
    const reply = applyRegexScripts(context.preset?.regex, r.text, { target: 'store', placement: 'ai_output', char: c.name, user: context.persona.name });
    const parsed = parseControlTags(reply, FREE_SCENE.allowedTags.filter((k) => ['expr', 'music'].includes(k)));
    text = parsed.visible.trim();
    parts = text ? [{ type: 'text', text }] : [];
    for (const { tag } of parsed.tags) {
      if (tag.kind === 'expr') expression = tag.value;
      if (tag.kind === 'music') parts.push({ type: 'music', songId: '', title: tag.title, artist: tag.artist });
    }
    if (!parts.length) throw new Error('主动消息模型返回了空内容');
    meta = { agent: 'proactive', model: r.model, latencyMs: r.latencyMs, fellBack: r.fellBack,
      tokens: (r.usage?.inputTokens ?? estimateTokens(JSON.stringify(request.messages))) + (r.usage?.outputTokens ?? estimateTokens(r.text)) };
  }
  return { id: `proactive:${t.id}`, chatId: chat.id, role: 'assistant', createdAt: now, updatedAt: now,
    text, parts, expression, swipes: [], swipeIndex: 0, proactive: true, read: false, meta };
}
