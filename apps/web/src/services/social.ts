import { buildSocialMessages, errorText, isAbortError, samplerRequest, socialCharacterFill, socialNowFill, socialPostInput } from '@app/ai';
import {
  getLocation, hubMomentId, MOMENT_USER, momentDueTimes, momentMemory, momentText, parseMomentDraft, parseMomentReaction, shiftDate, socialDayOf, socialDayText, socialPerDay, zonedDateKey,
  type Character, type Moment, type MomentImage, type Preset, type SocialContext, type SocialDay,
} from '@app/shared';
import { putAsset } from './assets';
import { memoryBlock, profileText } from './memoryBlocks';
import { describePhoto } from './photos';
import { MissingPresetError, personaOf } from './prompt';
import { services } from '@/services';
import { DEMO_REACTIONS, demoMoments } from '@/mock/moments';
import { useAiStore } from '@/stores/ai';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';
import { useEnvironmentStore } from '@/stores/environment';
import { useGalleryStore } from '@/stores/gallery';
import { useHubStore } from '@/stores/hub';
import { useLibraryStore } from '@/stores/library';
import { useMemoryStore } from '@/stores/memory';
import { usePersonaStore } from '@/stores/personas';
import { useRhythmStore } from '@/stores/rhythm';
import { useSocialStore } from '@/stores/social';
import { pick, sleep, uid } from '@/utils/id';

/**
 * 朋友圈要调模型的事（"社媒 · 朋友圈"的 API + "社媒"预设）：
 * - 让她发一条（云端每天在随机的时间发，这里是你在朋友圈页里点"让她发一条"时在手机上发）；
 * - 你发了朋友圈：看得到的角色各自点赞、评论；你在评论里跟她说话，她回你；
 * - 要配的图交给生图画（画好存进本机素材库）；你发的照片先交给识图看一遍，她们才知道照片里有什么；
 * - 每条朋友圈写进记忆：她自己发的、你发的她看得到的，各记成一条"事件"，互动多了改同一条。
 */

// —— 名字、文字 ——

/** 朋友圈里你用的人设：默认人设（朋友圈不属于哪一条聊天） */
export function socialPersona() {
  return usePersonaStore().defaultPersona;
}

/** 这个角色眼里你的名字：按和她那条聊天选的人设 */
function userNameFor(characterId: string): string {
  const chat = useChatStore().chatOfCharacter(characterId);
  return chat ? personaOf(chat).name : socialPersona().name;
}

/** id → 名字（MOMENT_USER 是你） */
export function momentNames(characterId?: string): (id: string) => string {
  const user = characterId ? userNameFor(characterId) : socialPersona().name;
  const chars = useCharacterStore();
  return (id) => (id === MOMENT_USER ? user : (chars.byId(id)?.name ?? '已删除的角色'));
}

/** 这个角色看得到的最近几条朋友圈，写成文字（进提示词）；except：这一条不算（正要回应的那条） */
export function feedText(characterId: string, n = 6, except?: string): string {
  const timeZone = useEnvironmentStore().settings.timezone;
  const names = momentNames(characterId);
  return useSocialStore()
    .visibleTo(characterId)
    .filter((m) => m.id !== except)
    .slice(-n)
    .map((m) => momentText(m, names, { timeZone, comments: 4 }))
    .join('\n');
}

/** 每次聊天都带着的"最近的朋友圈"（接在长期记忆后面）：最近三天、最多 4 条 */
export function recentMomentsBlock(character: Character): string {
  const since = Date.now() - 3 * 86_400_000;
  const timeZone = useEnvironmentStore().settings.timezone;
  const names = momentNames(character.id);
  const list = useSocialStore().visibleTo(character.id).filter((m) => m.createdAt >= since).slice(-4);
  if (!list.length) return '';
  return `最近的朋友圈（${character.name}发的、${names(MOMENT_USER)}发的；聊天时可以自然地提起，不用复述）：\n${list.map((m) => momentText(m, names, { timeZone, comments: 4 })).join('\n')}`;
}

// —— 发朋友圈要的输入 ——

/** 她今天的节律（地点换成名字）；没有节律（没建世界）时为空 */
function dayOf(characterId: string): SocialDay | null {
  const day = useRhythmStore().todayOf(characterId);
  return day ? socialDayOf(day, (id) => getLocation(id)?.name ?? id) : null;
}

