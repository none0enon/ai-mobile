<script setup lang="ts">
import { IMAGE_MOMENTS, worldOf, type Message, type MessagePart } from '@app/shared';
import { showConfirmDialog, showImagePreview, showToast } from 'vant';
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import AssetImg from '@/components/common/AssetImg.vue';
import HScroll from '@/components/common/HScroll.vue';
import HerSide from '@/components/scene/HerSide.vue';
import { SCENE_LOCATION } from '@/components/scene/location';
import SceneShell from '@/components/scene/SceneShell.vue';
import TimerRing from '@/components/scene/TimerRing.vue';
import { assetUrl, services } from '@/services';
import { personaOf } from '@/services/prompt';
import { useAppStore } from '@/stores/app';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';
import { useGalleryStore, type GalleryItem } from '@/stores/gallery';
import { useRealWorldStore } from '@/stores/realworld';
import { useRhythmStore } from '@/stores/rhythm';
import { uid } from '@/utils/id';

/**
 * 陪伴学习（默认"连线自习"）：你在你那儿学，她在她那边学，共用一个番茄钟。
 * - 开场：你说今天学什么、状态怎么样、学几个番茄、有没有约定；她先说自己今天的小目标，再回应你；
 * - 专注：她不说话，但一直在（换表情、偶尔打瞌睡）；她的进度自己走，会卡住；你可以传纸条、喊"我卡住了"；
 * - 番茄结束：她报自己的进度、夸你做完的事、回纸条；休息时直接在这里聊；
 * - 结束：她说今天的总结和一两句自习日记，聊天里发一张学习卡片，分隔写"结束连线 · 学了 N 分钟"。
 * 她说的每句话都来自「陪伴 · 快速」（这个场景的功能预设 + 这一次的输入），和你说的话一起存进聊天。
 * 没接通时不出演示台词，界面写明原因。计时按时间戳算，锁屏、切后台回来都对得上。
 *
 * 画面（设计文档 §10.3）：用"陪伴学习"的生图预设画三个时刻，画好的图盖在背景和立绘上面，没画好时照常是立绘：
 * - 入座：进来时画一张她在座位上的样子（今天同一个地方、同一身衣服画过的就直接用图库里的，不重画）；
 * - 偷拍：每个番茄中间自动画一张她专心（或卡住、打瞌睡）的样子；点"看她一眼"马上画一张，有时她会发现你在看；
 * - 奖励：学完画一张，和这次画的图一起放进学习卡片。
 * 衣服是节律里她今天的那套（同一天的图衣服一致）；长相按角色设定（同人是角色 tag + 作品 tag）。
 * 自动画可以在右上角关掉；NovelAI 只在不花点的设置下自动画。一次只画一张，你点的排在自动的前面。
 */
type Phase = 'setup' | 'focus' | 'break' | 'done';
type Mood = 'good' | 'ok' | 'tired';
const MOODS: { id: Mood; label: string }[] = [
  { id: 'good', label: '元气' },
  { id: 'ok', label: '还行' },
  { id: 'tired', label: '好累' },
];
const LENGTHS = { normal: { focus: 25, rest: 5, label: '25 / 5 分钟' }, short: { focus: 15, rest: 3, label: '15 / 3 分钟' } } as const;
type Length = keyof typeof LENGTHS;
const NOISES = [
  { id: 'rain', label: '雨声', icon: 'i-lucide-cloud-rain' },
  { id: 'pages', label: '翻书', icon: 'i-lucide-book-open' },
  { id: 'cafe', label: '咖啡馆', icon: 'i-lucide-coffee' },
];
/** 离开多久才算离开（短于这个的不问） */
const AWAY_MS = 15_000;
/** 她刚说的话在专注时还留多久 */
const LINE_MS = 25_000;

const app = useAppStore();
const chars = useCharacterStore();
const chat = useChatStore();
const real = useRealWorldStore();
const gallery = useGalleryStore();
const rhythm = useRhythmStore();
const router = useRouter();
const location = inject(SCENE_LOCATION, ref(null));

const her = computed(() => chars.byId(app.activeCharacterId) ?? chars.list[0]!);
const chatId = computed(() => chat.chatOfCharacter(her.value.id)?.id ?? '');
const userName = computed(() => personaOf(chat.chatById(chatId.value)).name);
/** 她今天手头的事：节律排的（没有节律时用她的世界里写的） */
const herGoal = computed(() => rhythm.taskOf(her.value.id) || worldOf(her.value.id).life.studyTask);
const mode = computed(() => chat.chatOfCharacter(her.value.id)?.togetherMode ?? 'remote');
const yourPlace = computed(() => (mode.value === 'bring' ? '' : (real.places.find((p) => p.id === real.hereId)?.name ?? '家')));

