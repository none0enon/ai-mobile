<script setup lang="ts">
import { DATE_CHOICE_KINDS, isRainy, parseDateChoices, worldOf, type DateChoice, type DateChoiceKind, type MapLocation, type MessagePart, type ParsedReply } from '@app/shared';
import { showConfirmDialog, showImagePreview, showToast } from 'vant';
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import AssetImg from '@/components/common/AssetImg.vue';
import { SCENE_LOCATION } from '@/components/scene/location';
import SceneShell from '@/components/scene/SceneShell.vue';
import { assetUrl } from '@/services';
import { personaOf } from '@/services/prompt';
import { useAppStore } from '@/stores/app';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';
import { useGalleryStore, type GalleryItem } from '@/stores/gallery';
import { useRhythmStore } from '@/stores/rhythm';
import { useWeatherStore } from '@/stores/weather';
import { uid } from '@/utils/id';

/**
 * 约会（设计文档 §9.6）：从地图上点了地点就直接开始；没指定地点（比如从聊天进来）先从她小世界里能约会的地方选，她会按天气推荐。
 * 像视觉小说一样一段一段推进：她每段的话来自「陪伴 · 快速」+"约会"功能预设（开场 date-start、每一段 date-turn、结束 date-end），
 * 边生成边按行翻页（（旁白）和「台词」各一拍，按标签的位置换表情）；每段结尾四个选项：顺着、逆着、皮一下、暧昧，都不满意可以自己说。
 * 想约多久约多久，点"结束约会"她说最后一段。画图用"生图 · 约会"：到达时画一张（今天同一个地方画过的直接用），
 * 她写了 [cg:] 的心动时刻画一张（隔几段才画），结束时画一张留念，也可以自己点"拍一张"；画好的铺满整屏。
 * 结束（或者直接离开）时把"约会回忆"卡片发进聊天：走了几段、每种回法选了几次、她最后说的话、这次画的图。
 */
const app = useAppStore();
const chars = useCharacterStore();
const chat = useChatStore();
const gallery = useGalleryStore();
const rhythm = useRhythmStore();
const router = useRouter();
const her = computed(() => chars.byId(app.activeCharacterId) ?? chars.list[0]!);
const chatId = computed(() => chat.chatOfCharacter(her.value.id)?.id ?? '');
const userName = computed(() => personaOf(chat.chatById(chatId.value)).name);
const location = inject(SCENE_LOCATION, ref(null));

/** 她的世界里能约会的地方 */
const datePlaces = computed(() => worldOf(her.value.id).locations.filter((l) => l.activities.some((a) => a.sceneId === 'date')));
/** 地点卡片的颜色按背景来 */
const TONE: Record<string, string> = {
  cafe: '#d9a77a',
  aquarium: '#6fb6e8',
  amusement: '#f39cc0',
  cinema: '#e07a7a',
  seaside: '#7fc9d9',
  'night-market': '#f2a65e',
  gallery: '#c9b3e6',
  park: '#8fd1a0',
};
const toneOf = (l: MapLocation) => TONE[l.backdrop] ?? '#f5b8a6';

const fromMap = location.value?.activities.some((a) => a.sceneId === 'date') ? location.value : null;
const phase = ref<'pick' | 'date' | 'end'>(fromMap ? 'date' : 'pick');
/** 下没下雨：约会在她的世界里（去她那）看她那边的天气；带她出门在你这边的地方看你那边的 */
const weatherStore = useWeatherStore();
const herSky = computed(() => weatherStore.forCharacter(her.value));
/** 下雨推荐室内，天晴推荐室外（挑的都是她世界里的地方，看她那边的天气） */
const recommended = computed(() => datePlaces.value.find((l) => l.indoor === isRainy(herSky.value?.text)) ?? datePlaces.value[0]!);
const place = ref<MapLocation>(fromMap ?? recommended.value);
const sky = computed(() => (place.value.area === 'real' ? weatherStore.mine : herSky.value));
const raining = computed(() => isRainy(sky.value?.text));

// —— 四种回法 ——
const KIND: Record<DateChoiceKind, { icon: string; tone: string }> = {
  顺着: { icon: 'i-lucide-heart-handshake', tone: '#5fb98a' },
  逆着: { icon: 'i-lucide-shuffle', tone: '#6f9fe6' },
  皮一下: { icon: 'i-lucide-laugh', tone: '#ee9a4f' },
  暧昧: { icon: 'i-lucide-heart', tone: '#f0709a' },
};
const OWN = '自己说';

// —— 这一次约会 ——
const startedAt = ref(0);
/** 她已经说完的段数（开场算第 1 段） */
const turns = ref(0);
const picks = ref<Record<string, number>>({});
const titleOpen = ref(false);
const ending = ref(false);
const now = ref(Date.now());
const minutes = computed(() => (startedAt.value ? Math.max(1, Math.round((now.value - startedAt.value) / 60000)) : 0));