/** 她醒着的时段：节律里今天第一件不是睡觉的事开始，到最后一件结束；没有节律按你的作息 */
function awakeOf(day: SocialDay | null): { from: string; to: string } {
  const env = useEnvironmentStore().settings;
  const up = (day?.schedule ?? []).filter((s) => !/睡|sleep/i.test(s.status) && s.from >= '04:00');
  if (!up.length) return { from: env.wakeTime, to: env.sleepTime };
  const from = up.reduce((a, s) => (s.from < a ? s.from : a), '23:59');
  // 过了半夜才结束的（to 比 from 小）算到 23:59
  const to = up.some((s) => s.to <= s.from) ? '23:59' : up.reduce((a, s) => (s.to > a ? s.to : a), '00:00');
  return { from, to };
}

/** 她记得的关于你的事：画像卡 + 关系 + 置顶的和最重要的记忆（不带"最近的朋友圈"，那一块单独给） */
function memoriesText(c: Character, userName: string): string {
  const timeZone = useEnvironmentStore().settings.timezone;
  const profile = profileText(c.id);
  const memory = memoryBlock(c, [], Date.now(), timeZone, { proactive: true, moments: false }).content;
  return [profile ? `${c.name}知道的${userName}：\n${profile}` : '', memory].filter(Boolean).join('\n\n');
}

/** 发一条朋友圈要的输入（按角色）：角色卡、今天的节律、记得的事、最近的聊天和朋友圈 */
function contextOf(c: Character, preset: Preset): SocialContext {
  const chat = useChatStore().chatOfCharacter(c.id);
  const userName = userNameFor(c.id);
  const day = dayOf(c.id);
  return {
    character: { id: c.id, name: c.name, pronoun: c.pronoun, card: c.card },
    userName,
    timezone: useEnvironmentStore().settings.timezone,
    settings: { enabled: true, perDay: socialPerDay(useSocialStore().characterSettings(c.id)) },
    awake: awakeOf(day),
    day,
    memories: memoriesText(c, userName),
    recent: chat ? useChatStore().recentLines(chat.id, 12).join('\n') : '',
    feed: feedText(c.id),
    preset,
    preview: useHubStore().config.preview,
  };
}

/** 上传云端的那份（按角色）；这个角色关了自动发朋友圈、没有社媒预设时为空 */
export function socialCloudContext(characterId: string): SocialContext | null {
  const c = useCharacterStore().byId(characterId);
  const social = useSocialStore();
  if (!c || !social.ready || !social.characterSettings(characterId).enabled) return null;
  const preset = useLibraryStore().presetForUse('social', c);
  return preset ? contextOf(c, preset) : null;
}

// —— 写进记忆 ——

/**
 * 把一条朋友圈记进这个角色的记忆（事件）：第一次写一条新的，之后互动多了改同一条。
 * 你在记忆本里删掉、归档过这一条就不再动它
 */
export function rememberMoment(momentId: string, characterId: string) {
  const mem = useMemoryStore();
  const m = useSocialStore().byId(momentId);
  if (!m || !mem.ready || !useCharacterStore().byId(characterId)) return;
  const content = momentMemory(m, characterId, momentNames(characterId), useEnvironmentStore().settings.timezone);
  const known = m.memoryIds?.[characterId];
  if (known) {
    const old = mem.memoryById(known);
    if (old && !old.deleted && old.status === 'active' && old.content !== content) mem.updateMemory(known, { content, vector: null });
    return;
  }
  const now = Date.now();
  const id = uid('mem');
  mem.addMemory({
    id, characterId, chatId: useChatStore().chatOfCharacter(characterId)?.id, type: 'event', content,
    // 你发的、有来有往的更值得记
    importance: m.authorId === MOMENT_USER ? 4 : 3,
    pinned: false, status: 'active', dueAt: null, sourceMessageIds: [], happenedAt: m.createdAt, vector: null, lastRecalledAt: null, recallCount: 0,
    createdAt: now, updatedAt: now,
  });
  m.memoryIds = { ...(m.memoryIds ?? {}), [characterId]: id };
}

// —— 配图 ——

/**
 * 画这条朋友圈的第 index 张图（她发的：模型写了画面，这里交给生图）。
 * auto：收到云端发的、她刚发完时自动画，守着"自动画"的规矩（NovelAI 只在不花点的设置下画）；user：你点的
 */
