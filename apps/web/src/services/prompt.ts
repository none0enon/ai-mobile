import {
  applyRegexScripts,
  assemblePrompt,
  buildChatRequest,
  CONTROL_TAG_DOCS,
  estimateTokens,
  formatEnvironmentBlock,
  getLocation,
  getScene,
  isRealPlace,
  MEAL_LABEL,
  PRESET_CATEGORIES,
  presetUse,
  sceneUse,
  type AppBlockFill,
  type PresetUseId,
  type AssembleResult,
  type Character,
  type Chat,
  type ChatTurn,
  type GenerationType,
  type Message,
  type MessagePart,
  type AgentRole,
  type Persona,
  type Preset,
  type RegexScript,
  type TruthDareTally,
} from '@app/shared';
import type { LLMChatMessage } from './types';
import { mockToday, todayLine } from '@/mock/activity';
import { useAiStore } from '@/stores/ai';
import { usePersonaStore } from '@/stores/personas';
import { useEnvironmentStore } from '@/stores/environment';
import { useLibraryStore } from '@/stores/library';
import { afterSummarized, lastN, useMessageSettingsStore } from '@/stores/messageSettings';
import { useRealWorldStore } from '@/stores/realworld';
import { useRhythmStore } from '@/stores/rhythm';
import { useWeatherStore } from '@/stores/weather';
import { homeBlock, lifeFlags } from './homeBlock';
import { memoryBlock, summaryBlock } from './memoryBlocks';
import { recallForTurn, type RecallForTurn } from './recall';

/**
 * 每一轮的提示词：把这条聊天、角色卡、绑定的世界书、预设交给共享的拼装器（packages/shared/src/st/assemble.ts，
 * 按 SillyTavern 的规则拼），App 自己的记忆 / 摘要 / 环境 / 场景规则在这里填好内容传进去。
 * 发送和"查看提示词"用的是同一个函数，所以查看到的就是真实请求。
 */

export { estimateTokens };

export function personaOf(chat: Chat | undefined): Persona {
  return usePersonaStore().forChat(chat);
}