// —— 开场 ——
const phase = ref<Phase>('setup');
const mood = ref<Mood>('ok');
const length = ref<Length>('normal');
const plan = ref(4);
const promise = ref('');
const tasks = ref<{ text: string; done: boolean }[]>([]);
const newTask = ref('');
watch(mood, (m) => {
  if (m === 'tired') length.value = 'short';
});
function addTask() {
  const t = newTask.value.trim();
  if (!t) return;
  tasks.value.push({ text: t, done: false });
  newTask.value = '';
}

// —— 计时：按时间戳算 ——
const focusMin = computed(() => LENGTHS[length.value].focus);
const restMin = computed(() => LENGTHS[length.value].rest);
const now = ref(Date.now());
const endsAt = ref<number | null>(null);
const pausedLeft = ref<number | null>(null);
const leftMs = computed(() => pausedLeft.value ?? Math.max(0, (endsAt.value ?? now.value) - now.value));
const totalSec = computed(() => (phase.value === 'break' ? restMin.value : focusMin.value) * 60);
const running = computed(() => endsAt.value !== null && pausedLeft.value === null);
const pomodoros = ref(0);
const focusedMs = ref(0);
let ticker: ReturnType<typeof setInterval> | undefined;
let ending = false;

function startSegment(kind: 'focus' | 'break') {
  phase.value = kind;
  now.value = Date.now();
  endsAt.value = now.value + (kind === 'focus' ? focusMin.value : restMin.value) * 60_000;
  pausedLeft.value = null;
  clearInterval(ticker);
  ticker = setInterval(tick, 1000);
  void services.native.keepAwake(true);
  if (kind === 'focus') {
    awayThisRound.value = 0;
    // 这个番茄中间偷拍一张（35%–75% 之间的某一刻）
    peekAt = now.value + focusMin.value * 60_000 * (0.35 + Math.random() * 0.4);
  } else peekAt = null;
}
function tick() {
  const before = now.value;
  now.value = Date.now();
  if (phase.value === 'focus' && running.value) {
    herTick(now.value - before);
    presenceTick();
    if (peekAt !== null && now.value >= peekAt && document.visibilityState === 'visible') {
      peekAt = null;
      void drawMoment('peek', 'auto');
    }
  }
  if (running.value && leftMs.value <= 0) void onSegmentEnd();
}
function togglePause() {
  if (running.value) {
    pausedLeft.value = leftMs.value;
    endsAt.value = null;
  } else if (pausedLeft.value !== null) {
    endsAt.value = Date.now() + pausedLeft.value;
    pausedLeft.value = null;
    now.value = Date.now();
  }
}
function addFive() {
  if (pausedLeft.value !== null) pausedLeft.value += 5 * 60_000;
  else if (endsAt.value !== null) endsAt.value += 5 * 60_000;
}
function skipBreak() {
  if (phase.value === 'break') startSegment('focus');
}

// —— 她的进度：她自己的节奏，有快有慢，偶尔卡住 ——
const herProgress = ref(0);
const herStuck = ref(false);
const herStuckTimes = ref(0);
/** 她卡住的还剩多久（按她自己的时间算，切后台回来补算时也对） */
let stuckLeftMs = 0;
/** 按经过的时间推进她的进度；切后台回来时间一下子过去很多，按每分钟一步补算 */
function herTick(dtMs: number) {
  for (let left = dtMs; left > 0; left -= 60_000) herStep(Math.min(left, 60_000));
}
function herStep(dtMs: number) {
  if (herProgress.value >= 100) return;
  if (herStuck.value) {
    stuckLeftMs -= dtMs;
    if (stuckLeftMs <= 0) herStuck.value = false;
    return;
  }
  // 每分钟大约 6% 的机会卡住 2–5 分钟
  if (Math.random() < 0.06 * (dtMs / 60_000)) {
    herStuck.value = true;
    herStuckTimes.value += 1;
    stuckLeftMs = (2 + Math.random() * 3) * 60_000;
    return;
  }
  const perMs = 100 / (Math.max(1, plan.value) * focusMin.value * 60_000);
  herProgress.value = Math.min(100, herProgress.value + perMs * dtMs * (0.6 + Math.random() * 0.8));
}