export async function drawMomentImage(momentId: string, index = 0, priority: 'user' | 'auto' = 'user'): Promise<void> {
  const social = useSocialStore();
  const key = `image:${momentId}:${index}`;
  const m = social.byId(momentId);
  const img = m?.images[index];
  if (!m || !img || img.assetKey || img.photo || social.busy[key]) return;
  const c = useCharacterStore().byId(m.authorId);
  if (!c) return;
  if (priority === 'auto') {
    if (!social.settings.autoImage) return;
    const check = useGalleryStore().autoCheck({ ignoreSwitch: true });
    if (!check.ok) {
      img.error = check.reason;
      return;
    }
  }
  social.busy[key] = true;
  delete img.error;
  try {
    const out = await services.image.illustrate(
      { characterId: c.id, caption: img.caption, use: 'image', place: m.location, recent: m.text ? [`${c.name}的朋友圈：${m.text}`] : undefined },
      { priority },
    );
    // await 之后按 id 重新取（期间这条可能被删、被替换）
    const now = social.byId(momentId)?.images[index];
    if (now) Object.assign(now, { assetKey: out.assetKey, ...(out.url ? { url: out.url } : {}) }, { error: undefined });
  } catch (e) {
    const now = social.byId(momentId)?.images[index];
    if (now && !isAbortError(e)) now.error = errorText(e);
  } finally {
    delete social.busy[key];
  }
}

// —— 她发一条 ——

export type SocialResult = { ok: true; moment: Moment } | { ok: false; reason: string };

/** 能不能调"社媒 · 朋友圈"；不能时说明原因 */
export function socialStatus(character?: Character): { ok: true } | { ok: false; reason: string } {
  const s = useAiStore().status('social');
  if (!s.live) return { ok: false, reason: `「社媒 · 朋友圈」的 API 还没接通：${s.reason}` };
  if (!useLibraryStore().presetForUse('social', character)) return { ok: false, reason: new MissingPresetError('社媒').message };
  return { ok: true };
}

/** 让她现在发一条朋友圈（在手机上生成）：按今天的节律、记得的事、最近的聊天和最近的朋友圈 */
export async function postMoment(characterId: string, opts: { /** 按排好的时间发的那一条：id 和云端的算法一样，两边不会各发一条 */ id?: string } = {}): Promise<SocialResult> {
  const social = useSocialStore();
  const c = useCharacterStore().byId(characterId);
  if (!c) return { ok: false, reason: '找不到这个角色' };
  const status = socialStatus(c);
  if (!status.ok) return status;
  const key = `post:${characterId}`;
  if (social.busy[key]) return { ok: false, reason: `${c.name}正在发` };
  const preset = useLibraryStore().presetForUse('social', c)!;
  // 关了"自动发朋友圈"的角色也可以手动让她发一条
  const context = contextOf(c, preset);
  social.busy[key] = true;
  delete social.failures[key];
  try {
    const now = Date.now();
    const { value, result } = await useAiStore().system.json(
      'social',
      { messages: buildSocialMessages(socialPostInput(context, now), preset), ...samplerRequest(preset.sampler) },
      parseMomentDraft,
    );
    const moment = social.add({
      id: opts.id ?? uid('moment'), authorId: c.id, text: value.text,
      images: value.image ? [{ caption: value.image, assetKey: null }] : [],
      ...(value.html ? { html: value.html, htmlTitle: value.htmlTitle || '单据' } : {}),
      ...(value.location ? { location: value.location } : {}),
      visibleTo: null, likes: [], comments: [], createdAt: now, updatedAt: now, source: 'device', model: result.model,
      // 排好的时间自己发的算没看过；你点的那条就在眼前
      ...(opts.id ? { unread: true } : {}),
    });
    rememberMoment(moment.id, c.id);
    if (moment.images.length) void drawMomentImage(moment.id, 0, 'auto');
    return { ok: true, moment };
  } catch (e) {
    const reason = errorText(e);
    social.failures[key] = reason;
    return { ok: false, reason };
  } finally {
    delete social.busy[key];
  }
}

/**
 * 云端没接通（或者 Worker 是旧版）时，App 开着也替她们发：和云端同一套随机时间（momentDueTimes），
 * 到点、还在 3 小时补发窗口里、这一条还没发过就发。云端接通后这里什么都不做，交给云端
 */
async function localTick() {
  const hub = useHubStore();
  const social = useSocialStore();
  if (!social.ready || (hub.connected && (hub.supportsSocial || !hub.status))) return;
  if (!useAiStore().isLive('social')) return;
  const now = Date.now();
  const timezone = useEnvironmentStore().settings.timezone;
  const today = zonedDateKey(now, timezone);
  for (const c of useCharacterStore().list) {
    const settings = social.characterSettings(c.id);
    if (!settings.enabled) continue;
    const awake = awakeOf(dayOf(c.id));
    for (const date of [shiftDate(today, -1), today]) {
      const due = momentDueTimes({ characterId: c.id, date, perDay: settings.perDay, awake, timezone });
      for (const [slot, at] of due.entries()) {
        const id = hubMomentId(c.id, date, slot);
        if (at > now || now - at >= 3 * 3_600_000 || social.byId(id) || social.removed.includes(id) || localTried.has(id)) continue;
        // 一条只试一次：失败了不在这里反复重试（朋友圈页里可以点"让她发一条"）
        localTried.add(id);
        await postMoment(c.id, { id });
      }
    }
  }
}
const localTried = new Set<string>();
let scheduleStarted = false;