function partToText(p: MessagePart, character: Character, user: string, mapText?: (text: string) => string): string {
  switch (p.type) {
    case 'text':
      return mapText ? mapText(p.text) : p.text;
    case 'voice':
      return `[语音] ${p.transcript}`;
    case 'image':
      // 你发的照片：识图看到的内容代替图片；没看成就照实说看不到
      if (p.photo) return p.seen ? `[照片：${p.seen}]` : `[照片（${character.name}看不到照片的内容）]`;
      return `[图片：${p.title || p.caption}]`;
    case 'music':
      return `[分享歌曲：${p.title} - ${p.artist}]`;
    case 'poke':
      return p.actor === 'user' ? `（${user}拍了拍${character.name}的${p.target}）` : `（${character.name}拍了拍${user}）`;
    case 'call-log':
      return `[${p.video ? '视频通话' : '语音通话'} ${Math.round(p.durationSec / 60)} 分钟${p.scene ? ` · ${p.scene}` : ''}]`;
    case 'workout':
      return `[${workoutText(p)}]`;
    case 'chore':
      return p.status === 'done'
        ? `[家务：${p.name} 做完了${p.minutes ? `，做了 ${p.minutes} 分钟` : ''}${p.later ? `（之前拖了 ${p.later} 次）` : ''}${p.note ? `；${p.note}` : ''}]`
        : `[家务：${p.name} 说晚点再做（拖了 ${p.later ?? 1} 次）]`;
    case 'meal': {
      const how = p.how === 'together' ? '共同吃饭' : p.how === 'solo' ? '各吃各的' : '';
      const way = p.plan ? `按计划${{ cook: '自己做', buy: '去买', bento: '带便当' }[p.plan.way]}（计划：${p.plan.name}）` : p.mode === 'free' ? '随便吃点' : '';
      const extra = [p.photo ? '拍了照片' : '', p.herMeal ? `${character.name}吃的：${p.herMeal}` : '', p.cheers ? `碰杯 ${p.cheers} 次` : ''].filter(Boolean);
      const meta = [how, way].filter(Boolean).join('，');
      return `[一起吃饭 · ${MEAL_LABEL[p.meal] ?? '一顿饭'}：${p.food}${meta ? `（${meta}）` : ''}${extra.length ? `；${extra.join('；')}` : ''}]`;
    }
    case 'study': {
      const done = p.tasks?.filter((t) => t.done).map((t) => t.text) ?? [];
      const extra = [
        done.length ? `完成：${done.join('、')}` : '',
        p.promise ? `约定"${p.promise.text}"${p.promise.kept ? '做到了' : '没做到'}` : '',
      ].filter(Boolean);
      const how = !p.timer || p.timer === 'pomodoro' ? `${p.pomodoros} 个番茄，` : p.timer === 'countdown' ? '倒计时，' : '正计时，';
      return `[陪伴学习：${how}${p.minutes} 分钟${p.together === false ? '，各自专注' : ''}${extra.length ? `；${extra.join('；')}` : ''}]`;
    }
    case 'date':
      return `[约会邀请：${p.when} ${p.place}]`;
    case 'gift':
      return `[礼物：${p.name}]`;
    case 'read':
      return `[一起读《${p.title}》：读到${p.chapter}，全书 ${p.progress}%，写了 ${p.notes} 条批注${p.quote ? `；划了"${p.quote}"` : ''}]`;
    case 'game':
      if (p.game === 'truthdare') {
        const tally = (t: TruthDareTally) => `真心话 ${t.truth} 次、大冒险 ${t.dare} 次${t.skipped ? `、认罚 ${t.skipped} 次` : ''}`;
        return `[真心话大冒险${p.level ? `（${p.level}）` : ''}：玩了 ${p.rounds} 轮；${user}${tally(p.you)}；${character.name}${tally(p.her)}]`;
      }
      if (p.game === 'decor') {
        const her = p.herAdded ? `，其中${character.name}放了 ${p.herAdded} 件` : '';
        return `[一起装修小屋「${p.room}」：现在摆了 ${p.items} 件，这一次添了 ${p.added} 件${her}]`;
      }
      if (p.game === 'workshop') {
        const mood = p.verdict === 'cheer' ? '，想听她捧场' : p.verdict === 'roast' ? '，想听她吐槽' : '';
        if (p.kind === 'image') return `[${user}在创意工坊画了一张画「${p.title}」拿给${character.name}看${mood}]`;
        const head = p.excerpt ? `，开头是：${p.excerpt}` : '';
        return `[${user}在创意工坊写的小说《${p.title}》${p.chapter ? `的「${p.chapter}」` : ''}拿给${character.name}看${mood}${head}]`;
      }
      if (p.game === 'flight') {
        const won = p.winner ? `；${p.winner === 'you' ? user : character.name}先到了终点` : '';
        return `[飞行棋「${p.board}」：掷了 ${p.turns} 次骰子；${user}走到第 ${p.you} 格，${character.name}走到第 ${p.her} 格（一共 ${p.size} 格）${won}]`;
      }
      return `[海龟汤《${p.title}》：${{ solved: '猜出来了', partial: '猜对了一半', 'gave-up': '认输了' }[p.result]}，问了 ${p.questions} 个问题${p.truth ? `；汤底：${p.truth}` : ''}]`;
    case 'watch':
      return `[一起看了《${p.title}》${p.minutes} 分钟${p.yourScore ? `；${user}打 ${p.yourScore}/5` : ''}${p.herScore ? `；${character.name}打 ${p.herScore}/5` : ''}]`;
    case 'scene':
      return `（${p.title}${p.summary ? `：${p.summary}` : ''}）`;
  }
}

/** 运动卡片的一句话："健身：照计划练「上肢 + 核心」做完 5/6 个动作，32 分钟；平均心率 138；约 210 千卡" */
export function workoutText(p: Extract<MessagePart, { type: 'workout' }>): string {
  const head = p.mode === 'plan' && p.plan ? `健身：照计划练「${p.plan.title}」，做完 ${p.plan.done}/${p.plan.total} 个动作` : `运动记录：${p.sport}`;
  const parts = [
    `用时 ${Math.max(1, Math.round(p.durationSec / 60))} 分钟`,
    p.distanceKm ? `${p.distanceKm} 公里${p.pace ? `（配速 ${p.pace}）` : ''}` : '',
    p.steps ? `${p.steps} 步` : '',
    p.heartRate?.avg ? `平均心率 ${p.heartRate.avg}${p.heartRate.max ? `、最高 ${p.heartRate.max}` : ''}` : '',
    p.kcal ? `约 ${p.kcal} 千卡` : '',
  ].filter(Boolean);
  return `${head}；${parts.join('；')}`;
}