// —— 她的小动作（本地，不说话）：换表情；专注久了偶尔打瞌睡，你可以叫醒她 ——
const dozing = ref(false);
let nextPresenceAt = 0;
function presenceTick() {
  const t = Date.now();
  if (dozing.value || t < nextPresenceAt) return;
  nextPresenceAt = t + (40 + Math.random() * 80) * 1000;
  if (t > lineUntil.value) {
    const focusedLong = focusedMs.value + (focusMin.value * 60_000 - leftMs.value) > 20 * 60_000;
    if (focusedLong && Math.random() < 0.08) {
      dozing.value = true;
      chars.setExpression(her.value.id, 'sleep');
      // 这个番茄还没偷拍：现在就拍她睡着的样子
      if (peekAt !== null) peekAt = Date.now();
      return;
    }
    const pool = herStuck.value ? ['pout', 'neutral', 'sad'] : ['neutral', 'neutral', 'smile', 'shy', 'sleepy'];
    chars.setExpression(her.value.id, pool[Math.floor(Math.random() * pool.length)] as string);
  }
}
function wakeHer() {
  dozing.value = false;
  chars.setExpression(her.value.id, 'surprised');
  setTimeout(() => chars.setExpression(her.value.id, 'shy'), 1600);
}
/** 看她一眼：马上画一张她此刻的样子（偷拍）；有时她会发现你在看，抬头冲你笑 */
function lookAtHer() {
  services.native.vibrate(12);
  if (drawingNow.value?.priority === 'user') {
    showToast('正在画上一眼，等一下');
    return;
  }
  const noticed = !dozing.value && Math.random() < 0.4;
  chars.setExpression(her.value.id, noticed ? 'shy' : herStuck.value ? 'pout' : 'neutral');
  void drawMoment('peek', 'user', noticed ? `${her.value.name}发现你在看${her.value.pronoun}，抬头和你对上了眼` : `${her.value.name}没发现你在看${her.value.pronoun}`);
}

// —— 画面：这个场景的生图预设，画入座、偷拍、奖励三个时刻 ——
const MOMENTS = IMAGE_MOMENTS.study ?? {};
type Moment = 'seat' | 'peek' | 'reward';
let peekAt: number | null = null;
const art = ref<GalleryItem | null>(null);
const artUrl = ref<string | null>(null);
/** 这一轮画的图：结束时放进学习卡片 */
const sessionArt = ref<GalleryItem[]>([]);
/** 画不出来的原因（没接通、自动画停着、出错）：面板里写一行 */
const artIssue = ref<{ text: string; settings: boolean } | null>(null);
const drawingNow = computed(() => gallery.isDrawing(her.value.id, 'study'));
const drawingText = computed(() => {
  const d = drawingNow.value;
  if (!d) return null;
  const what = MOMENTS[d.moment] ?? '画面';
  return d.stage === 'queued' ? `${what}：排队等前一张画完` : d.stage === 'prompt' ? `${what}：正在写 tags` : `${what}：正在画`;
});
let artToken = 0;
watch(
  art,
  async (item) => {
    const mine = (artToken += 1);
    const url = !item ? null : item.assetKey ? await assetUrl(item.assetKey) : (item.url ?? null);
    if (mine === artToken) artUrl.value = url;
  },
  { immediate: true },
);
const shownArt = computed(() => (artUrl.value ? { url: artUrl.value, title: art.value?.title } : null));

/** 她此刻的状态（数据，给生图提示词看） */
function stateLine(): string {
  const p = `进度 ${Math.round(herProgress.value)}%`;
  if (dozing.value) return `${her.value.name}趴在桌上睡着了（${p}）`;
  if (herStuck.value) return `${her.value.name}卡住了，盯着书皱眉（${p}）`;
  return `${her.value.name}在专心${herGoal.value ? `做"${herGoal.value}"` : '学习'}（${p}）`;
}
function where(): string {
  const place = location.value?.name ?? '图书馆';
  if (mode.value === 'visit') return `在${place}，${userName.value}坐在${her.value.pronoun}旁边`;
  if (mode.value === 'bring') return `在${place}，${her.value.pronoun}坐在${userName.value}对面`;
  return `在${place}，和${userName.value}连线自习（${userName.value}在${yourPlace.value || '自己那边'}）`;
}
function captionFor(m: Moment, extra?: string): string {
  if (m === 'seat') return [`${her.value.name}${where()}，刚坐下准备开始`, herGoal.value ? `今天要做：${herGoal.value}` : '', extra].filter(Boolean).join('；');
  if (m === 'peek') return [`第 ${pomodoros.value + 1} 个番茄中`, stateLine(), where(), extra].filter(Boolean).join('；');
  const kept = promise.value.trim() ? `约定"${promise.value.trim()}"${pomodoros.value >= plan.value ? '做到了' : '没做到'}` : '';
  return [`今天一起学完了：${pomodoros.value} 个番茄、${Math.round(focusedMs.value / 60_000)} 分钟`, kept, where(), extra].filter(Boolean).join('；');
}