export function startSocialSchedule() {
  if (scheduleStarted) return;
  scheduleStarted = true;
  // 第一次：放几条演示动态（只放演示角色还在的那几条），朋友圈不至于空着
  const social = useSocialStore();
  if (social.ready && !social.seeded) {
    social.seeded = true;
    for (const m of demoMoments()) if (useCharacterStore().byId(m.authorId) && !social.byId(m.id)) social.add(m);
  }
  // 等云端状态同步回来再看要不要自己发
  setTimeout(() => void localTick(), 30_000);
  setInterval(() => void localTick(), 5 * 60_000);
}

/** 云端发来的朋友圈：放进来、记进记忆、把要配的图画出来 */
export function receiveHubMoments(list: Moment[]): Moment[] {
  const added = useSocialStore().ingest(list);
  for (const m of added) {
    rememberMoment(m.id, m.authorId);
    if (m.images.some((i) => !i.assetKey && !i.photo)) void drawMomentImage(m.id, 0, 'auto');
  }
  return added;
}

// —— 她回应 ——

/**
 * 让这个角色回应一条朋友圈：
 * - new：你刚发的，她点赞、评论；
 * - reply：你在评论里跟她说了话（或者在她的朋友圈下评论），她回你。
 */
export async function reactToMoment(momentId: string, characterId: string, kind: 'new' | 'reply'): Promise<void> {
  const social = useSocialStore();
  const c = useCharacterStore().byId(characterId);
  const m = social.byId(momentId);
  if (!c || !m) return;
  const key = `react:${momentId}:${characterId}`;
  if (social.busy[key]) return;
  const status = socialStatus(c);
  if (!status.ok) {
    // 没接通：演示角色用占位台词回应（同别处的演示数据）；导入的角色不回应，朋友圈页顶上有一行提示
    const demo = DEMO_REACTIONS[characterId];
    if (!demo) return;
    social.busy[key] = true;
    await sleep(900 + Math.random() * 1500).catch(() => undefined);
    delete social.busy[key];
    if (!social.byId(momentId)) return;
    if (kind === 'new') social.setLike(momentId, characterId, true);
    social.comment(momentId, characterId, pick(kind === 'new' ? demo.comment : demo.reply), kind === 'reply' ? MOMENT_USER : undefined);
    rememberMoment(momentId, characterId);
    return;
  }
  const preset = useLibraryStore().presetForUse('social', c)!;
  const userName = userNameFor(characterId);
  const names = momentNames(characterId);
  const timeZone = useEnvironmentStore().settings.timezone;
  const chat = useChatStore().chatOfCharacter(characterId);
  const day = dayOf(characterId);
  const at = socialNowFill(Date.now(), timeZone);
  const mine = m.authorId === characterId;
  const lastUser = [...m.comments].reverse().find((x) => x.authorId === MOMENT_USER);
  const ask = kind === 'new'
    ? `这一次：${userName}刚发了这条朋友圈，${c.name}刷到了。决定点不点赞、要不要评论。`
    : `这一次：${userName}在${mine ? `${c.name}的这条朋友圈` : '这条朋友圈的评论区'}里说了「${lastUser?.text ?? ''}」，${c.name}回复这一句（like 写 false）。`;
  social.busy[key] = true;
  delete social.failures[key];
  try {
    const { value } = await useAiStore().system.json(
      'social',
      {
        messages: buildSocialMessages({
          task: 'react', characterName: c.name, userName, now: new Date(), timeZone,
          fills: {
            socialCharacter: socialCharacterFill({ id: c.id, name: c.name, pronoun: c.pronoun, card: c.card }, userName),
            socialLife: day ? socialDayText(day, at.minute) : '',
            socialNow: at.text,
            socialMemories: memoriesText(c, userName),
            socialRecent: chat ? `最近的聊天：\n${useChatStore().recentLines(chat.id, 8).join('\n')}` : '',
            socialFeed: feedText(characterId, 4, momentId) ? `之前的朋友圈：\n${feedText(characterId, 4, momentId)}` : '',
            socialPost: `这条朋友圈和下面的评论：\n${momentText(m, names, { timeZone, comments: 12 })}`,
            socialAsk: ask,
          },
        }, preset),
        ...samplerRequest(preset.sampler),
        maxTokens: Math.min(preset.sampler.maxTokens, 600),
      },
      parseMomentReaction,
    );
    if (!social.byId(momentId)) return;
    if (kind === 'new' && value.like) social.setLike(momentId, characterId, true);
    // 直接评论你的朋友圈不写"回复"；接你评论里的话才是回复你
    if (value.comment) social.comment(momentId, characterId, value.comment, kind === 'reply' ? MOMENT_USER : undefined);
    const now = social.byId(momentId);
    if (now) now.unread = now.unread || !!value.comment;
    rememberMoment(momentId, characterId);
  } catch (e) {
    if (!isAbortError(e)) social.failures[key] = errorText(e);
  } finally {
    delete social.busy[key];
  }
}