/** mapText：只改文字部分（正则只改你写的、她说的，不动卡片的描述） */
export function messageToText(m: Message, character: Character, user = usePersonaStore().defaultPersona.name, mapText?: (text: string) => string): string {
  return m.parts.map((p) => partToText(p, character, user, mapText)).join(' ').trim();
}

export interface TurnOptions {
  /** 只发送最近几条（消息设置 → 发送条数）；不给不限 */
  last?: number;
  /** 预设里的正则：只跑"只改发给 AI 的"，按这条在发出去的聊天记录里的深度（0 = 最后一条） */
  regex?: readonly RegexScript[];
  /** 统计：有内容的消息一共几条、按条数截掉几条、正则改了几条 */
  stats?: { total: number; dropped: number; regexed: number };
}

/** 聊天记录 → 拼装器要的格式：旁白 / 场景分隔当系统消息（同 ST 的 narrator） */
export function toTurns(history: Message[], character: Character, user: string, opts: TurnOptions = {}): ChatTurn[] {
  const all = history.filter((m) => messageToText(m, character, user));
  const items = lastN(all, opts.last);
  if (opts.stats) Object.assign(opts.stats, { total: all.length, dropped: all.length - items.length, regexed: 0 });
  const out: ChatTurn[] = [];
  items.forEach((m, i) => {
    const placement = m.role === 'user' ? 'user_input' : m.role === 'assistant' ? 'ai_output' : null;
    const plain = messageToText(m, character, user);
    const text =
      placement && opts.regex?.length
        ? messageToText(m, character, user, (t) => applyRegexScripts(opts.regex, t, { target: 'prompt', placement, depth: items.length - 1 - i, char: character.name, user }))
        : plain;
    if (opts.stats && text !== plain) opts.stats.regexed++;
    // 正则把整条都删掉了：这一条不发（同空消息）
    if (!text) return;
    // 一起做事时说的话带上位置（第几个番茄、片内时间……），她知道是在哪一刻说的
    const content = m.meta?.cue ? `（${m.meta.cue}）${text}` : text;
    if (m.role === 'user') out.push({ role: 'user', name: user, content });
    else if (m.role === 'assistant') out.push({ role: 'assistant', name: character.name, content });
    else out.push({ role: 'system', name: '', content });
  });
  return out;
}

/**
 * 预设里改存下来的消息的正则（"只改显示""只改发给 AI 的"都没勾的）：她回复写完、你发送、改消息时执行（同 ST）。
 * 用这一轮的预设（聊天页是这个角色的对话预设）
 */
export function storeRegex(chat: Chat, character: Character, text: string, role: 'user' | 'assistant', opts: { edit?: boolean; preset?: Preset } = {}): string {
  const preset = opts.preset ?? presetForTurn(chat, character).preset;
  if (!preset?.regex.length) return text;
  return applyRegexScripts(preset.regex, text, {
    target: 'store',
    placement: role === 'user' ? 'user_input' : 'ai_output',
    edit: opts.edit,
    char: character.name,
    user: personaOf(chat).name,
  });
}