let autoNoted = false;
async function drawMoment(m: Moment, priority: 'user' | 'auto', extra?: string): Promise<GalleryItem | null> {
  if (priority === 'auto') {
    const chk = gallery.autoCheck();
    if (!chk.ok) {
      // 没接通、自动画停着：只提示一次，不打扰
      if (!autoNoted && chk.reason !== '自动画关着') artIssue.value = { text: `画面先用立绘：${chk.reason}`, settings: /没接通|API 设置/.test(chk.reason) };
      autoNoted = true;
      return null;
    }
  }
  const r = await gallery.draw({
    characterId: her.value.id,
    sceneId: 'study',
    moment: m,
    caption: captionFor(m, extra),
    priority,
    locationId: location.value?.id ?? null,
    expression: chars.expression[her.value.id],
    recent: chatId.value ? chat.recentLines(chatId.value, 4) : [],
  });
  if (r.ok) {
    art.value = r.item;
    sessionArt.value.push(r.item);
    artIssue.value = null;
    return r.item;
  }
  if (!r.busy) artIssue.value = { text: `没画出来：${r.reason}`, settings: /没接通/.test(r.reason) };
  return null;
}
/** 这次画的图：点一张从它开始翻 */
async function previewSession(start: number) {
  const urls = await Promise.all(sessionArt.value.map(async (i) => (i.assetKey ? await assetUrl(i.assetKey) : (i.url ?? null))));
  const images = urls.filter((u): u is string => !!u);
  if (images.length) showImagePreview({ images, startPosition: Math.min(start, images.length - 1), closeable: true });
  else showToast('本机找不到这几张图了');
}
function retryArt() {
  artIssue.value = null;
  void drawMoment(phase.value === 'focus' ? 'peek' : 'seat', 'user');
}
function toggleAutoDraw() {
  gallery.autoDraw = !gallery.autoDraw;
  showToast(gallery.autoDraw ? '自动画图开了：入座、每个番茄偷拍一张、学完一张' : '自动画图关了：点"看一眼"时才画');
  if (gallery.autoDraw && !art.value && !drawingNow.value) void drawMoment('seat', 'auto');
}

/** 进来时：今天在这儿、穿这身画过的就直接用（先入座、偷拍的），没有就画一张入座 */
function initArt() {
  const outfit = rhythm.outfitFor(her.value.id, 'study')?.name ?? null;
  const found = gallery.find(her.value.id, 'study', { today: true, locationId: location.value?.id ?? null, outfit });
  const pick = found.find((i) => i.moment !== 'reward') ?? found[0];
  if (pick) art.value = pick;
  else void drawMoment('seat', 'auto');
}

// —— 她说的话：都来自「陪伴 · 快速」，存进聊天 ——
const herLine = ref('');
const lineUntil = ref(0);
const notConnected = ref('');
const stream = computed(() => (chatId.value ? chat.streams[chatId.value] : undefined));
const streamingText = computed(() => (stream.value ? (chat.list(chatId.value).find((m) => m.id === stream.value!.messageId)?.text ?? '') : ''));
const cue = computed(() => {
  if (phase.value === 'setup') return '开场';
  if (phase.value === 'focus') return `第 ${pomodoros.value + 1} 个番茄`;
  if (phase.value === 'break') return `第 ${pomodoros.value} 个番茄后休息`;
  return '结束';
});
const shownLine = computed(() => {
  if (streamingText.value) return streamingText.value;
  if (!herLine.value) return '';
  if (phase.value === 'focus' && now.value > lineUntil.value) return '';
  return herLine.value;
});

async function reply(task: string, lines: string[], userText?: string): Promise<Message | null> {
  if (!chatId.value) return null;
  const r = await chat.sceneReply(chatId.value, { task, input: lines.filter(Boolean).join('\n'), userText, cue: cue.value });
  if (!r.ok) {
    if (r.notConnected) notConnected.value = r.reason;
    else showToast(r.reason);
    return null;
  }
  notConnected.value = '';
  herLine.value = r.message.text;
  lineUntil.value = Date.now() + LINE_MS;
  nextPresenceAt = Date.now() + LINE_MS;
  return r.message;
}

const doneText = () => tasks.value.filter((t) => t.done).map((t) => t.text).join('、');
const todoText = () => tasks.value.filter((t) => !t.done).map((t) => t.text).join('、');

async function begin() {
  if (!chatId.value) return;
  startSegment('focus');
  const L = LENGTHS[length.value];
  await reply('study-start', [
    `${userName.value}今天要学：${tasks.value.map((t) => t.text).join('、') || '没说'}`,
    `${userName.value}的状态：${MOODS.find((m) => m.id === mood.value)?.label}`,
    `计划：${plan.value} 个番茄，每个 ${L.focus} 分钟，休息 ${L.rest} 分钟`,
    promise.value.trim() ? `约定：${promise.value.trim()}` : '',
    `${her.value.name}今天手头的事：${herGoal.value}`,
  ]);
}

async function onSegmentEnd() {
  if (ending) return;
  ending = true;
  try {
    if (phase.value === 'focus') {
      pomodoros.value += 1;
      focusedMs.value += focusMin.value * 60_000;
      services.native.vibrate([20, 60, 20]);
      dozing.value = false;
      startSegment('break');
      const notes = pendingNotes.splice(0);
      await reply('study-break', [
        `第 ${pomodoros.value} 个番茄结束（${focusMin.value} 分钟）`,
        `${userName.value}已完成：${doneText() || '还没有'}；还没完成：${todoText() || '没有了'}`,
        awayThisRound.value ? `${userName.value}这个番茄中途离开了 ${awayThisRound.value} 次${playedThisRound.value ? `，其中 ${playedThisRound.value} 次说是去玩了` : ''}` : '',
        notes.length ? `${userName.value}传来的纸条：${notes.map((n) => `「${n}」`).join(' ')}` : '',
        `${her.value.name}的进度：${Math.round(herProgress.value)}%${herStuck.value ? '，现在卡住了' : herStuckTimes.value ? '，中途卡住过' : ''}`,
      ]);
      playedThisRound.value = 0;
    } else if (phase.value === 'break') {
      startSegment('focus');
    }
  } finally {
    ending = false;
  }
}

