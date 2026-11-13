import type { Character } from '../types/character.ts';
import type { LoreTimedState, Lorebook } from '../types/lorebook.ts';
import type { Preset, PromptBlock } from '../types/preset.ts';
import { substituteMacros, type MacroContext } from './macros.ts';
import { estimateTokens } from './tokens.ts';
import { scanWorldInfo, type WorldInfoResult } from './worldinfo.ts';

/**
 * 拼 Chat Completion 提示词，按 SillyTavern 的 populateChatCompletion（public/scripts/openai.js）：
 * - 预设里的块按顺序；关掉的不发；marker 由程序填充（角色卡、世界书、人设、示例对话、聊天记录）
 * - 角色卡的 system_prompt / post_history_instructions 覆盖主提示 / 后置指令（可用 {{original}}）
 * - 聊天记录开头插 new_chat_prompt；每段示例对话前插 new_example_chat_prompt
 * - 按深度插入的内容（预设里的 in-chat 块、世界书 @深度、角色卡 depth_prompt、作者注位置的世界书）
 *   同深度同角色合成一条，插到聊天记录倒数第 N 条前
 * - token 预算 = 上下文 − 回复最长；先放必带的块，再从最新往旧放聊天记录，最后放示例对话
 * - 空内容的消息不发
 * App 自己的块（记忆、摘要、环境、场景规则）由调用方填好内容传进来。
 */

export type ChatRole = 'system' | 'user' | 'assistant';

/** 一条聊天记录（调用方已把消息转成文字；旁白 / 场景分隔用 system） */
export interface ChatTurn {
  role: ChatRole;
  name: string;
  content: string;
}

export interface AppBlockFill {
  content: string;
  source: string;
}

export type GenerationType = 'normal' | 'continue' | 'impersonate' | 'swipe' | 'regenerate' | 'quiet';

export interface AssembleInput {
  preset: Preset;
  character: Pick<Character, 'name' | 'card'>;
  user: { name: string; description: string };
  lorebooks: Lorebook[];
  /** 聊天记录，从旧到新，最后一条通常是你刚发的 */
  history: ChatTurn[];
  /** App 自己的程序填充块：memory / summary / environment / sceneRules */
  app?: Partial<Record<string, AppBlockFill>>;
  type?: GenerationType;
  /**
   * 一起做事时这一次要做的事（场景任务名，例如 study-break）：触发条件里写了这个名字的块，只在做这件事时发送。
   * 没写触发条件的块照常发送
   */
  task?: string;
  /**
   * 你人设里开着的系统（housework 家务、health 健康，见 LIFE_FLAGS）：触发条件里写了它们的块只在开着时发送
   * （"家务：你怎么反应"那一块，没开家务系统时不发）
   */
  flags?: string[];
  now?: Date;
  timeZone?: string;
  idleMs?: number | null;
  vars?: Record<string, string>;
  loreState?: LoreTimedState;
  /** 只是预览（查看提示词）：世界书粘性 / 冷却不推进 */
  dryRun?: boolean;
  random?: () => number;
  countTokens?: (text: string) => number;
  model?: string;
}

export interface PromptMessage {
  role: ChatRole;
  content: string;
  name?: string;
  /** 来自哪一块：块的 identifier，或 chatHistory / newChat / example / inject */
  source: string;
  /** 给人看的来源 */
  label: string;
}

export interface BlockReport {
  identifier: string;
  name: string;
  role: ChatRole;
  enabled: boolean;
  origin: 'preset' | 'app';
  marker: boolean;
  placement: string;
  source: string;
  content: string;
  tokens: number;
  /** 这一轮有没有发出去 */
  sent: boolean;
  /** 没发出去的原因 */
  note?: string;
}

export interface AssembleResult {
  messages: PromptMessage[];
  blocks: BlockReport[];
  lore: WorldInfoResult;
  tokens: number;
  /** 提示词可用的 token = 上下文 − 回复最长 */
  budget: number;
  /** 必带的块已经超出预算（ST 会报"Mandatory prompts exceed the context size"） */
  overBudget: boolean;
  historyIncluded: number;
  historyTotal: number;
  vars: Record<string, string>;
  loreState: LoreTimedState;
}

const TYPE_LABEL: Record<string, string> = {
  normal: '正常发送',
  continue: '继续',
  impersonate: '代你说话',
  swipe: '换一条',
  regenerate: '重新生成',
  quiet: '后台',
  housework: '开了家务系统',
  health: '开了健康系统',
};