/** App 自己的四块：摘要、记忆 + 关系、【当前环境】、场景规则 */
function appFills(chat: Chat, character: Character, history: Message[], now: Date, timeZone: string, recall: RecallForTurn, proactive: boolean): Record<string, AppBlockFill> {
  const scene = getScene(chat.currentScene ?? 'free');
  const loc = getLocation(chat.togetherAt ?? character.locationId);
  const place = !loc
    ? null
    : chat.togetherAt
      ? isRealPlace(loc)
        ? loc.id === 'real:home'
          ? `${character.name}在你这边，你们一起在家`
          : `你带${character.name}出门了，你们一起在${loc.name}`
        : `你在${character.name}的小世界里陪${character.pronoun}，你们一起在${loc.name}`
      : `${character.name}在${character.pronoun}的小世界里的${loc.name}${character.status ? `（${character.status}）` : ''}；${useRealWorldStore().whereLine}`;

  // 距上次聊天：最后一条之前那条消息到现在
  const before = history.at(-2)?.createdAt;
  const sinceLastChatMin = before ? Math.max(0, (now.getTime() - before) / 60_000) : null;

  // 她今天穿什么（节律里这个场景该穿的那套）
  const outfit = useRhythmStore().outfitFor(character.id, chat.currentScene);
  // 真实天气：你那边；她住在别的城市（例如国内）时再加她那边的。取不到就不写，不编
  const { weather, herWeather } = useWeatherStore().envInput(character);

  const summary = summaryBlock(chat, character, timeZone);
  const memory = memoryBlock(character, recall.lines, now.getTime(), timeZone, { proactive });
  if (!proactive) {
    const notes = [
      recall.reused ? '重新生成：沿用这条回复原来用的记忆' : recall.snapshot ? `上一轮回复后搜好的 ${recall.snapshot.lines.length} 条${recall.snapshot.dense ? '（按意思 + 字面）' : `（${recall.snapshot.denseNote || '只按字面'}）`}` : '还没有搜过',
      recall.added ? `发送时按本轮消息补了 ${recall.added} 条` : '',
    ].filter(Boolean);
    memory.source = `${memory.source} · ${notes.join(' · ')}`;
  }

  return {
    summary,
    memory,
    environment: {
      content: formatEnvironmentBlock({
        now,
        timeZone,
        weather,
        herWeather,
        todayLine: todayLine(mockToday()),
        sinceLastChatMin,
        place,
        outfit: outfit ? `${character.name}今天穿${outfit.name}` : null,
        sceneName: scene.id === 'free' ? null : scene.name,
      }),
      source: `时间 / 节气 / 天气（${[weather ? `你那边 ${weather.city}` : '你那边没取到', herWeather ? `${character.name}那边 ${herWeather.city}` : ''].filter(Boolean).join('，')}）/ 今日活动 / 她在哪 / 她今天穿什么`,
    },
    sceneRules: {
      content: `${scene.promptFragment.replaceAll('{{char}}', character.name)}\n${tagsLine(scene)}`,
      source: `场景"${scene.name}"`,
    },
  };
}

/** 这个场景能用的标签：每个都写清楚写法和什么时候用（只给名字的话模型写不对，比如 [cg] 后面不带画面就画不出来） */
function tagsLine(scene: ReturnType<typeof getScene>): string {
  const tags = scene.allowedTags.map((t) => `- ${CONTROL_TAG_DOCS[t].syntax}：${CONTROL_TAG_DOCS[t].desc}`);
  return `回复里可以夹带这些隐藏标签（对方看不到，程序会执行）：\n${tags.join('\n')}\n可用表情：neutral smile laugh blush shy pout surprised sad angry sleepy sleep`;
}

/** 功能预设自己写了场景规则时，程序那块只填这个场景能用的标签和表情 */
function sceneTagsOnly(chat: Chat): AppBlockFill {
  const scene = getScene(chat.currentScene ?? 'free');
  return { content: tagsLine(scene), source: `场景"${scene.name}"能用的标签和表情（场景规则写在预设里）` };
}

/** 这个角色的对话预设；没选、或选的那个被删了时用第一个对话预设；一个对话预设都没有时为空 */
export function presetFor(character: Character | undefined): Preset | undefined {
  return useLibraryStore().chatPresetFor(character);
}

/** 这一轮用的是哪个用途的预设：主动消息 → 在场景页里一起做某件事（那件事的功能预设）→ 聊天（这个角色的对话预设）。场景只在场景页开着时有 */
export type ChatPresetUse = PresetUseId | 'chat';

export function presetForTurn(chat: Chat, character: Character, agent?: AgentRole, use?: PresetUseId): { preset: Preset | undefined; use: ChatPresetUse } {
  const lib = useLibraryStore();
  // 指定了用途（语音通话）：按那个用途选，不看场景
  if (use) return { preset: lib.presetForUse(use, character), use };
  if (agent === 'proactive') return { preset: lib.presetForUse('proactive', character), use: 'proactive' };
  const scene = sceneUse(chat.currentScene);
  if (scene) return { preset: lib.presetForUse(scene, character), use: scene };
  return { preset: lib.chatPresetFor(character), use: 'chat' };
}