// —— 她这一段：边生成边按行翻页 ——
interface Beat {
  kind: 'narration' | 'line';
  text: string;
  /** 这一拍在正文里结束的位置（按位置换表情） */
  end: number;
}
const visible = ref('');
const tags = ref<ParsedReply['tags']>([]);
const busy = ref(false);
const done = ref(false);
const failed = ref('');
const notConnected = ref('');
const choices = ref<DateChoice[]>([]);
const beatIdx = ref(0);
const ownOpen = ref(false);
const own = ref('');
const ownInput = ref<HTMLInputElement | null>(null);
/** 上一次请求（失败了重试）：你说的话已经存进聊天的，重试时不再存 */
let lastAsk: { task: string; lines: string[]; userText?: string } | null = null;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function cleanLine(t: string): string {
  const s = t.replace(new RegExp(`^${escapeRe(her.value.name)}\\s*[:：]\\s*`), '');
  const m = /^「([^「」]*)」$/.exec(s) ?? /^“([^“”]*)”$/.exec(s) ?? /^"([^"]*)"$/.exec(s);
  return (m?.[1] ?? s).trim();
}
/** 一行一拍：整行在（）里的是旁白（流式时还没收尾的也算），其余是台词 */
const beats = computed<Beat[]>(() => {
  const out: Beat[] = [];
  let offset = 0;
  for (const raw of visible.value.split('\n')) {
    const end = offset + raw.length;
    offset = end + 1;
    const t = raw.trim();
    if (!t) continue;
    const narr = /^[（(]([^（()）]*)[）)]?$/.exec(t) ?? /^\*([^*]+)\*?$/.exec(t);
    if (narr?.[1]?.trim()) out.push({ kind: 'narration', text: narr[1].trim(), end });
    else out.push({ kind: 'line', text: cleanLine(t), end });
  }
  return out;
});
const beat = computed(() => beats.value[Math.min(beatIdx.value, beats.value.length - 1)] ?? null);
const atLast = computed(() => beatIdx.value >= beats.value.length - 1);
/** 正在生成、而且你已经看到最新这一拍了 */
const streamingHere = computed(() => busy.value && atLast.value && beats.value.length > 0);
const showChoices = computed(() => done.value && atLast.value && !ending.value && !failed.value);
const showFinale = computed(() => ending.value && !busy.value && atLast.value);
const sortedChoices = computed(() => [...choices.value].sort((a, b) => rank(a.kind) - rank(b.kind)));
const rank = (k: DateChoiceKind | null) => (k ? DATE_CHOICE_KINDS.indexOf(k) : DATE_CHOICE_KINDS.length);

function segments(text: string) {
  return text
    .split(/(（[^）]*）|\([^)]*\)|\*[^*]+\*)/)
    .filter(Boolean)
    .map((s) => ({ text: s, action: /^（|^\(|^\*/.test(s) }));
}

function advance() {
  if (!atLast.value) beatIdx.value += 1;
}
function skipToLast() {
  beatIdx.value = Math.max(0, beats.value.length - 1);
}

/** 翻到哪一拍就换成那一拍的表情（这一拍之前最后一个 [expr:]；前面还没有时是这一段开始前的表情） */
let baseExpr = 'smile';
watch([beatIdx, () => beats.value.length, done], () => {
  const b = beat.value;
  if (!b) return;
  const e = [...tags.value].reverse().find((t) => t.tag.kind === 'expr' && t.at <= b.end);
  chars.setExpression(her.value.id, e && 'value' in e.tag ? e.tag.value : baseExpr);
});

/** 这一次的场景任务里都带的：在哪、怎么在一起、天气、第几段、这一段能不能留图 */
const CG_GAP = 3;
let lastCgTurn = -CG_GAP;
function contextLines(): string[] {
  const p = place.value;
  const how = chat.chatOfCharacter(her.value.id)?.togetherMode;
  const w = sky.value;
  const cgOk = gallery.autoCheck().ok && turns.value + 1 - lastCgTurn >= CG_GAP;
  return [
    `约会地点：${p.name}（${p.indoor ? '室内' : '室外'}${p.blurb ? `；${p.blurb}` : ''}）`,
    how === 'bring' ? `${userName.value}带${her.value.name}来到${userName.value}这边的${p.name}` : `${userName.value}去${her.value.name}那边，两个人一起来到${p.name}`,
    w ? `现在的天气：${w.text}，${Math.round(w.tempC)}°C${raining.value && !p.indoor ? '（在室外，要躲雨）' : ''}` : '',
    `这是第 ${turns.value + 1} 段${startedAt.value ? `（约会开始了 ${minutes.value} 分钟）` : ''}`,
    cgOk ? '这一段可以用 [cg:]（只在真正心动的时刻）' : '这一段不要用 [cg:]',
  ];
}

async function ask(task: string, lines: string[], userText?: string): Promise<{ cg?: string } | null> {
  if (!chatId.value) return null;
  lastAsk = { task, lines, userText };
  baseExpr = chars.expression[her.value.id] ?? 'smile';
  visible.value = '';
  tags.value = [];
  choices.value = [];
  beatIdx.value = 0;
  done.value = false;
  failed.value = '';
  ownOpen.value = false;
  busy.value = true;
  const r = await chat.sceneReply(chatId.value, {
    task,
    input: lines.filter(Boolean).join('\n'),
    userText,
    cue: ending.value ? '结束约会' : `第 ${turns.value + 1} 段`,
    sceneArt: true,
    onParsed: (p) => {
      visible.value = p.visible;
      tags.value = p.tags;
    },
  });
  busy.value = false;
  // 你说的话已经存进聊天了：重试时只重新让她回
  if (lastAsk) lastAsk.userText = undefined;
  if (!r.ok) {
    if (r.notConnected) notConnected.value = r.reason;
    failed.value = r.reason;
    return null;
  }
  notConnected.value = '';
  if (!visible.value.trim()) visible.value = r.message.text;
  const choice = [...tags.value].reverse().find((t) => t.tag.kind === 'choice')?.tag;
  choices.value = parseDateChoices(choice?.kind === 'choice' ? choice.options : (r.message.meta.choices ?? []));
  // 带"顺着："前缀的选项只在这里用；聊天里不再显示成快捷回复
  r.message.meta.choices = undefined;
  done.value = true;
  turns.value += 1;
  const cg = tags.value.find((t) => t.tag.kind === 'cg')?.tag;
  return { cg: cg && 'value' in cg ? cg.value : undefined };
}