// —— 传纸条：专注时写一张，计时不停；她当场只抬头笑一下，休息时再回 ——
const pendingNotes: string[] = [];
const noteOpen = ref(false);
const noteText = ref('');
function sendNote() {
  const t = noteText.value.trim();
  if (!t || !chatId.value) return;
  chat.push(chatId.value, 'user', [{ type: 'text', text: t }], { meta: { scene: 'study', cue: cue.value } });
  pendingNotes.push(t);
  noteText.value = '';
  noteOpen.value = false;
  chars.setExpression(her.value.id, 'smile');
  showToast('纸条递过去了，她休息时回你');
}

// —— 我卡住了 ——
const stuckOpen = ref(false);
const stuckText = ref('');
async function askHelp() {
  const t = stuckText.value.trim();
  if (!t) return;
  stuckOpen.value = false;
  stuckText.value = '';
  await reply('study-stuck', [`专注中（${cue.value}），${userName.value}卡住了`], t);
}

// —— 休息时聊天 ——
const chatText = ref('');
async function sendChat() {
  const t = chatText.value.trim();
  if (!t) return;
  chatText.value = '';
  await reply('study-chat', [`休息中（${cue.value}）`], t);
}

// —— 离开 App：短的不算；久了回来问一句，不自动扣分 ——
let hiddenAt = 0;
const awayAsk = ref(false);
const awayTotal = ref(0);
const awayThisRound = ref(0);
const playedThisRound = ref(0);
function onVisibility() {
  if (document.visibilityState === 'hidden') {
    hiddenAt = Date.now();
    return;
  }
  now.value = Date.now();
  if (phase.value === 'focus' && running.value && hiddenAt && Date.now() - hiddenAt >= AWAY_MS) {
    awayTotal.value += 1;
    awayThisRound.value += 1;
    awayAsk.value = true;
  }
  hiddenAt = 0;
  tick();
}
function answerAway(played: boolean) {
  awayAsk.value = false;
  if (played) playedThisRound.value += 1;
}

// —— 结束 ——
const diary = ref('');
async function finish() {
  if (!chatId.value) return;
  try {
    await showConfirmDialog({ title: '今天就学到这里？', confirmButtonText: '结束', cancelButtonText: '再学一会' });
  } catch {
    return;
  }
  if (phase.value === 'focus') focusedMs.value += focusMin.value * 60_000 - leftMs.value;
  clearInterval(ticker);
  endsAt.value = null;
  pausedLeft.value = null;
  void services.native.keepAwake(false);
  phase.value = 'done';
  dozing.value = false;
  const minutes = Math.round(focusedMs.value / 60_000);
  const kept = pomodoros.value >= plan.value;
  const msg = await reply('study-end', [
    `结束：一共 ${pomodoros.value} 个番茄，专注 ${minutes} 分钟（计划 ${plan.value} 个）`,
    `${userName.value}完成了：${doneText() || '没有勾掉任务'}；没完成：${todoText() || '没有'}`,
    awayTotal.value ? `中途离开 ${awayTotal.value} 次` : '',
    promise.value.trim() ? `约定：${promise.value.trim()}（${kept ? '做到了' : '没做到'}）` : '',
    `${her.value.name}的进度：${Math.round(herProgress.value)}%`,
  ]);
  diary.value = msg?.text.split(/日记[:：]/)[1]?.trim() ?? '';
  const card: MessagePart = {
    type: 'study',
    logId: uid('study'),
    pomodoros: pomodoros.value,
    minutes,
    tasks: tasks.value.map((t) => ({ ...t })),
    away: awayTotal.value,
    ...(promise.value.trim() ? { promise: { text: promise.value.trim(), kept } } : {}),
    her: { goal: herGoal.value, progress: Math.round(herProgress.value) },
    ...(diary.value ? { diary: diary.value } : {}),
    ...(sessionArt.value.length ? { images: sessionArt.value.map(cardImage) } : {}),
  };
  const cardMsg = chat.postCard(chatId.value, 'user', card);
  const cid = chatId.value;
  chat.leaveScene(her.value.id, `学了 ${minutes} 分钟`);
  // 学完画一张（奖励），画好放进刚才的学习卡片（按 id 重新取，离开场景也照样放进去）
  void drawMoment('reward', 'auto').then((item) => {
    if (!item) return;
    const part = chat.list(cid).find((m) => m.id === cardMsg.id)?.parts.find((p) => p.type === 'study');
    if (part?.type === 'study') part.images = [...(part.images ?? []), cardImage(item)];
  });
}
function cardImage(i: GalleryItem) {
  return { assetKey: i.assetKey, ...(i.url ? { url: i.url } : {}), title: i.title, moment: i.moment };
}
function again() {
  const loc = location.value;
  if (loc) chat.enterScene(her.value.id, loc.id, 'study');
  phase.value = 'setup';
  pomodoros.value = 0;
  focusedMs.value = 0;
  awayTotal.value = 0;
  herProgress.value = 0;
  herStuckTimes.value = 0;
  herLine.value = '';
  diary.value = '';
  sessionArt.value = art.value ? [art.value] : [];
  tasks.value = tasks.value.filter((t) => !t.done);
}