/** 一个预设都选不到时的报错：说清楚缺哪一类、去哪里补 */
export class MissingPresetError extends Error {
  constructor(what: string) {
    super(`没有可用的${what}预设：去"我的 → 预设"导入一个预设文件，或者复制一个过来`);
    this.name = 'MissingPresetError';
  }
}

/** "功能 · 一起吃饭"、"对话"：这一轮的预设是按什么选的 */
export function useLabel(use: ChatPresetUse): string {
  if (use === 'chat') return '对话（这个角色的预设）';
  const u = presetUse(use);
  return u ? `${PRESET_CATEGORIES[u.category].label} · ${u.label}` : use;
}

/** 这个功能用的模型名（请求体里的 model）；还没接通时显示"演示模型" */
export function modelOf(agent: AgentRole = 'main'): string {
  const ai = useAiStore();
  return ai.isLive(agent) ? ai.chatModelOf(agent) || '演示模型' : '演示模型';
}

/** 主对话智能体用的模型名 */
export function mainModel(): string {
  return modelOf('main');
}

export interface ChatPrompt extends AssembleResult {
  preset: Preset;
  /** 预设是按什么选的：对话 / 某件事的功能预设 / 主动消息 */
  use: ChatPresetUse;
  persona: Persona;
  request: Record<string, unknown>;
  /** 交给拼装器之前的聊天记录：有内容的总条数、按发送条数截掉的条数、正则修改的条数、去掉的已总结消息条数 */
  turnStats: { total: number; dropped: number; regexed: number; last?: number; summarized?: number };
  /** 这一轮带上的记忆（取到的和为什么） */
  recall: RecallForTurn;
}

export interface ChatAssembleOptions {
  /** 同一次生成的提示词和时间宏共用这个时刻，按环境设置的时区格式化。 */
  now?: Date;
  /** 只是查看：不推进世界书的粘性 / 冷却、不改聊天变量 */
  dryRun?: boolean;
  type?: GenerationType;
  /**
   * 后台生成（主动消息）：这一次要她做的事（程序写的，只有时间和要做什么；怎么写由预设里的块说）。
   * 预设里有"主动消息"这一块就填在那儿；没有或关着时接在最后（同 SillyTavern 的 quiet prompt），不然模型不知道这次是她先开口
   */
  quiet?: string;
  /** 哪个功能在调用：决定用哪个用途的预设、请求体里写谁的模型；默认主对话 */
  agent?: AgentRole;
  /**
   * 一起做事时这一次要做的事：name 是任务名（预设里触发条件写了它的块只在这时发送），
   * input 是程序写的这一次的输入（只放数据，填进"场景任务"块；预设里没有这一块时接在最后）
   */
  task?: { name: string; input: string };
  /** 指定按哪个用途选预设（语音通话用 call）；不给时按主动消息 / 场景 / 对话预设 */
  use?: PresetUseId;
  /** 重新生成的那条回复：沿用它原来用的记忆 */
  targetId?: string;
  /** 这一次另外打开的触发条件（心跳连着玩具、指令由她自己写时是 device-inline）：块写了它就发送 */
  flags?: string[];
}

/**
 * 拼这一轮的提示词。history 是要发出去的聊天记录（从旧到新，最后一条通常是你刚发的）。
 * 预设按用途选：语音通话用"语音通话"选的预设，主动消息用"主动消息"预设，在场景页里一起做某件事时用那件事的功能预设，聊天里用这个角色的对话预设。
 */