function retry() {
  if (!lastAsk || busy.value) return;
  const { task, lines, userText } = lastAsk;
  void (task === 'date-end' ? ask(task, lines, userText).then(afterFarewell) : ask(task, lines, userText).then(afterTurn));
}

/** 她说完一段：写了 [cg:] 而且隔得够久就画这一刻 */
function afterTurn(r: { cg?: string } | null) {
  if (!r?.cg || turns.value - lastCgTurn < CG_GAP) return;
  lastCgTurn = turns.value;
  void drawMoment('highlight', 'auto', `${r.cg}；在${place.value.name}约会`);
}

// —— 开始：选地点或者从地图来 ——
function start(p: MapLocation) {
  // 先进场（换地点时上一次约会在这里收尾、发回忆卡片），再清空这一次的
  chat.enterScene(her.value.id, p.id, 'date');
  chat.setLeaveSummary(her.value.id, leaveNote);
  place.value = p;
  phase.value = 'date';
  startedAt.value = Date.now();
  now.value = Date.now();
  turns.value = 0;
  picks.value = {};
  ending.value = false;
  // 到达时已经画了一张：心动时刻的图从第 3 段起才画
  lastCgTurn = 0;
  cardRef = null;
  art.value = null;
  sessionArt.value = [];
  artIssue.value = null;
  autoNoted = false;
  logOpen.value = false;
  titleOpen.value = true;
  chars.setExpression(her.value.id, 'smile');
  ensureArt();
  void ask('date-start', [...contextLines(), '你们刚到这里，约会开始了']).then(afterTurn);
}

function closeTitle() {
  titleOpen.value = false;
}

// —— 你的回法：四个选项之一，或者自己说 ——
async function pick(c: DateChoice) {
  if (!showChoices.value) return;
  const kind = c.kind ?? OWN;
  picks.value = { ...picks.value, [kind]: (picks.value[kind] ?? 0) + 1 };
  const how = c.kind ? `${userName.value}选了「${c.kind}」：${c.text}` : `${userName.value}选了：${c.text}`;
  const r = await ask('date-turn', [...contextLines(), how], c.text);
  afterTurn(r);
}
async function toggleOwn() {
  ownOpen.value = !ownOpen.value;
  if (!ownOpen.value) return;
  await nextTick();
  ownInput.value?.focus();
}
async function sendOwn() {
  const text = own.value.trim();
  if (!text || !showChoices.value) return;
  own.value = '';
  picks.value = { ...picks.value, [OWN]: (picks.value[OWN] ?? 0) + 1 };
  const r = await ask('date-turn', [...contextLines(), `${userName.value}没用你给的选项，自己说：${text}`], text);
  afterTurn(r);
}

// —— 结束约会：她说最后一段，画一张留念，回忆卡片发进聊天 ——
async function finish() {
  if (ending.value) return;
  if (!turns.value) {
    phase.value = 'pick';
    return;
  }
  try {
    await showConfirmDialog({ title: '今天的约会就到这里？', message: `${her.value.pronoun}会说最后一段，再拍一张留念`, confirmButtonText: '结束约会', cancelButtonText: '再逛逛' });
  } catch {
    return;
  }
  if (chatId.value && chat.streams[chatId.value]) chat.stop(chatId.value);
  ending.value = true;
  void waitIdle().then(() => drawMoment('keepsake', 'auto', keepsakeCaption()));
  const r = await ask('date-end', [
    ...contextLines().slice(0, 3),
    `${userName.value}说今天的约会就到这里`,
    `一共走了 ${turns.value} 段，约 ${minutes.value} 分钟`,
    sessionArt.value.length ? `今天留下的画面：${sessionArt.value.map((i) => i.title).join('、')}` : '',
  ]);
  afterFarewell(r);
}
/** 她说完最后一段：发回忆卡片（没说出来时等你点"看回忆"或者离开时再发） */
function afterFarewell(r: { cg?: string } | null) {
  if (!r) return;
  turns.value -= 1; // 最后一段不算"走了几段"
  postMemory(farewellLine());
}
function farewellLine(): string | undefined {
  const line = [...beats.value].reverse().find((b) => b.kind === 'line')?.text;
  return line ? (line.length > 60 ? `${line.slice(0, 60)}…` : line) : undefined;
}
function keepsakeCaption(): string {
  const mood = Object.entries(picks.value)
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k)[0];
  return `约会快结束了，${her.value.name}在${place.value.name}和${userName.value}留一张纪念照${raining.value && !place.value.indoor ? '，外面在下雨' : ''}${mood ? `；今天${userName.value}总是${mood === OWN ? '自己找话说' : mood}` : ''}`;
}
function showMemory() {
  postMemory(done.value ? farewellLine() : undefined);
  phase.value = 'end';
  chars.setExpression(her.value.id, 'smile');
}
function again() {
  phase.value = 'pick';
  ending.value = false;
  visible.value = '';
  choices.value = [];
  failed.value = '';
}