// —— 打卡：从聊天里的学习卡片算（真实记录） ——
const DAY = 86_400_000;
const dayKey = (t: number) => new Date(t).toDateString();
const studyCards = computed(() =>
  chat
    .list(chatId.value)
    .flatMap((m) => m.parts.filter((p): p is Extract<MessagePart, { type: 'study' }> => p.type === 'study').map((p) => ({ at: m.createdAt, p }))),
);
const studiedDays = computed(() => new Set(studyCards.value.map((c) => dayKey(c.at))));
const streak = computed(() => {
  let n = 0;
  for (let t = Date.now(); studiedDays.value.has(dayKey(t)); t -= DAY) n += 1;
  return n;
});
const week = computed(() =>
  Array.from({ length: 7 }, (_, i) => {
    const t = Date.now() - (6 - i) * DAY;
    return { key: dayKey(t), label: ['日', '一', '二', '三', '四', '五', '六'][new Date(t).getDay()] as string, on: studiedDays.value.has(dayKey(t)) };
  }),
);
const weekMinutes = computed(() => studyCards.value.filter((c) => c.at > Date.now() - 7 * DAY).reduce((n, c) => n + c.p.minutes, 0));
const todayPomodoros = computed(
  () => studyCards.value.filter((c) => dayKey(c.at) === dayKey(Date.now())).reduce((n, c) => n + c.p.pomodoros, 0) + (phase.value === 'done' ? 0 : pomodoros.value),
);

onMounted(() => {
  document.addEventListener('visibilitychange', onVisibility);
  initArt();
});
onBeforeUnmount(() => {
  clearInterval(ticker);
  document.removeEventListener('visibilitychange', onVisibility);
  void services.native.keepAwake(false);
});

const noise = ref<string | null>('rain');
const quiet = computed(() => phase.value === 'focus' && running.value && !shownLine.value);
const herExtra = computed(() => {
  if (phase.value === 'setup') return '';
  const pct = `进度 ${Math.round(herProgress.value)}%`;
  if (dozing.value) return `${pct} · ${her.value.pronoun}趴在桌上睡着了`;
  return herStuck.value ? `${pct} · 卡住了` : pct;
});
</script>