function stringFormat(format: string, value: string): string {
  if (!value) return '';
  if (!format.trim()) return value;
  // 用函数替换：内容里的 $$、$&（LaTeX 公式）不会被当成替换记号
  return format.replace(/\{0\}/g, () => value);
}

/**
 * 示例对话：按 <START> 分段，每段里"名字:"开头的行切成一条（同 ST 的 parseExampleIntoIndividual）。
 * 比 ST 多认一个全角冒号"名字："——中文卡常这么写，ST 会把这种行整段丢掉。
 */
export function parseExamples(raw: string, userName: string, charName: string): { role: ChatRole; content: string; name: string }[][] {
  if (!raw.trim()) return [];
  const text = /^\s*<START>/i.test(raw) ? raw : `<START>\n${raw}`;
  const blocks = text.split(/<START>/i).slice(1).map((b) => b.replace(/\r/g, '').trim()).filter(Boolean);
  return blocks.map((block) => {
    const out: { role: ChatRole; content: string; name: string }[] = [];
    let lines: string[] = [];
    let mode: 'user' | 'char' | null = null;
    const said = (line: string, who: string) => line.startsWith(`${who}:`) || line.startsWith(`${who}：`);
    const flush = () => {
      if (!mode) return;
      const who = mode === 'user' ? userName : charName;
      const text = lines.join('\n');
      const at = [text.indexOf(`${who}:`), text.indexOf(`${who}：`)].filter((i) => i >= 0).sort((a, b) => a - b)[0];
      const content = at === undefined ? text : text.slice(0, at) + text.slice(at + who.length + 1);
      out.push({ role: 'system', content: content.trim(), name: mode === 'user' ? 'example_user' : 'example_assistant' });
      lines = [];
    };
    for (const line of block.split('\n')) {
      if (said(line, userName)) {
        if (mode === 'char') flush();
        mode = 'user';
      } else if (said(line, charName)) {
        if (mode === 'user') flush();
        mode = 'char';
      }
      lines.push(line);
    }
    flush();
    return out;
  });
}

interface Injection {
  depth: number;
  order: number;
  role: ChatRole;
  content: string;
  label: string;
  /** 世界书 / 角色卡 depth_prompt / 作者注：ST 里属于"扩展提示"，和 order 100 的块合在一起 */
  ext: boolean;
}