export function assembleForChat(chat: Chat, character: Character, history: Message[], opts: ChatAssembleOptions = {}): ChatPrompt {
  const lib = useLibraryStore();
  const { preset, use } = presetForTurn(chat, character, opts.agent, opts.use);
  if (!preset) throw new MissingPresetError(use === 'chat' ? '对话' : useLabel(use));
  const persona = personaOf(chat);
  const model = modelOf(opts.agent);
  const books = character.lorebookIds.map((id) => lib.lorebookById(id)).filter((b) => !!b);
  const lastUser = [...history].reverse().find((m) => m.role === 'user');
  const prevUser = [...history].reverse().filter((m) => m.role === 'user')[1];
  const now = opts.now ?? new Date();
  const timeZone = useEnvironmentStore().settings.timezone;
  const proactive = opts.agent === 'proactive' || opts.type === 'quiet';
  const userText = lastUser ? messageToText(lastUser, character, persona.name) : '';
  const recall: RecallForTurn = proactive ? { lines: [], snapshot: undefined, added: 0, reused: false } : recallForTurn(chat, character, userText, opts.targetId);
  const app = appFills(chat, character, history, now, timeZone, recall, proactive);
  // 家务和健康：你人设里开着的系统今天的情况（都没开时没有这一块）
  const flags: string[] = [...lifeFlags(persona), ...(opts.flags ?? [])];
  // 预设里没有"她怎么反应"那一块的，自带的规则接在今天的情况后面
  const home = homeBlock(persona, { preset, characterName: character.name });
  if (home) app.home = home;
  if (opts.quiet) app.proactive = { content: opts.quiet, source: '主动消息：这一次要她做的事' };
  if (opts.task) app.sceneTask = { content: opts.task.input, source: `场景任务：${opts.task.name}` };
  // 功能预设里写了自己的"场景规则"：程序那块只填能用的标签和表情，不再重复场景规则
  if (preset.blocks.some((b) => b.identifier === 'sceneRule' && !b.marker && b.enabled) && app.sceneRules) app.sceneRules = sceneTagsOnly(chat);
  // 聊天记录：按消息设置的发送条数截取；预设中"仅格式提示词"的正则按深度执行（世界书扫描修改后的文本）
  // "已总结的消息不发送给 AI"：总结覆盖到的那条之前的不发（提示词里用时间线和取到的记忆代替）
  const msgSettings = useMessageSettingsStore();
  const last = msgSettings.sendCount();
  const sendable = msgSettings.settings.dropSummarized ? afterSummarized(history, chat.summaryUntilMessageId) : history;
  const turnStats = { total: 0, dropped: 0, regexed: 0 };
  const turns = toTurns(sendable, character, persona.name, { last, regex: preset.regex, stats: turnStats });
  const result = assemblePrompt({
    preset,
    character,
    user: { name: persona.name, description: persona.description },
    lorebooks: books,
    history: turns,
    app,
    type: opts.type,
    now,
    timeZone,
    idleMs: lastUser && prevUser ? lastUser.createdAt - prevUser.createdAt : null,
    vars: chat.vars,
    loreState: chat.loreState,
    dryRun: opts.dryRun,
    model,
    task: opts.task?.name,
    flags,
  });
  if (opts.quiet && !result.blocks.some((b) => b.identifier === 'proactive' && b.sent)) {
    result.messages.push({ role: 'system', content: opts.quiet, source: 'quiet', label: '主动消息：这一次要她做的事（预设里没有这一块，接在最后）' });
    result.tokens += estimateTokens(opts.quiet);
  }
  // 预设里没有"家务和健康"这一块（以前导入的 SillyTavern 预设、以前复制的）：今天的情况（和补上的规则）接在最后。
  // 有这一块但你关掉了的不补
  if (home && !preset.blocks.some((b) => b.identifier === 'home')) {
    result.messages.push({ role: 'system', content: home.content, source: 'home', label: '家务和健康（预设里没有这一块，接在最后）' });
    result.tokens += estimateTokens(home.content);
  }
  if (opts.task && opts.task.input.trim() && !result.blocks.some((b) => b.identifier === 'sceneTask' && b.sent)) {
    result.messages.push({ role: 'system', content: opts.task.input, source: 'sceneTask', label: '场景任务：这一次的输入（预设里没有这一块，接在最后）' });
    result.tokens += estimateTokens(opts.task.input);
  }
  return { ...result, preset, use, persona, request: buildChatRequest(result, preset, model), turnStats: { ...turnStats, last, summarized: history.length - sendable.length }, recall };
}

/** 发给模型的消息（去掉来源说明） */
export function toLLMMessages(p: ChatPrompt): LLMChatMessage[] {
  return p.messages.map(({ role, content, name }) => (name ? { role, content, name } : { role, content }));
}