// —— 你发、你评论 ——

export interface UserMomentInput {
  text: string;
  /** 压缩好的照片 */
  photos: { bytes: Uint8Array<ArrayBuffer>; mime: string }[];
  /** 哪些角色看得到；null = 都看得到 */
  visibleTo: string[] | null;
  location?: string;
}

/** 这条朋友圈哪些角色看得到（还在的角色） */
export function audienceOf(m: Pick<Moment, 'authorId' | 'visibleTo'>): string[] {
  const chars = useCharacterStore().list.map((c) => c.id);
  if (m.authorId !== MOMENT_USER) return chars.includes(m.authorId) ? [m.authorId] : [];
  return m.visibleTo === null ? chars : m.visibleTo.filter((id) => chars.includes(id));
}

/**
 * 你发一条朋友圈：照片存进本机素材库 → 发出来 → 识图把照片看一遍（接通了的话）→ 看得到的角色各自点赞、评论。
 * 发出来就返回；识图和她们的回应在后面慢慢来
 */
export async function publishUserMoment(input: UserMomentInput): Promise<Moment> {
  const social = useSocialStore();
  const keys = await Promise.all(input.photos.map((p) => putAsset(p.bytes, p.mime)));
  const now = Date.now();
  const images: MomentImage[] = keys.map((assetKey) => ({ caption: '', assetKey, photo: true }));
  const moment = social.add({
    id: uid('moment'), authorId: MOMENT_USER, text: input.text.trim(), images,
    ...(input.location?.trim() ? { location: input.location.trim() } : {}),
    visibleTo: input.visibleTo, likes: [], comments: [], createdAt: now, updatedAt: now, source: 'user',
  });
  void afterUserMoment(moment.id);
  return moment;
}

async function afterUserMoment(momentId: string) {
  const social = useSocialStore();
  const m = social.byId(momentId);
  if (!m) return;
  const audience = audienceOf(m);
  // 照片先看一遍：她们才知道照片里有什么（识图没接通就只知道"发了一张照片"）
  if (useAiStore().isLive('vision')) {
    const looker = useCharacterStore().byId(audience[0]);
    await Promise.allSettled(m.images.map(async (img, i) => {
      if (!img.photo || !img.assetKey) return;
      const seen = (await describePhoto(img.assetKey, looker)).text;
      const now = social.byId(momentId)?.images[i];
      if (now) now.seen = seen.slice(0, 600);
    }));
  }
  for (const id of audience) rememberMoment(momentId, id);
  await Promise.allSettled(audience.map((id) => reactToMoment(momentId, id, 'new')));
}

/**
 * 你点评论：写进去，然后该回的那个角色回你——
 * 在她的朋友圈下：她回；在你自己的朋友圈下回复某个角色：那个角色回；直接评论自己的朋友圈：不触发谁
 */
export function userComment(momentId: string, text: string, replyTo?: string) {
  const social = useSocialStore();
  const m = social.byId(momentId);
  if (!m || !social.comment(momentId, MOMENT_USER, text, replyTo)) return;
  const target = m.authorId !== MOMENT_USER ? m.authorId : replyTo && replyTo !== MOMENT_USER ? replyTo : null;
  for (const id of audienceOf(m)) rememberMoment(momentId, id);
  if (target && audienceOf(m).includes(target)) void reactToMoment(momentId, target, 'reply');
}

/** 你给她的朋友圈点赞 / 取消 */
export function userLike(momentId: string) {
  const social = useSocialStore();
  const m = social.byId(momentId);
  if (!m) return;
  social.setLike(momentId, MOMENT_USER, !m.likes.includes(MOMENT_USER));
  for (const id of audienceOf(m)) rememberMoment(momentId, id);
}