export function assemblePrompt(input: AssembleInput): AssembleResult {
  const { preset, character } = input;
  const card = character.card;
  const f = preset.formats;
  const s = preset.sampler;
  const type = input.type ?? 'normal';
  const count = input.countTokens ?? estimateTokens;
  const vars: Record<string, string> = { ...(input.vars ?? {}) };
  const history = input.history.map((t) => ({ ...t, content: t.content.replace(/\r/g, '') }));
  const lastOf = (role: ChatRole) => [...history].reverse().find((t) => t.role === role)?.content ?? '';

  const ctx: MacroContext = {
    char: character.name,
    user: input.user.name,
    now: input.now,
    timeZone: input.timeZone,
    idleMs: input.idleMs,
    vars,
    random: input.random,
    model: input.model,
    charPrompt: card.systemPrompt,
    charJailbreak: card.postHistoryInstructions,
    charVersion: card.characterVersion,
    lastMessage: history.at(-1)?.content ?? '',
    lastUserMessage: lastOf('user'),
    lastCharMessage: lastOf('assistant'),
  };
  const m = (text: string, extra?: Partial<MacroContext>) => substituteMacros(text, extra ? { ...ctx, ...extra } : ctx);

  // 角色卡字段先替换宏，再去掉 \r（同 ST 的 baseChatReplace）
  const field = (t: string) => m(t).replace(/\r/g, '');
  ctx.description = field(card.description);
  ctx.personality = field(card.personality);
  ctx.scenario = field(card.scenario);
  ctx.persona = field(input.user.description);
  ctx.mesExamples = field(card.mesExample);

  // 世界书（扫描文本带名字，同 ST 默认的 world_info_include_names）
  const lore = scanWorldInfo({
    books: input.lorebooks,
    messages: history.map((t) => `${t.name}: ${t.content}`),
    maxContext: s.contextTokens,
    chatLength: history.length,
    state: input.loreState,
    dryRun: input.dryRun,
    trigger: type,
    random: input.random,
    macro: (t) => m(t),
    countTokens: count,
  });

  // 示例对话（世界书的"示例对话前 / 后"条目也算一段）
  const exampleText = [...lore.emTop.map((x) => `<START>\n${x}`), ctx.mesExamples, ...lore.emBottom.map((x) => `<START>\n${x}`)].filter((x) => x.trim()).join('\n');
  const examples = parseExamples(exampleText, input.user.name, character.name);

  const reports: BlockReport[] = [];
  const injections: Injection[] = [];
  type Slot = { kind: 'messages'; msgs: PromptMessage[] } | { kind: 'history'; report: BlockReport } | { kind: 'examples'; report: BlockReport };
  const slots: Slot[] = [];
  let hasHistory = false;

  const placement = (b: PromptBlock) =>
    b.injection.position === 'absolute' ? (b.injection.depth === 0 ? '插在聊天记录最后' : `插在聊天记录倒数第 ${b.injection.depth} 条前`) : '按顺序';

  const fill = (b: PromptBlock): { content: string; source: string } => {
    switch (b.identifier) {
      case 'worldInfoBefore':
        return { content: stringFormat(f.wiFormat, lore.before), source: `世界书（角色前）命中 ${lore.activated.filter((a) => a.entry.position === 'before_char' && a.content).length} 条` };
      case 'worldInfoAfter':
        return { content: stringFormat(f.wiFormat, lore.after), source: `世界书（角色后）命中 ${lore.activated.filter((a) => a.entry.position === 'after_char' && a.content).length} 条` };
      case 'charDescription':
        return { content: ctx.description ?? '', source: '角色卡 description' };
      case 'charPersonality':
        return { content: ctx.personality ? m(f.personalityFormat) : '', source: '角色卡 personality' };
      case 'scenario':
        return { content: ctx.scenario ? m(f.scenarioFormat) : '', source: '角色卡 scenario' };
      case 'personaDescription':
        return { content: ctx.persona ?? '', source: `你的人设（${input.user.name}）` };
    }
    if (b.marker) {
      const app = input.app?.[b.identifier];
      return app ? { content: app.content, source: app.source } : { content: '', source: '程序填充' };
    }
    const original = m(b.content);
    if (b.identifier === 'main' && f.preferCharacterPrompt && card.systemPrompt.trim() && !b.forbidOverrides) {
      return { content: m(card.systemPrompt, { original }), source: '角色卡 system_prompt（覆盖了预设的主提示）' };
    }
    if (b.identifier === 'jailbreak' && f.preferCharacterJailbreak && card.postHistoryInstructions.trim() && !b.forbidOverrides) {
      return { content: m(card.postHistoryInstructions, { original }), source: '角色卡 post_history_instructions（覆盖了预设的后置指令）' };
    }
    return { content: original, source: '预设' };
  };

  for (const b of preset.blocks) {
    const report: BlockReport = {
      identifier: b.identifier,
      name: b.name,
      role: b.role,
      enabled: b.enabled,
      origin: b.origin === 'app' ? 'app' : 'preset',
      marker: b.marker,
      placement: placement(b),
      source: b.marker ? '程序填充' : '预设',
      content: '',
      tokens: 0,
      sent: false,
    };
    reports.push(report);
    if (!b.enabled) {
      report.note = '预设里关闭了';
      // 程序填充的块照样算一下内容，方便看"关掉的这块本来会放什么"（不算普通块，免得执行里面的 {{setvar}}）
      if (b.marker && b.identifier !== 'chatHistory' && b.identifier !== 'dialogueExamples') {
        const { content, source } = fill(b);
        report.content = content;
        report.source = source;
        report.tokens = count(content);
        if (content.trim()) report.note = '预设里关闭了，这块内容没有发送';
      }
      continue;
    }
    if (b.triggers?.length && !b.triggers.includes(type) && !(input.task && b.triggers.includes(input.task)) && !input.flags?.some((f) => b.triggers!.includes(f))) {
      report.note = `只在 ${b.triggers.map((t) => TYPE_LABEL[t] ?? t).join(' / ')} 时发送`;
      continue;
    }
    if (b.identifier === 'chatHistory') {
      hasHistory = true;
      report.source = '聊天记录';
      slots.push({ kind: 'history', report });
      continue;
    }
    if (b.identifier === 'dialogueExamples') {
      report.source = '角色卡 mes_example';
      slots.push({ kind: 'examples', report });
      continue;
    }
    const { content, source } = fill(b);
    report.content = content;
    report.source = source;
    report.tokens = count(content);
    if (!content.trim()) {
      report.note = '这一轮内容为空，不发送';
      continue;
    }
    if (b.injection.position === 'absolute') {
      injections.push({ depth: b.injection.depth, order: b.injection.order ?? 100, role: b.role, content, label: b.name, ext: false });
      continue;
    }
    report.sent = true;
    slots.push({ kind: 'messages', msgs: [{ role: b.role, content, source: b.identifier, label: b.name }] });
  }

  // 扩展提示：世界书 @深度、角色卡 depth_prompt、作者注位置的世界书（没有作者注时按 ST 默认深度 4）
  for (const d of lore.depth) injections.push({ depth: d.depth, order: 100, role: d.role, content: d.content, label: `世界书 @深度 ${d.depth}`, ext: true });
  const dp = card.extensions.depth_prompt as { prompt?: unknown; depth?: unknown; role?: unknown } | undefined;
  if (dp && typeof dp.prompt === 'string' && dp.prompt.trim()) {
    const role: ChatRole = dp.role === 'user' || dp.role === 'assistant' ? dp.role : 'system';
    injections.push({ depth: Number(dp.depth ?? 4) || 0, order: 100, role, content: m(dp.prompt), label: '角色卡 depth_prompt', ext: true });
  }
  if (lore.anTop.length || lore.anBottom.length) {
    injections.push({ depth: 4, order: 100, role: 'system', content: [...lore.anTop, ...lore.anBottom].join('\n'), label: '世界书（作者注位置）', ext: true });
  }

  // 聊天记录（最新的在前），按 ST 的 populationInjectionPrompts 插入
  const nb = f.namesBehavior;
  const nf: (PromptMessage & { injected?: boolean })[] = history
    .map((t, i): PromptMessage => {
      const named = nb === 2 && t.role !== 'system' ? `${t.name}: ${t.content}` : t.content;
      return {
        role: t.role,
        content: named,
        ...(nb === 1 && t.role !== 'system' && t.name ? { name: t.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) } : {}),
        source: `chatHistory-${i + 1}`,
        label: `聊天记录 #${i + 1}`,
      };
    })
    .reverse();
  if (hasHistory) {
    const maxDepth = Math.max(-1, ...injections.map((x) => x.depth));
    let inserted = 0;
    for (let d = 0; d <= maxDepth; d++) {
      const here = injections.filter((x) => x.depth === d && x.content);
      if (!here.length) continue;
      const orders = [...new Set([100, ...here.map((x) => x.order)])].sort((a, b) => b - a);
      const roleMsgs: (PromptMessage & { injected: boolean })[] = [];
      for (const order of orders) {
        for (const role of ['system', 'user', 'assistant'] as const) {
          const own = here.filter((x) => !x.ext && x.order === order && x.role === role);
          const ext = order === 100 ? here.filter((x) => x.ext && x.role === role) : [];
          const parts = [...own, ...ext];
          const joint = parts.map((x) => x.content.trim()).filter(Boolean).join('\n');
          if (joint) roleMsgs.push({ role, content: joint, source: 'inject', label: `${parts.map((x) => x.label).join(' + ')}（倒数第 ${d} 条前）`, injected: true });
        }
      }
      if (roleMsgs.length) {
        nf.splice(d + inserted, 0, ...roleMsgs);
        inserted += roleMsgs.length;
      }
    }
  }
  for (const r of reports) {
    if (r.sent || r.note || r.identifier === 'chatHistory' || r.identifier === 'dialogueExamples') continue;
    if (!r.content.trim()) continue;
    // 按深度插入的块
    r.sent = hasHistory;
    if (!hasHistory) r.note = '预设里没有聊天记录，按深度插入的块没有地方放';
  }
  const chatMsgs = nf.reverse();

  // 预算
  const budget = Math.max(1, s.contextTokens - s.maxTokens);
  const fixed = slots.flatMap((x) => (x.kind === 'messages' ? x.msgs : []));
  const newChat = m(f.newChatPrompt);
  let used = fixed.reduce((n, x) => n + count(x.content), 0) + (hasHistory ? count(newChat) : 0) + 3;
  const overBudget = used > budget;

  const historyOut: PromptMessage[] = [];
  let historyIncluded = 0;
  if (hasHistory) {
    if (chatMsgs.at(-1)?.role === 'assistant' && f.sendIfEmpty.trim()) {
      const extra = { role: 'user' as const, content: m(f.sendIfEmpty), source: 'sendIfEmpty', label: '最后一条是她的，补一条你的（send_if_empty）' };
      if (used + count(extra.content) <= budget) {
        historyOut.push(extra);
        used += count(extra.content);
      }
    }
    for (let i = chatMsgs.length - 1; i >= 0; i--) {
      const msg = chatMsgs[i] as PromptMessage & { injected?: boolean };
      const t = count(msg.content);
      if (used + t > budget) break;
      used += t;
      historyOut.unshift(msg);
      if (!msg.injected) historyIncluded++;
    }
    if (newChat.trim()) historyOut.unshift({ role: 'system', content: newChat, source: 'newChat', label: '新聊天提示（new_chat_prompt）' });
  }

  const exampleOut: PromptMessage[] = [];
  const newExample = m(f.newExampleChatPrompt);
  examples.forEach((ex, i) => {
    const msgs: PromptMessage[] = [
      ...(newExample.trim() ? [{ role: 'system' as const, content: newExample, source: 'newExampleChat', label: '示例对话开头（new_example_chat_prompt）' }] : []),
      ...ex.map((x, j) => ({ role: x.role, content: x.content, name: x.name, source: `example-${i + 1}-${j + 1}`, label: `示例对话 ${i + 1} · ${x.name === 'example_user' ? input.user.name : character.name}` })),
    ];
    const t = msgs.reduce((n, x) => n + count(x.content), 0);
    if (used + t > budget) return;
    used += t;
    exampleOut.push(...msgs);
  });

  let messages: PromptMessage[] = [];
  for (const slot of slots) {
    if (slot.kind === 'messages') messages.push(...slot.msgs);
    else if (slot.kind === 'history') {
      messages.push(...historyOut);
      slot.report.content = historyOut.map((x) => `${x.role}: ${x.content}`).join('\n');
      slot.report.tokens = historyOut.reduce((n, x) => n + count(x.content), 0);
      slot.report.sent = historyOut.length > 0;
      slot.report.source = `聊天记录 ${historyIncluded} / ${history.length} 条${newChat.trim() ? ' + 开头的新聊天提示' : ''}`;
      if (!historyOut.length) slot.report.note = '还没有聊天记录';
    } else {
      messages.push(...exampleOut);
      slot.report.content = exampleOut.map((x) => `${x.name ?? x.role}: ${x.content}`).join('\n');
      slot.report.tokens = exampleOut.reduce((n, x) => n + count(x.content), 0);
      slot.report.sent = exampleOut.length > 0;
      slot.report.source = `角色卡 mes_example · ${examples.length} 段`;
      if (!exampleOut.length) slot.report.note = examples.length ? '预算不够，示例对话没放进去' : '角色卡没有示例对话';
    }
  }

  messages = messages.filter((x) => x.content);
  if (f.squashSystemMessages) {
    const keep = new Set(['newChat', 'newExampleChat']);
    const squashed: PromptMessage[] = [];
    for (const msg of messages) {
      const prev = squashed.at(-1);
      const can = (x: PromptMessage) => x.role === 'system' && !x.name && !keep.has(x.source);
      if (prev && can(prev) && can(msg)) {
        prev.content = `${prev.content}\n${msg.content}`;
        prev.label = `${prev.label} + ${msg.label}`;
      } else squashed.push({ ...msg });
    }
    messages = squashed;
  }

  return {
    messages,
    blocks: reports,
    lore,
    tokens: messages.reduce((n, x) => n + count(x.content), 0),
    budget,
    overBudget,
    historyIncluded,
    historyTotal: history.length,
    vars,
    loreState: lore.state,
  };
}