<template>
  <SceneShell
    scene-id="study"
    :line="shownLine"
    :typing="!!stream && !streamingText"
    pose="study"
    :rain="noise === 'rain'"
    :layout="{ left: 80, bottom: 58, height: 28 }"
    :art="shownArt"
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
    </template>
    <template #overlay>
      <div v-if="quiet" class="quiet"><span class="i-lucide-moon" />专注中 · {{ her.pronoun }}在旁边忙自己的</div>
    </template>

    <div v-if="notConnected" class="notice">
      <span class="i-lucide-plug-zap shrink-0" />
      <span class="flex-1 min-w-0">{{ notConnected }}</span>
      <button class="text-accent-ink shrink-0" @click="router.push('/me/api?feature=companion')">去设置</button>
    </div>

    <div v-if="artIssue" class="notice" data-testid="art-issue">
      <span class="i-lucide-image-off shrink-0" />
      <span class="flex-1 min-w-0">{{ artIssue.text }}</span>
      <button v-if="artIssue.settings" class="text-accent-ink shrink-0" @click="router.push('/me/api?feature=image')">去设置</button>
      <button v-else class="text-accent-ink shrink-0" @click="retryArt">重试</button>
    </div>

    <HerSide label="在忙：" :content="herGoal" :extra="herExtra" />

    <!-- 开场 -->
    <template v-if="phase === 'setup'">
      <div class="label">今天学什么</div>
      <label v-for="(t, i) in tasks" :key="i" class="task">
        <van-checkbox v-model="t.done" icon-size="18px" />
        <span>{{ t.text }}</span>
      </label>
      <div class="flex gap-2 mt-1">
        <input v-model="newTask" class="field" placeholder="加一个任务" aria-label="新任务" @keydown.enter="addTask" />
        <van-button size="small" round @click="addTask">添加</van-button>
      </div>
      <div class="label">状态</div>
      <div class="flex gap-2">
        <button v-for="m in MOODS" :key="m.id" type="button" class="chip" :class="{ on: mood === m.id }" @click="mood = m.id">{{ m.label }}</button>
      </div>
      <div class="label">番茄</div>
      <div class="flex gap-2 items-center flex-wrap">
        <button v-for="(L, k) in LENGTHS" :key="k" type="button" class="chip" :class="{ on: length === k }" @click="length = k">{{ L.label }}</button>
        <van-stepper v-model="plan" :min="1" :max="12" integer button-size="26px" />
        <span class="text-[12.5px] text-ink-3">个</span>
      </div>
      <div class="label">约定（可以不写）</div>
      <input v-model="promise" class="field w-full" placeholder="例如：学满 4 个番茄一起去吃砂锅粥" aria-label="约定" />
      <van-button type="primary" round block class="!mt-3.5" @click="begin">开始</van-button>
    </template>

    <!-- 专注 / 休息 -->
    <template v-else-if="phase === 'focus' || phase === 'break'">
      <TimerRing
        class="mt-3"
        :remain-sec="Math.ceil(leftMs / 1000)"
        :total-sec="totalSec"
        :size="160"
        :label="phase === 'focus' ? `一起专注 · 第 ${pomodoros + 1} 个番茄` : '一起休息'"
        :tone="phase === 'focus' ? '#8fb3f0' : 'var(--good)'"
      />

      <div v-if="awayAsk" class="away">
        <div class="text-[13.5px]">刚才离开了一会儿，是去查资料，还是去玩了？</div>
        <div class="flex gap-2 mt-2">
          <van-button size="small" round @click="answerAway(false)">查资料</van-button>
          <van-button size="small" round @click="answerAway(true)">去玩了</van-button>
        </div>
      </div>

      <div class="flex gap-2 mt-3 btns">
        <van-button round block @click="finish">结束</van-button>
        <van-button type="primary" round block @click="togglePause">{{ running ? '暂停' : '继续' }}</van-button>
        <van-button v-if="phase === 'focus'" round block @click="addFive">+5 分钟</van-button>
        <van-button v-else round block @click="skipBreak">跳过休息</van-button>
      </div>

      <div v-if="phase === 'focus'" class="flex gap-2 mt-2.5 btns">
        <van-button size="small" round block icon="records-o" @click="noteOpen = true">传纸条</van-button>
        <van-button size="small" round block icon="question-o" @click="stuckOpen = true">我卡住了</van-button>
        <van-button v-if="dozing" size="small" round block icon="bell" @click="wakeHer">叫醒{{ her.pronoun }}</van-button>
        <van-button v-else size="small" round block icon="eye-o" :loading="drawingNow?.priority === 'user'" loading-text="在看…" data-testid="look-at-her" @click="lookAtHer">看{{ her.pronoun }}一眼</van-button>
      </div>
      <div v-else class="flex gap-2 mt-2.5">
        <input v-model="chatText" class="field" :placeholder="`休息一下，和${her.pronoun}说点什么`" aria-label="休息时聊天" @keydown.enter="sendChat" />
        <van-button size="small" round :disabled="!!stream" @click="sendChat">发送</van-button>
      </div>

      <HScroll :active="noise" class="items-center gap-2 mt-3" aria-label="白噪音">
        <span class="text-[12.5px] text-ink-3 whitespace-nowrap shrink-0">白噪音</span>
        <button v-for="n in NOISES" :key="n.id" type="button" class="noise" :class="{ on: noise === n.id }" :aria-pressed="noise === n.id" @click="noise = noise === n.id ? null : n.id">
          <span :class="n.icon" />{{ n.label }}
        </button>
      </HScroll>

      <div class="label">你这边{{ yourPlace ? ` · ${yourPlace}` : '' }} · 这次要完成</div>
      <label v-for="(t, i) in tasks" :key="i" class="task">
        <van-checkbox v-model="t.done" icon-size="18px" />
        <span :class="{ 'line-through text-ink-3': t.done }">{{ t.text }}</span>
      </label>
      <div class="flex gap-2 mt-1">
        <input v-model="newTask" class="field" placeholder="加一个任务" aria-label="新任务" @keydown.enter="addTask" />
        <van-button size="small" round @click="addTask">添加</van-button>
      </div>
    </template>

    <!-- 结束 -->
    <template v-else>
      <div class="text-[16px] font-700 mt-3">今天一起学了 {{ pomodoros }} 个番茄 · {{ Math.round(focusedMs / 60000) }} 分钟</div>
      <div class="text-[12.5px] text-ink-3 mt-1">
        完成 {{ tasks.filter((t) => t.done).length }} / {{ tasks.length }} 个任务<template v-if="awayTotal"> · 离开 {{ awayTotal }} 次</template><template v-if="promise.trim()"> · 约定{{ pomodoros >= plan ? '做到了' : '没做到' }}</template>
      </div>
      <div v-if="diary" class="diary"><span class="i-lucide-notebook-pen text-accent-ink" /> {{ diary }}</div>
      <div v-if="sessionArt.length" class="shots" aria-label="这次画的图">
        <button v-for="(i, n) in sessionArt" :key="i.id" type="button" class="shot" :aria-label="`看大图：${i.title}`" @click="previewSession(n)">
          <AssetImg :asset-key="i.assetKey" :url="i.url" :alt="i.title" />
        </button>
      </div>
      <div class="flex gap-2.5 mt-3.5">
        <van-button round block @click="again">再学一轮</van-button>
        <van-button type="primary" round block @click="router.push(`/chat/${chatId}`)">回聊天</van-button>
      </div>
    </template>

    <div class="stamps">
      <div v-for="d in week" :key="d.key" class="stamp" :class="{ on: d.on }">
        <span v-if="d.on" class="i-lucide-check" />
        <span class="text-[11px]">{{ d.label }}</span>
      </div>
    </div>
    <div class="stats num">
      今天 {{ todayPomodoros }} 个番茄<template v-if="streak"> · 连续 {{ streak }} 天</template><template v-if="weekMinutes"> · 这周一起学了 {{ Math.round(weekMinutes / 6) / 10 }} 小时</template>
    </div>

    <van-popup v-model:show="noteOpen" position="bottom" round>
      <div class="p-4">
        <div class="text-[15px] font-600 mb-2">传一张纸条</div>
        <textarea v-model="noteText" class="area" rows="3" :placeholder="`${her.pronoun}休息时回你，计时不停`" aria-label="纸条" />
        <van-button type="primary" round block class="!mt-2" @click="sendNote">递过去</van-button>
      </div>
    </van-popup>
    <van-popup v-model:show="stuckOpen" position="bottom" round>
      <div class="p-4">
        <div class="text-[15px] font-600 mb-2">哪里卡住了？</div>
        <textarea v-model="stuckText" class="area" rows="3" placeholder="写下题目或者不懂的地方" aria-label="卡住的地方" />
        <van-button type="primary" round block class="!mt-2" @click="askHelp">问{{ her.pronoun }}</van-button>
      </div>
    </van-popup>
  </SceneShell>