/** 约会回忆卡片：结束时发；直接离开时（离开页面就是结束）由 leaveNote 补发 */
let cardRef: { chatId: string; messageId: string } | null = null;
function whenText(): string {
  const d = new Date(startedAt.value || Date.now());
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function cardImage(i: GalleryItem) {
  return { assetKey: i.assetKey, ...(i.url ? { url: i.url } : {}), title: i.title, moment: i.moment };
}
function postMemory(farewell?: string) {
  if (!chatId.value || cardRef || !turns.value) return;
  now.value = Date.now();
  const part: MessagePart = {
    type: 'date',
    logId: uid('date'),
    place: place.value.name,
    when: whenText(),
    status: 'memory',
    turns: turns.value,
    minutes: minutes.value,
    ...(Object.keys(picks.value).length ? { picks: { ...picks.value } } : {}),
    ...(farewell ? { farewell } : {}),
    ...(sessionArt.value.length ? { images: sessionArt.value.map(cardImage) } : {}),
  };
  const msg = chat.postCard(chatId.value, 'user', part);
  cardRef = { chatId: chatId.value, messageId: msg.id };
}
function leaveNote(): string | undefined {
  if (!turns.value) return undefined;
  postMemory();
  return `约会走了 ${turns.value} 段${sessionArt.value.length ? `，留了 ${sessionArt.value.length} 张图` : ''}`;
}

// —— 画面："生图 · 约会"，竖图铺满整屏 ——
const MOMENT_TEXT: Record<string, string> = { arrive: '到达', highlight: '关键时刻', keepsake: '留念' };
const art = ref<GalleryItem | null>(null);
const sessionArt = ref<GalleryItem[]>([]);
const artIssue = ref<{ text: string; settings: boolean } | null>(null);
const drawingNow = computed(() => gallery.isDrawing(her.value.id, 'date'));
const drawingText = computed(() => {
  const d = drawingNow.value;
  if (!d) return null;
  const what = MOMENT_TEXT[d.moment] ?? '画面';
  return d.stage === 'queued' ? `${what}：排队等前一张画完` : d.stage === 'prompt' ? `${what}：正在写 tags` : `${what}：正在画`;
});
let autoNoted = false;

async function drawMoment(moment: 'arrive' | 'highlight' | 'keepsake', priority: 'user' | 'auto', caption: string): Promise<void> {
  if (priority === 'auto') {
    const chk = gallery.autoCheck();
    if (!chk.ok) {
      if (!autoNoted && chk.reason !== '自动画关着') artIssue.value = { text: `画面先用立绘：${chk.reason}`, settings: /没接通|API 设置/.test(chk.reason) };
      autoNoted = true;
      return;
    }
  }
  const r = await gallery.draw({
    characterId: her.value.id,
    sceneId: 'date',
    moment,
    caption,
    priority,
    locationId: place.value.id,
    expression: chars.expression[her.value.id],
    recent: chatId.value ? chat.recentLines(chatId.value, 6) : [],
    size: 'portrait',
  });
  if (!r.ok) {
    if (!r.busy) artIssue.value = { text: `没画出来：${r.reason}`, settings: /没接通/.test(r.reason) };
    return;
  }
  artIssue.value = null;
  art.value = r.item;
  sessionArt.value.push(r.item);
  // 卡片已经发了（留念画得慢）：补进卡片
  if (cardRef) {
    const { chatId: cid, messageId } = cardRef;
    const part = chat.list(cid).find((m) => m.id === messageId)?.parts.find((p) => p.type === 'date');
    if (part?.type === 'date') part.images = [...(part.images ?? []), cardImage(r.item)];
  }
}
/** 到达：今天在同一个地方、穿同一身画过的直接用，没有就画一张 */
function ensureArt() {
  const outfit = rhythm.outfitFor(her.value.id, 'date')?.name ?? null;
  const found = gallery.find(her.value.id, 'date', { moment: 'arrive', today: true, locationId: place.value.id, outfit, size: 'portrait' })[0];
  if (found) {
    art.value = found;
    return;
  }
  void drawMoment('arrive', 'auto', `${her.value.name}和${userName.value}刚到${place.value.name}约会${raining.value ? (place.value.indoor ? '，外面在下雨' : '，在下雨') : ''}${place.value.blurb ? `；${place.value.blurb}` : ''}`);
}
function snap() {
  if (drawingNow.value) {
    showToast('正在画上一张，等一下');
    return;
  }
  const said = beats.value
    .slice(0, beatIdx.value + 1)
    .slice(-3)
    .map((b) => (b.kind === 'narration' ? `（${b.text}）` : `${her.value.name}：${b.text}`))
    .join(' ');
  void drawMoment('highlight', 'user', `在${place.value.name}约会，画此刻的画面${said ? `：${said}` : ''}`);
}
function waitIdle(): Promise<void> {
  if (!drawingNow.value) return Promise.resolve();
  return new Promise((resolve) => {
    const stop = watch(drawingNow, (d) => {
      if (d) return;
      stop();
      resolve();
    });
  });
}
function toggleAutoDraw() {
  gallery.autoDraw = !gallery.autoDraw;
  showToast(gallery.autoDraw ? '自动画图开了：到达、心动时刻、结束时各画一张' : '自动画图关了：点相机才画');
  if (gallery.autoDraw && phase.value === 'date' && !art.value && !drawingNow.value) {
    autoNoted = false;
    artIssue.value = null;
    ensureArt();
  }
}
async function urlOf(item: GalleryItem): Promise<string | null> {
  return item.assetKey ? await assetUrl(item.assetKey) : (item.url ?? null);
}
async function preview(start: number) {
  const list = phase.value === 'end' ? sessionArt.value : art.value ? [art.value] : [];
  const urls = (await Promise.all(list.map(urlOf))).filter((u): u is string => !!u);
  if (urls.length) showImagePreview({ images: urls, startPosition: Math.min(start, urls.length - 1), closeable: true });
  else showToast('本机找不到这张图了');
}
async function save(item: GalleryItem) {
  const url = await urlOf(item);
  if (!url) {
    showToast('本机找不到这张图了');
    return;
  }
  const a = document.createElement('a');
  a.href = url;
  a.download = `约会_${place.value.name}_${item.title || MOMENT_TEXT[item.moment] || ''}_${new Date(item.at).toISOString().slice(0, 10)}.png`;
  a.target = '_blank';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
const memoryArt = computed(() => sessionArt.value.find((i) => i.moment === 'keepsake') ?? sessionArt.value.at(-1) ?? art.value);

// —— 这一次说过的话 ——
const logOpen = ref(false);
const logEl = ref<HTMLElement | null>(null);
const transcript = computed(() =>
  chat
    .list(chatId.value)
    .filter((m) => m.createdAt >= startedAt.value && (m.role === 'user' || m.role === 'assistant') && m.text.trim())
    .slice(-60),
);
watch([logOpen, () => transcript.value.length], async () => {
  if (!logOpen.value) return;
  await nextTick();
  if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight;
});

const pickText = computed(() =>
  Object.entries(picks.value)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k} ${n}`)
    .join(' · '),
);
const weatherText = computed(() => (sky.value ? `${sky.value.text} ${Math.round(sky.value.tempC)}°C` : ''));
const clockText = computed(() => {
  const d = new Date(now.value);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
});

let ticker: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  ticker = setInterval(() => (now.value = Date.now()), 30_000);
  if (fromMap) start(fromMap);
});
onBeforeUnmount(() => {
  clearInterval(ticker);
  chat.setLeaveSummary(her.value.id, null);
});
</script>

<template>
  <!-- 选地点 -->
  <SceneShell
    v-if="phase === 'pick'"
    scene-id="date"
    :backdrop="place.backdrop"
    :rain="raining && !place.indoor"
    outfit="date"
    expression="smile"
    :line="`${raining ? '下雨了…' : '天气真好！'}去${recommended.name}好不好？`"
    :layout="{ left: 78, bottom: 56, height: 32 }"
  >
    <div class="text-[15px] font-600 mb-2.5">今天去哪儿约会？</div>
    <div class="grid grid-cols-4 gap-2">
      <button v-for="p in datePlaces" :key="p.id" class="place press" :class="{ on: place.id === p.id }" :style="{ '--tone': toneOf(p) }" @click="place = p">
        <span class="place-icon"><span :class="p.icon" /></span>
        <span class="text-[12.5px]">{{ p.name }}</span>
        <span v-if="p.id === recommended.id" class="rec">{{ her.pronoun }}想去</span>
      </button>
    </div>
    <p class="text-[12.5px] text-ink-3 mt-2.5">{{ place.blurb }} · {{ place.indoor ? '室内' : '室外' }}{{ raining && !place.indoor ? '（在下雨哦）' : '' }}</p>
    <van-button type="primary" round block class="!mt-3" data-testid="date-start" @click="start(place)">出发去{{ place.name }}</van-button>
  </SceneShell>

  <!-- 约会中 / 约会回忆 -->
  <SceneShell
    v-else
    scene-id="date"
    bare
    hide-mode
    :title="phase === 'end' ? '约会回忆' : `约会 · ${place.name}`"
    :backdrop="place.backdrop"
    :rain="raining && !place.indoor"
    outfit="date"
    :layout="{ left: 50, bottom: 22, height: 66 }"
    :hide-figure="!!art"
    :drawing="drawingText"
  >
    <template #actions>
      <button
        type="button"
        class="pill-btn"
        :class="{ off: !gallery.autoDraw }"
        :aria-pressed="gallery.autoDraw"
        :aria-label="gallery.autoDraw ? '自动画图：开（点一下关掉）' : '自动画图：关（点一下打开）'"
        @click="toggleAutoDraw"
      >
        <span :class="gallery.autoDraw ? 'i-lucide-image' : 'i-lucide-image-off'" />
      </button>
      <button v-if="phase === 'date'" type="button" class="pill-btn" :disabled="drawingNow?.priority === 'user'" aria-label="拍一张：画此刻的画面" data-testid="date-snap" @click="snap">
        <span :class="drawingNow?.priority === 'user' ? 'i-lucide-loader-circle spin' : 'i-lucide-camera'" />
      </button>
    </template>

    <template #overlay>
      <div class="date" data-testid="date-scene">
        <Transition name="art-swap">
          <button v-if="art" :key="art.id" type="button" class="full-art" :aria-label="`看大图：${art.title}`" @click="preview(0)">
            <AssetImg :asset-key="art.assetKey" :url="art.url" :alt="art.title" />
          </button>
        </Transition>
        <div class="shade top" aria-hidden="true" />
        <div class="shade bottom" aria-hidden="true" />

        <!-- 左上：在哪、几点、天气，和没接通之类的提示 -->
        <div class="info-col">
          <div class="info-card">
            <span class="i-lucide-map-pin shrink-0 text-accent-ink" />
            <span class="truncate">{{ place.name }}</span>
            <span class="dot" />
            <span class="shrink-0">{{ clockText }}</span>
            <template v-if="weatherText"><span class="dot" /><span class="shrink-0">{{ weatherText }}</span></template>
            <template v-if="turns"><span class="dot" /><span class="shrink-0">第 {{ turns }} 段</span></template>
          </div>
          <div v-if="notConnected" class="mini-notice" data-testid="date-not-connected">
            <span class="i-lucide-plug-zap shrink-0" /><span class="flex-1 min-w-0">{{ notConnected }}</span>
            <button type="button" class="text-accent-ink shrink-0" @click="router.push('/me/api?feature=companion')">去设置</button>
          </div>
          <div v-if="artIssue" class="mini-notice" data-testid="date-art-issue">
            <span class="i-lucide-image-off shrink-0" /><span class="flex-1 min-w-0">{{ artIssue.text }}</span>
            <button v-if="artIssue.settings" type="button" class="text-accent-ink shrink-0" @click="router.push('/me/api?feature=image')">去设置</button>
          </div>
        </div>

        <!-- 开场：标题卡（她在后台已经开始说第一段了） -->
        <Transition name="fade">
          <button v-if="phase === 'date' && titleOpen" type="button" class="title-card" data-testid="date-title" @click="closeTitle">
            <span class="title-kicker">Date</span>
            <span class="title-main">{{ place.name }}</span>
            <span class="title-rows">
              <span><span class="title-label">和</span>{{ her.name }}</span>
              <span><span class="title-label">时间</span>{{ whenText() }}</span>
              <span v-if="weatherText"><span class="title-label">天气</span>{{ weatherText }}</span>
            </span>
            <span class="title-tap">点一下开始</span>
          </button>
        </Transition>

        <!-- 这一次说过的话 -->
        <Transition name="fade">
          <div v-if="logOpen" ref="logEl" class="log" role="log" aria-label="这次约会说过的话">
            <div class="log-head">
              <span>这次约会说过的话</span>
              <button type="button" class="text-ink-3" aria-label="收起" @click="logOpen = false"><span class="i-lucide-x" /></button>
            </div>
            <p v-if="!transcript.length" class="text-[12.5px] text-ink-3 m-0">还没有说话</p>
            <div v-for="m in transcript" :key="m.id" class="log-row" :class="m.role === 'user' ? 'me' : 'her'">
              <span class="who">{{ m.role === 'user' ? userName : her.name }}<template v-if="m.meta.cue"> · {{ m.meta.cue }}</template></span>
              <span class="what">{{ m.text }}</span>
            </div>
          </div>
        </Transition>

        <!-- 约会中：选项 + 对话框 -->
        <div v-if="phase === 'date' && !titleOpen && !logOpen" class="vn">
          <div v-if="showChoices" class="choices" data-testid="date-choices">
            <template v-if="!ownOpen">
              <button
                v-for="c in sortedChoices"
                :key="`${c.kind}:${c.text}`"
                type="button"
                class="choice press"
                :style="{ '--tone': c.kind ? KIND[c.kind].tone : 'var(--accent)' }"
                @click="pick(c)"
              >
                <span class="kind"><span :class="c.kind ? KIND[c.kind].icon : 'i-lucide-message-circle'" />{{ c.kind ?? '回她' }}</span>
                <span class="choice-text">{{ c.text }}</span>
              </button>
              <p v-if="!choices.length" class="no-choice">{{ her.pronoun }}这段没给选项，自己说一句吧</p>
            </template>
            <form v-else class="own" @submit.prevent="sendOwn">
              <input ref="ownInput" v-model="own" class="own-input" maxlength="200" placeholder="都不想选？自己说…" enterkeyhint="send" aria-label="自己说" />
              <button type="submit" class="own-send" :disabled="!own.trim()" aria-label="说出去"><span class="i-lucide-send-horizontal" /></button>
            </form>
            <div class="row">
              <button type="button" class="row-btn" :class="{ on: ownOpen || !choices.length }" data-testid="date-own" @click="toggleOwn">
                <span :class="ownOpen ? 'i-lucide-list' : 'i-lucide-pencil-line'" />{{ ownOpen ? '还是选一个' : '自己说' }}
              </button>
              <button type="button" class="row-btn" @click="logOpen = true"><span class="i-lucide-scroll-text" />记录</button>
              <span class="flex-1" />
              <button type="button" class="row-btn end" data-testid="date-finish" @click="finish"><span class="i-lucide-flag" />结束约会</button>
            </div>
          </div>

          <div v-else-if="showFinale" class="choices">
            <button type="button" class="choice finale press" data-testid="date-memory" @click="showMemory">
              <span class="kind"><span class="i-lucide-heart-handshake" />回忆</span>
              <span class="choice-text">看看今天的约会回忆</span>
            </button>
          </div>

          <div v-else-if="failed && !busy" class="choices">
            <div class="row">
              <button type="button" class="row-btn on" @click="retry"><span class="i-lucide-rotate-ccw" />重试</button>
              <button type="button" class="row-btn" @click="logOpen = true"><span class="i-lucide-scroll-text" />记录</button>
              <span class="flex-1" />
              <button v-if="ending" type="button" class="row-btn end" @click="showMemory"><span class="i-lucide-heart-handshake" />看回忆</button>
              <button v-else type="button" class="row-btn end" @click="finish"><span class="i-lucide-flag" />{{ turns ? '结束约会' : '换个地方' }}</button>
            </div>
          </div>

          <div class="box" :class="beat?.kind ?? 'line'" role="button" tabindex="0" :aria-label="atLast ? '对话' : '下一句'" data-testid="date-box" @click="advance" @keydown.enter.prevent="advance" @keydown.space.prevent="advance">
            <span v-if="!beat || beat.kind === 'line'" class="name"><span class="i-lucide-heart text-[11px]" />{{ her.name }}</span>
            <p v-if="failed && !busy" class="text error">没说出来：{{ failed }}</p>
            <p v-else-if="!beat" class="text">
              <span class="inline-flex gap-1 text-accent-ink"><span class="typing-dot" /><span class="typing-dot" /><span class="typing-dot" /></span>
            </p>
            <p v-else class="text" :class="{ 'stream-caret': streamingHere }">
              <template v-for="(s, i) in segments(beat.text)" :key="i">
                <span :class="{ action: s.action && beat.kind === 'line' }">{{ s.text }}</span>
              </template>
            </p>
            <span v-if="!atLast" class="next" aria-hidden="true"><span class="i-lucide-chevron-down" /></span>
            <button v-if="beats.length - beatIdx > 2" type="button" class="skip" aria-label="跳到最后一句" @click.stop="skipToLast"><span class="i-lucide-chevrons-right" /></button>
          </div>
        </div>

        <!-- 约会回忆 -->
        <section v-if="phase === 'end'" class="memory" data-testid="date-memory-panel">
          <div class="text-[17px] font-700">{{ place.name }}的约会</div>
          <div class="text-[12.5px] text-ink-3 mt-0.5">{{ whenText() }}<template v-if="turns"> · 走了 {{ turns }} 段</template> · {{ minutes }} 分钟 · 已存进聊天</div>
          <div v-if="pickText" class="text-[12.5px] text-ink-2 mt-1.5">你的回法：{{ pickText }}</div>
          <p v-if="farewellLine()" class="farewell">「{{ farewellLine() }}」</p>
          <div v-if="sessionArt.length" class="shots">
            <button v-for="(img, i) in sessionArt" :key="img.id" type="button" class="shot" :class="{ on: memoryArt?.id === img.id }" :aria-label="`看大图：${img.title}`" @click="preview(i)">
              <AssetImg :asset-key="img.assetKey" :url="img.url" :alt="img.title" />
            </button>
          </div>
          <p v-else-if="drawingText" class="text-[12.5px] text-ink-3 mt-2">{{ drawingText }}</p>
          <div class="flex gap-2.5 mt-3.5">
            <van-button v-if="memoryArt" round size="small" icon="down" @click="save(memoryArt)">存图</van-button>
            <van-button round block size="small" @click="again">再约一次</van-button>
            <van-button type="primary" round block size="small" @click="router.push(`/chat/${chatId}`)">回聊天</van-button>
          </div>
        </section>
      </div>
    </template>
  </SceneShell>
</template>

<style scoped>
.place {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 10px 0 8px;
  border-radius: 14px;
  background: var(--panel);
  color: var(--ink-2);
}
.place.on {
  outline: 1.5px solid var(--tone);
  color: var(--ink);
}
.place-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--tone) 22%, transparent);
  color: var(--tone);
  font-size: 18px;
}
.rec {
  position: absolute;
  top: -6px;
  right: -2px;
  padding: 0 5px;
  border-radius: 6px;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 10px;
  line-height: 16px;
}

.date {
  position: absolute;
  inset: 0;
  overflow: hidden;
}
.full-art {
  position: absolute;
  inset: 0;
  display: block;
  padding: 0;
  border: 0;
  background: #000;
  cursor: zoom-in;
  overflow: hidden;
}
.full-art :deep(.asset-img) {
  object-position: 50% 22%;
  transform-origin: 50% 30%;
  animation: drift 40s ease-in-out infinite alternate;
}
@keyframes drift {
  to {
    transform: scale(1.06);
  }
}
.art-swap-enter-active,
.art-swap-leave-active {
  transition: opacity 1s ease;
}
.art-swap-enter-from,
.art-swap-leave-to {
  opacity: 0;
}
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.3s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
.shade {
  position: absolute;
  left: 0;
  right: 0;
  pointer-events: none;
}
.shade.top {
  top: 0;
  height: 150px;
  background: linear-gradient(to bottom, rgba(0, 0, 0, 0.3), transparent);
}
.shade.bottom {
  bottom: 0;
  height: 280px;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.4), transparent);
}

.info-col {
  position: absolute;
  z-index: 9;
  top: calc(var(--safe-top) + 58px);
  left: 12px;
  right: 12px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
}
.info-card {
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 5px 11px;
  border-radius: 99px;
  background: var(--veil);
  border: 1px solid var(--glass-line);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  font-size: 12px;
  color: var(--ink-2);
}
.info-card .dot {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.5;
  flex-shrink: 0;
}
.mini-notice {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 10px;
  border-radius: 12px;
  background: var(--glass);
  border: 1px solid var(--glass-line);
  color: var(--ink-2);
  font-size: 12px;
  line-height: 1.4;
}

/* —— 开场标题卡 —— */
.title-card {
  position: absolute;
  z-index: 12;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 30px;
  border: 0;
  background: rgba(0, 0, 0, 0.62);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  color: #fff;
  text-align: center;
}
.title-kicker {
  font-size: 11px;
  letter-spacing: 4px;
  text-transform: uppercase;
  opacity: 0.6;
}
.title-main {
  padding: 6px 26px 12px;
  border-bottom: 2px solid rgba(255, 255, 255, 0.8);
  font-size: 26px;
  font-weight: 600;
  letter-spacing: 3px;
}
.title-rows {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 16px;
  font-size: 14px;
  opacity: 0.9;
}
.title-label {
  display: inline-block;
  margin-right: 8px;
  font-size: 11px;
  letter-spacing: 2px;
  opacity: 0.6;
}
.title-tap {
  margin-top: 26px;
  font-size: 12px;
  letter-spacing: 2px;
  opacity: 0.55;
  animation: breathe 2.4s ease-in-out infinite;
}
@keyframes breathe {
  50% {
    opacity: 0.25;
  }
}

/* —— 对话框和选项 —— */
.vn {
  position: absolute;
  z-index: 10;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 0 12px calc(var(--safe-bottom) + 12px);
}
.choices {
  display: flex;
  flex-direction: column;
  gap: 7px;
  margin-bottom: 10px;
}
.choice {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 12px;
  border-radius: 16px;
  background: var(--glass-strong);
  border: 1px solid color-mix(in srgb, var(--tone) 45%, var(--glass-line));
  color: var(--ink);
  text-align: left;
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  animation: rise 0.28s var(--ease) both;
}
.choice:nth-child(2) {
  animation-delay: 40ms;
}
.choice:nth-child(3) {
  animation-delay: 80ms;
}
.choice:nth-child(4) {
  animation-delay: 120ms;
}
.choice.finale {
  --tone: var(--accent);
  justify-content: center;
}
.kind {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  gap: 4px;
  min-width: 64px;
  padding: 3px 8px;
  border-radius: 99px;
  background: color-mix(in srgb, var(--tone) 18%, transparent);
  color: var(--tone);
  font-size: 12px;
  font-weight: 600;
}
.choice-text {
  flex: 1;
  min-width: 0;
  font-size: 14.5px;
  line-height: 1.45;
}
.no-choice {
  margin: 0;
  padding: 8px 12px;
  border-radius: 14px;
  background: var(--glass);
  color: var(--ink-2);
  font-size: 13px;
  text-align: center;
}
.own {
  display: flex;
  gap: 8px;
}
.own-input {
  flex: 1;
  min-width: 0;
  height: 44px;
  padding: 0 16px;
  border-radius: 22px;
  border: 1px solid var(--accent-line);
  background: var(--glass-strong);
  color: var(--ink);
  outline: none;
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
}
.own-send {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: var(--accent);
  color: var(--on-accent);
}
.own-send:disabled {
  opacity: 0.5;
}
.row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.row-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 32px;
  padding: 0 12px;
  border-radius: 99px;
  background: var(--glass);
  border: 1px solid var(--glass-line);
  color: var(--ink-2);
  font-size: 13px;
  white-space: nowrap;
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
}
.row-btn.on {
  color: var(--accent-ink);
  background: var(--glass-strong);
  border-color: var(--accent-line);
}
.row-btn.end {
  color: var(--on-accent);
  background: var(--accent);
  border-color: transparent;
  font-weight: 600;
}
.box {
  position: relative;
  padding: 14px 16px 12px;
  border-radius: 22px;
  background: var(--glass-strong);
  border: 1px solid var(--glass-line);
  backdrop-filter: blur(22px);
  -webkit-backdrop-filter: blur(22px);
  box-shadow: var(--shadow);
  cursor: pointer;
  user-select: none;
}
.box .name {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-bottom: 4px;
  color: var(--accent-ink);
  font-weight: 600;
  font-size: 14px;
}
.box .text {
  margin: 0;
  min-height: 3.3em;
  max-height: 34vh;
  overflow-y: auto;
  font-size: 16px;
  line-height: 1.65;
  letter-spacing: 0.02em;
  white-space: pre-wrap;
  word-break: break-word;
}
.box.narration .text {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--ink-2);
  font-size: 15px;
  font-style: italic;
  text-align: center;
}
.box .text.error {
  color: var(--bad);
  font-size: 14px;
}
.action {
  opacity: 0.6;
  font-style: italic;
}
.next {
  position: absolute;
  right: 14px;
  bottom: 8px;
  color: var(--accent-ink);
  animation: bob 1.2s ease-in-out infinite;
}
@keyframes bob {
  50% {
    transform: translateY(3px);
  }
}
.skip {
  position: absolute;
  top: 8px;
  right: 10px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  color: var(--ink-3);
}

/* —— 这一次说过的话 —— */
.log {
  position: absolute;
  z-index: 11;
  left: 12px;
  right: 12px;
  top: calc(var(--safe-top) + 100px);
  bottom: calc(var(--safe-bottom) + 12px);
  overflow-y: auto;
  padding: 12px 14px;
  border-radius: 20px;
  background: var(--glass-strong);
  border: 1px solid var(--glass-line);
  backdrop-filter: blur(22px);
  -webkit-backdrop-filter: blur(22px);
}
.log-head {
  position: sticky;
  top: -12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: -12px -14px 8px;
  padding: 12px 14px 8px;
  background: var(--glass-strong);
  font-size: 13.5px;
  font-weight: 600;
}
.log-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 0;
  border-bottom: 1px solid var(--glass-line);
}
.log-row:last-child {
  border-bottom: 0;
}
.log-row .who {
  font-size: 11.5px;
  color: var(--ink-3);
}
.log-row.her .who {
  color: var(--accent-ink);
}
.log-row .what {
  font-size: 14px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}

/* —— 约会回忆 —— */
.memory {
  position: absolute;
  z-index: 10;
  left: 12px;
  right: 12px;
  bottom: calc(var(--safe-bottom) + 12px);
  padding: 16px;
  border-radius: 22px;
  background: var(--glass-strong);
  border: 1px solid var(--glass-line);
  backdrop-filter: blur(22px);
  -webkit-backdrop-filter: blur(22px);
  box-shadow: var(--shadow);
  animation: rise 0.3s var(--ease) both;
}
.farewell {
  margin: 8px 0 0;
  font-size: 14px;
  line-height: 1.55;
  color: var(--ink-2);
}
.shots {
  display: flex;
  gap: 6px;
  margin-top: 10px;
  overflow-x: auto;
}
.shot {
  flex-shrink: 0;
  width: 54px;
  height: 78px;
  padding: 0;
  border: 0;
  border-radius: 10px;
  overflow: hidden;
  background: var(--panel);
}
.shot.on {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.pill-btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 38px;
  height: 38px;
  border-radius: 99px;
  background: var(--glass);
  border: 1px solid var(--glass-line);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  color: var(--accent-ink);
  font-size: 16px;
}
.pill-btn.off {
  color: var(--ink-3);
}
.pill-btn:disabled {
  opacity: 0.7;
}
.spin {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