/** 发给 OpenAI 兼容接口的请求体（/v1/chat/completions） */
export function buildChatRequest(result: Pick<AssembleResult, 'messages'>, preset: Pick<Preset, 'sampler'> & Partial<Pick<Preset, 'extra'>>, model: string): Record<string, unknown> {
  const s = preset.sampler;
  const body: Record<string, unknown> = {
    model,
    messages: result.messages.map(({ role, content, name }) => (name ? { role, content, name } : { role, content })),
    temperature: s.temperature,
    top_p: s.topP,
    max_tokens: s.maxTokens,
    frequency_penalty: s.frequencyPenalty,
    presence_penalty: s.presencePenalty,
    stream: s.stream,
  };
  if (s.topK) body.top_k = s.topK;
  if (s.seed != null && s.seed >= 0) body.seed = s.seed;
  // SillyTavern 预设里和调用方式有关的设置（导入时原样存在 extra 里），同 ST 发给后端的字段名；由 AI 调用层按各家协议决定怎么发
  const x = preset.extra ?? {};
  if (typeof x.assistant_prefill === 'string' && x.assistant_prefill.trim()) body.assistant_prefill = x.assistant_prefill;
  if (typeof x.reasoning_effort === 'string' && x.reasoning_effort) body.reasoning_effort = x.reasoning_effort;
  if (typeof x.show_thoughts === 'boolean') body.include_reasoning = x.show_thoughts;
  if (typeof x.custom_prompt_post_processing === 'string' && x.custom_prompt_post_processing) body.custom_prompt_post_processing = x.custom_prompt_post_processing;
  return body;
}