</template>

<style scoped>
.quiet {
  position: absolute;
  z-index: 9;
  top: calc(var(--safe-top) + 62px);
  left: 50%;
  transform: translateX(-50%);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 99px;
  background: var(--glass);
  color: var(--ink-2);
  font-size: 12.5px;
  white-space: nowrap;
}
.notice {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  padding: 8px 12px;
  border-radius: 12px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 12.5px;
}
.label {
  margin: 12px 0 6px;
  font-size: 12.5px;
  color: var(--ink-3);
}
.chip {
  height: 30px;
  padding: 0 12px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 13px;
  white-space: nowrap;
}
.chip.on {
  background: var(--accent-soft);
  color: var(--accent-ink);
  outline: 1px solid var(--accent-line);
}
.btns :deep(.van-button) {
  padding: 0 8px;
  white-space: nowrap;
}
.away {
  margin-top: 10px;
  padding: 10px 12px;
  border-radius: 14px;
  background: var(--accent-soft);
  border: 1px solid var(--accent-line);
}
.noise {
  flex-shrink: 0;
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 30px;
  padding: 0 10px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 12.5px;
}
.noise.on {
  background: var(--accent-soft);
  color: var(--accent-ink);
  outline: 1px solid var(--accent-line);
}
.task {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 2px;
  font-size: 14.5px;
}
.field {
  flex: 1;
  min-width: 0;
  height: 34px;
  padding: 0 12px;
  border-radius: 17px;
  border: 1px solid var(--border);
  background: var(--panel);
  outline: none;
  font-size: 14px;
}
.area {
  width: 100%;
  padding: 10px 12px;
  border-radius: 14px;
  border: 1px solid var(--border);
  background: var(--panel);
  outline: none;
  font-size: 14px;
  resize: none;
}
.pill-btn {
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
.shots {
  display: flex;
  gap: 8px;
  margin-top: 10px;
  overflow-x: auto;
}
.shot {
  flex-shrink: 0;
  width: 64px;
  height: 86px;
  border-radius: 12px;
  overflow: hidden;
  background: var(--panel);
}
.diary {
  margin-top: 10px;
  padding: 10px 12px;
  border-radius: 14px;
  background: var(--panel);
  font-size: 13.5px;
  line-height: 1.6;
  color: var(--ink-2);
}
.stamps {
  display: flex;
  justify-content: space-between;
  gap: 4px;
  margin-top: 14px;
}
.stamp {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 6px 0;
  border-radius: 10px;
  background: var(--panel);
  color: var(--ink-3);
  font-size: 13px;
}
.stamp.on {
  background: var(--accent-soft);
  color: var(--accent-ink);
}
.stats {
  margin-top: 10px;
  font-size: 12.5px;
  color: var(--ink-3);
  text-align: center;
}
</style>
