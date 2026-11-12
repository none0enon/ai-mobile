<script setup lang="ts">
import { errorText } from '@app/ai';
import { IMAGE_MOMENTS, sceneImageUse, worldOf, type Message, type MessagePart } from '@app/shared';
import { showConfirmDialog, showImagePreview, showToast } from 'vant';
import { computed, inject, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import AssetImg from '@/components/common/AssetImg.vue';
import Avatar from '@/components/common/Avatar.vue';
import ImagePick from '@/components/common/ImagePick.vue';
import PersonaAvatar from '@/components/common/PersonaAvatar.vue';
import Segmented from '@/components/common/Segmented.vue';
import { SCENE_LOCATION } from '@/components/scene/location';
import SceneShell from '@/components/scene/SceneShell.vue';
import DuoTimer from '@/components/scene/study/DuoTimer.vue';
import MineView from '@/components/scene/study/MineView.vue';
import StudyBubble from '@/components/scene/study/StudyBubble.vue';
import TimerControls from '@/components/scene/study/TimerControls.vue';
import TimerRing from '@/components/scene/TimerRing.vue';
import { assetUrl, services } from '@/services';
import { ambience, NOISE_KINDS, NOISE_LABEL, type NoiseKind, type NoiseMix } from '@/services/ambience';
import { putAsset } from '@/services/assets';
import { personaOf } from '@/services/prompt';
import { useAppStore } from '@/stores/app';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';
import { shapeOf, useGalleryStore, type GalleryItem, type ImageShape } from '@/stores/gallery';
import { useRealWorldStore } from '@/stores/realworld';
import { useRhythmStore } from '@/stores/rhythm';
import { uid } from '@/utils/id';
import { compressImage } from '@/utils/image';
import { clock } from '@/utils/time';

/**
 * 陪伴学习（默认"连线自习"）：你在你那儿学，她在她那边学。
 *
 * 画面分三种：
 * - 开始前（和学完）：上下各一半。上半屏是她的立绘，她那边的计划（今天要做的事、现在和接下来的作息）放在半透明的框里压在上面；
 *   下半屏是你的安排：怎么专注（一起专注 / 各自专注）、怎么计时（番茄钟 / 倒计时 / 正计时）、今天学什么、状态、约定。
 * - 一起专注：画面是重点。背景是她专注时画的竖图（没画好时是立绘），中间一个共用的圆形计时器；
 *   左上角她的任务和进度，她说的话以半透明气泡出现在下面；右下角你的任务和进度（有的话），"我卡住了"是它上面的一个气泡；
 *   "刚才离开了一会"出现在计时器下面；白噪声、传纸条、看她一眼排在屏幕最下面，和顶栏对着。
 * - 各自专注：上下两屏，中间一条中线（像足球场）。原来圆形计时器的位置换成一上一下两块长方形计时器，上面是她的、下面是你的，
 *   各走各的：她按自己的节奏（专注 45 分钟、休息 10 分钟），你按你选的计时。上半屏是她的图（按半屏的尺寸画方图或横图），
 *   下半屏是你这边：你预先上传的照片、按你的人设画的图，或者以后接摄像头。
 *
 * 一起做的事和以前一样：
 * - 开场：你说今天学什么、状态怎么样、怎么计时、有没有约定；她先说自己今天的小目标，再回应你；
 * - 专注：她不说话，但一直在（换表情、偶尔打瞌睡）；她的进度自己走，会卡住；你可以传纸条、喊"我卡住了"、看她一眼；
 * - 一段专注结束（番茄到点、倒计时到点、正计时你点了休息）：她报自己的进度、夸你做完的事、回纸条；休息时直接在这里聊；
 * - 结束：她说今天的总结和一两句自习日记，聊天里发一张学习卡片，分隔写"结束连线 · 学了 N 分钟"。
 * 她说的每句话都来自「陪伴 · 快速」（这个场景的功能预设 + 这一次的输入），和你说的话一起存进聊天。
 * 没接通时不出演示台词，界面写明原因。计时按时间戳算，锁屏、切后台回来都对得上。
 *
 * 生图（设计文档 §10.3）：用"陪伴学习"的生图预设。专注开始时画一张她专心的样子（今天同一个地方、同一身衣服、同一种画幅画过的直接用），
 * 之后每个番茄中间（正计时、倒计时大约每 25 分钟）自动偷拍一张；点"看她一眼"马上画一张；学完画一张奖励图，都放进学习卡片。
 * 衣服是节律里她今天的那套；长相按角色设定。自动画可以在右上角关掉；NovelAI 只在不花点的设置下自动画。一次只画一张，你点的排在前面。
 */
type Phase = 'setup' | 'focus' | 'break' | 'done';
type TimerKind = 'pomodoro' | 'countdown' | 'countup';
type FocusMode = 'together' | 'solo';
type Mood = 'good' | 'ok' | 'tired';
type MineSource = 'photo' | 'persona' | 'camera';
/** 自动画的时刻：专注时偷拍、学完奖励（以前进来时画的"入座"图今天画过的也能接着用） */
type Moment = 'peek' | 'reward';

const MOODS: { id: Mood; label: string }[] = [
  { id: 'good', label: '元气' },
  { id: 'ok', label: '还行' },
  { id: 'tired', label: '好累' },
];
const FOCUS_OPTIONS: { value: FocusMode; label: string; icon: string }[] = [
  { value: 'together', label: '一起专注', icon: 'i-lucide-users' },
  { value: 'solo', label: '各自专注', icon: 'i-lucide-rows-2' },
];
const TIMER_OPTIONS: { value: TimerKind; label: string; icon: string }[] = [
  { value: 'pomodoro', label: '番茄钟', icon: 'i-lucide-timer' },
  { value: 'countdown', label: '倒计时', icon: 'i-lucide-hourglass' },
  { value: 'countup', label: '正计时', icon: 'i-lucide-clock-arrow-up' },
];
const LENGTHS = { normal: { focus: 25, rest: 5, label: '25 / 5 分钟' }, short: { focus: 15, rest: 3, label: '15 / 3 分钟' } } as const;
type Length = keyof typeof LENGTHS;
const COUNTDOWNS = [30, 45, 60, 90];
/** 正计时没有终点：她的进度按 90 分钟走完，圆环一小时走一圈 */
const COUNTUP_PLAN_MIN = 90;
/** 正计时的约定算"做到了"至少要学多久（一个番茄） */
const COUNTUP_PROMISE_MIN = 25;
/** 正计时、倒计时大约每隔多久偷拍一张 */
const PEEK_EVERY_MIN = 25;
/** 各自专注时她自己的节奏 */
const HER_FOCUS_MIN = 45;
const HER_REST_MIN = 10;
/** 离开多久才算离开（短于这个的不问） */
const AWAY_MS = 15_000;
/** 专注时一句话（她的、你的）在气泡里留多久 */
const LINE_MS = 25_000;
const FOCUS_TONE = '#8fb3f0';
const SAVE_KEY = 'ai-mobile:study';

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
const persona = computed(() => personaOf(chat.chatById(chatId.value)));
const userName = computed(() => persona.value.name);
/** 她今天手头的事：节律排的（没有节律时用她的世界里写的） */
const herGoal = computed(() => rhythm.taskOf(her.value.id) || worldOf(her.value.id).life.studyTask);
const mode = computed(() => chat.chatOfCharacter(her.value.id)?.togetherMode ?? 'remote');
const yourPlace = computed(() => (mode.value === 'bring' ? '' : (real.places.find((p) => p.id === real.hereId)?.name ?? '家')));
const herWhere = computed(() => location.value?.name ?? worldOf(her.value.id).locations[0]?.name ?? '');
/** 她那边怎么称呼：连线是"她那边"，去她那是"她在你旁边"，带她来是"她在你对面" */
const herHeading = computed(() => {
  const p = her.value.pronoun;
  if (mode.value === 'visit') return `${p}在你旁边 · ${herWhere.value}`;
  if (mode.value === 'bring') return `${p}在你对面 · ${herWhere.value}`;
  return `${p}那边 · ${herWhere.value}`;
});
/** 她今天的作息：现在这一段和下一段（她的计划） */
const herSlot = computed(() => rhythm.slotNow(her.value.id));
const herNext = computed(() => {
  const day = rhythm.todayOf(her.value.id);
  const cur = herSlot.value;
  if (!day || !cur) return null;
  // 按模板的今天每次读出来都是新的一份：按时间段找，不按对象找
  const i = day.schedule.findIndex((s) => s.from === cur.from && s.to === cur.to);
  return i >= 0 ? (day.schedule[i + 1] ?? null) : null;
});

// —— 设置：怎么专注、怎么计时、白噪声、你这边的画面；记在本机，下次打开还是这样 ——
interface MineArt {
  assetKey: string | null;
  url?: string;
  title: string;
  size: ImageShape;
  personaId: string;
  at: number;
}
interface Saved {
  focus: FocusMode;
  timer: TimerKind;
  length: Length;
  plan: number;
  countdownMin: number;
  noise: NoiseKind | null;
  volume: number;
  mine: { source: MineSource | null; photoKey: string | null; drawn: MineArt | null; tags: Record<string, string> };
}
function loadSaved(): Partial<Saved> {
  try {
    const v = JSON.parse(localStorage.getItem(SAVE_KEY) ?? '{}') as unknown;
    return v && typeof v === 'object' ? (v as Partial<Saved>) : {};
  } catch {
    return {};
  }
}
const clamp = (n: unknown, lo: number, hi: number, dflt: number) => (typeof n === 'number' && Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt);
const saved = loadSaved();
const focusMode = ref<FocusMode>(saved.focus === 'solo' ? 'solo' : 'together');
const timerKind = ref<TimerKind>(saved.timer === 'countdown' || saved.timer === 'countup' ? saved.timer : 'pomodoro');
const length = ref<Length>(saved.length === 'short' ? 'short' : 'normal');
const plan = ref(clamp(saved.plan, 1, 12, 4));
const countdownMin = ref(clamp(saved.countdownMin, 5, 180, 45));
const noise = ref<NoiseKind | null>(saved.noise && (NOISE_KINDS as readonly string[]).includes(saved.noise) ? saved.noise : null);
const volume = ref(clamp(saved.volume, 0, 100, 60));
const mine = reactive<Saved['mine']>({
  source: saved.mine?.source ?? null,
  photoKey: saved.mine?.photoKey ?? null,
  drawn: saved.mine?.drawn ?? null,
  tags: { ...(saved.mine?.tags ?? {}) },
});
watch(
  [focusMode, timerKind, length, plan, countdownMin, noise, volume, () => JSON.stringify(mine)],
  () => {
    const s: Saved = { focus: focusMode.value, timer: timerKind.value, length: length.value, plan: plan.value, countdownMin: countdownMin.value, noise: noise.value, volume: volume.value, mine };
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(s));
    } catch {
      // 存不下就算了：这次打开仍然有效
    }
  },
);

// —— 开场 ——
const phase = ref<Phase>('setup');
const mood = ref<Mood>('ok');
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
const doneCount = computed(() => tasks.value.filter((t) => t.done).length);
const currentTask = computed(() => tasks.value.find((t) => !t.done)?.text ?? '都做完了');

// —— 画面：开始前和学完是上下分屏；专注时一起专注是整屏，各自专注是上下两屏 ——
const view = computed<'split' | 'together' | 'solo'>(() => (phase.value === 'setup' || phase.value === 'done' ? 'split' : focusMode.value));
const viewport = reactive({ w: window.innerWidth, h: window.innerHeight });
function onResize() {
  viewport.w = window.innerWidth;
  viewport.h = window.innerHeight;
}
/** 半屏的画幅：手机竖着时半屏接近方形画方图，宽出不少时画横图（"看尺寸填充"） */
const halfShape = computed<ImageShape>(() => (Math.min(viewport.w, 480) / Math.max(1, viewport.h / 2) >= 1.25 ? 'landscape' : 'square'));
/** 圆形计时器的大小：矮屏小一点，免得压到上下的卡片 */
const ringSize = computed(() => Math.round(Math.min(228, Math.max(168, viewport.h * 0.27))));

// —— 计时：按时间戳算（暂停时记下暂停的时刻，继续时把开始时间往后挪） ——
const focusMin = computed(() => LENGTHS[length.value].focus);
const restMin = computed(() => LENGTHS[length.value].rest);
const now = ref(Date.now());
const segStartedAt = ref(0);
/** 这一段多长；null = 不限时（正计时的专注、倒计时到点后和正计时自己休息时的休息） */
const segDurationMs = ref<number | null>(null);
const segPausedAt = ref<number | null>(null);
const elapsedMs = computed(() => Math.max(0, (segPausedAt.value ?? now.value) - segStartedAt.value));
const leftMs = computed(() => (segDurationMs.value === null ? null : Math.max(0, segDurationMs.value - elapsedMs.value)));
const paused = computed(() => segPausedAt.value !== null);
const running = computed(() => (phase.value === 'focus' || phase.value === 'break') && !paused.value);
/** 休息有没有定时（番茄钟的休息有；倒计时到点、正计时自己休息时没有，你点"继续"才接着学） */
const timedBreak = computed(() => phase.value === 'break' && segDurationMs.value !== null);
/** 学完的段数：番茄钟就是番茄个数 */
const blocks = ref(0);
const focusedMs = ref(0);
/** 倒计时完整走完过一次（约定算不算做到） */
const countdownDone = ref(false);
let ticker: ReturnType<typeof setInterval> | undefined;
let ending = false;

function startSegment(kind: 'focus' | 'break') {
  phase.value = kind;
  now.value = Date.now();
  segStartedAt.value = now.value;
  segPausedAt.value = null;
  if (kind === 'focus') segDurationMs.value = timerKind.value === 'pomodoro' ? focusMin.value * 60_000 : timerKind.value === 'countdown' ? countdownMin.value * 60_000 : null;
  else segDurationMs.value = timerKind.value === 'pomodoro' ? restMin.value * 60_000 : null;
  clearInterval(ticker);
  ticker = setInterval(tick, 1000);
  void services.native.keepAwake(true);
  if (kind === 'focus') {
    awayThisRound.value = 0;
    // 一起专注：她跟着这段专注走（休息时不算）；各自专注时她自己走，不动她的钟
    if (focusMode.value === 'together') herClock = now.value;
    planPeeks();
  } else peekAt = null;
}
function tick() {
  now.value = Date.now();
  if (phase.value !== 'focus' && phase.value !== 'break') return;
  if (focusMode.value === 'solo') herSoloTick();
  else if (phase.value === 'focus' && running.value) advanceHer();
  const herBusy = focusMode.value === 'solo' ? herSeg.kind === 'focus' : phase.value === 'focus' && running.value;
  if (herBusy) presenceTick();
  if (phase.value === 'focus' && running.value && peekAt !== null && now.value >= peekAt && document.visibilityState === 'visible') {
    peekAt = nextPeek();
    void drawMoment('peek', 'auto');
  }
  if (running.value && leftMs.value !== null && leftMs.value <= 0) void onSegmentEnd();
}
function togglePause() {
  if (phase.value !== 'focus') return;
  const t = Date.now();
  if (segPausedAt.value === null) {
    if (focusMode.value === 'together') advanceHer();
    segPausedAt.value = t;
  } else {
    segStartedAt.value += t - segPausedAt.value;
    if (peekAt !== null) peekAt += t - segPausedAt.value;
    segPausedAt.value = null;
    if (focusMode.value === 'together') herClock = t;
  }
  now.value = t;
}
function addFive() {
  if (segDurationMs.value !== null) segDurationMs.value += 5 * 60_000;
}
/** 番茄钟跳过休息；倒计时到点后、正计时休息时接着学 */
function resumeFocus() {
  if (phase.value === 'break') startSegment('focus');
}
/** 正计时：自己说休息一下 */
function restNow() {
  if (phase.value === 'focus') void endFocus('rest');
}

// —— 她的进度：她自己的节奏，有快有慢，偶尔卡住 ——
const herProgress = ref(0);
const herStuck = ref(false);
const herStuckTimes = ref(0);
/** 她卡住的还剩多久（按她自己的时间算） */
let stuckLeftMs = 0;
/** 她的进度算到了哪一刻（锁屏、切后台回来按经过的时间补算） */
let herClock = 0;
const herPlanMs = computed(() => (timerKind.value === 'pomodoro' ? plan.value * focusMin.value : timerKind.value === 'countdown' ? countdownMin.value : COUNTUP_PLAN_MIN) * 60_000);
/** 一起专注：专注时她跟着走 */
function advanceHer() {
  const t = Date.now();
  if (herClock && t > herClock) herTick(t - herClock);
  herClock = t;
}
/** 按经过的时间推进她的进度；时间一下子过去很多时按每分钟一步补算 */
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
  const perMs = 100 / Math.max(60_000, herPlanMs.value);
  herProgress.value = Math.min(100, herProgress.value + perMs * dtMs * (0.6 + Math.random() * 0.8));
}

// —— 各自专注：她自己的番茄（专注 45、休息 10），和你的计时没关系，你暂停、休息时她照样走 ——
const herSeg = reactive<{ kind: 'focus' | 'break'; startedAt: number; durationMs: number }>({ kind: 'focus', startedAt: 0, durationMs: HER_FOCUS_MIN * 60_000 });
const herBlocks = ref(0);
const herSegLeftMs = computed(() => Math.max(0, herSeg.startedAt + herSeg.durationMs - now.value));
function initHerSolo() {
  const t = Date.now();
  // 你来之前她已经学了一会儿
  const into = (5 + Math.random() * 20) * 60_000;
  Object.assign(herSeg, { kind: 'focus', startedAt: t - into, durationMs: HER_FOCUS_MIN * 60_000 });
  herBlocks.value = 0;
  herClock = t;
  herProgress.value = Math.min(30, (into / Math.max(60_000, herPlanMs.value)) * 80);
}
function herSoloTick() {
  const t = Date.now();
  // 切后台回来可能已经过了好几段：一段一段补
  for (let guard = 0; guard < 50 && t >= herSeg.startedAt + herSeg.durationMs; guard += 1) {
    const end = herSeg.startedAt + herSeg.durationMs;
    if (herSeg.kind === 'focus') {
      if (end > herClock) herTick(end - herClock);
      herBlocks.value += 1;
      Object.assign(herSeg, { kind: 'break', startedAt: end, durationMs: HER_REST_MIN * 60_000 });
      if (dozing.value) dozing.value = false;
      chars.setExpression(her.value.id, Math.random() < 0.5 ? 'smile' : 'sleepy');
    } else {
      Object.assign(herSeg, { kind: 'focus', startedAt: end, durationMs: HER_FOCUS_MIN * 60_000 });
      chars.setExpression(her.value.id, 'neutral');
    }
    herClock = end;
  }
  if (herSeg.kind === 'focus' && t > herClock) herTick(t - herClock);
  herClock = t;
}

// —— 她的小动作（本地，不说话）：换表情；专注久了偶尔打瞌睡，你可以叫醒她 ——
const dozing = ref(false);
let nextPresenceAt = 0;
function presenceTick() {
  const t = Date.now();
  if (dozing.value || t < nextPresenceAt) return;
  nextPresenceAt = t + (40 + Math.random() * 80) * 1000;
  if (t > lineUntil.value) {
    const focusedLong = focusMode.value === 'solo' ? t - herSeg.startedAt > 20 * 60_000 : focusedMs.value + elapsedMs.value > 20 * 60_000;
    if (focusedLong && Math.random() < 0.08) {
      dozing.value = true;
      chars.setExpression(her.value.id, 'sleep');
      // 这一段还没偷拍：现在就拍她睡着的样子
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
const herState = computed(() => {
  if (dozing.value) return `${her.value.pronoun}趴在桌上睡着了`;
  if (focusMode.value === 'solo' && herSeg.kind === 'break' && phase.value !== 'setup') return `${her.value.pronoun}在休息`;
  if (herStuck.value) return '卡住了';
  return '';
});

// —— 画面：这个场景的生图预设，画偷拍、奖励 ——
const MOMENTS = IMAGE_MOMENTS.study ?? {};
let peekAt: number | null = null;
/** 一起专注的背景（竖图）、各自专注上半屏的图（方图或横图）、学完的奖励图 */
const togetherArt = ref<GalleryItem | null>(null);
const soloArt = ref<GalleryItem | null>(null);
const rewardArt = ref<GalleryItem | null>(null);
/** 这一轮画的图：结束时放进学习卡片 */
const sessionArt = ref<GalleryItem[]>([]);
/** 画不出来的原因（没接通、自动画停着、出错）：写一行 */
const artIssue = ref<{ text: string; settings: boolean } | null>(null);
const drawingNow = computed(() => gallery.isDrawing(her.value.id, 'study'));
const stageText = (moment: string, stage: 'queued' | 'prompt' | 'image') => {
  const what = MOMENTS[moment] ?? '画面';
  return stage === 'queued' ? `${what}：排队等前一张画完` : stage === 'prompt' ? `${what}：正在写 tags` : `${what}：正在画`;
};
const drawingText = computed(() => {
  const d = drawingNow.value;
  if (d) return stageText(d.moment, d.stage);
  return mineDrawing.value ? `你这边：${mineDrawing.value}` : null;
});
/** 现在这种画面要的画幅 */
const artShape = computed<ImageShape>(() => (focusMode.value === 'solo' ? halfShape.value : 'portrait'));
function placeArt(item: GalleryItem) {
  if (item.moment === 'reward') rewardArt.value = item;
  else if (shapeOf(item) === 'portrait') togetherArt.value = item;
  else soloArt.value = item;
}
async function preview(item: { assetKey: string | null; url?: string } | null) {
  if (!item) return;
  const url = item.assetKey ? await assetUrl(item.assetKey) : (item.url ?? null);
  if (url) showImagePreview({ images: [url], closeable: true, showIndex: false });
  else showToast('本机找不到这张图了');
}

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
  const how = focusMode.value === 'solo' ? '各自专注' : '一起专注';
  return `在${place}，和${userName.value}连线自习、${how}（${userName.value}在${yourPlace.value || '自己那边'}）`;
}
function captionFor(m: Moment, extra?: string): string {
  if (m === 'peek') return [`${cue.value}中`, stateLine(), where(), extra].filter(Boolean).join('；');
  return [`今天一起学完了：${Math.round(focusedMs.value / 60_000)} 分钟`, keptLine(), where(), extra].filter(Boolean).join('；');
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
    size: m === 'reward' ? 'portrait' : artShape.value,
  });
  if (r.ok) {
    placeArt(r.item);
    sessionArt.value.push(r.item);
    artIssue.value = null;
    return r.item;
  }
  if (!r.busy) artIssue.value = { text: `没画出来：${r.reason}`, settings: /没接通/.test(r.reason) };
  return null;
}
/**
 * 专注开始：这种画面还没有图时，先找今天同一个地方、同一身衣服、同一种画幅画过的；没有就马上画一张。
 * 返回是不是马上开画了（开画了，这个番茄就不再中途偷拍）
 */
function ensureArt(): boolean {
  const size = artShape.value;
  const have = size === 'portrait' ? togetherArt.value : soloArt.value;
  if (have && shapeOf(have) === size) return false;
  const outfit = rhythm.outfitFor(her.value.id, 'study')?.name ?? null;
  const found = gallery
    .find(her.value.id, 'study', { today: true, locationId: location.value?.id ?? null, outfit, size })
    .find((i) => i.moment === 'peek' || i.moment === 'seat');
  if (found) {
    placeArt(found);
    return false;
  }
  const willDraw = gallery.autoCheck().ok;
  void drawMoment('peek', 'auto');
  return willDraw;
}
/** 这一段专注里什么时候偷拍：番茄钟每个番茄中间一张，正计时、倒计时大约每 25 分钟一张 */
function planPeeks() {
  const fresh = ensureArt();
  const t = Date.now();
  if (timerKind.value === 'pomodoro') peekAt = fresh ? null : t + focusMin.value * 60_000 * (0.35 + Math.random() * 0.4);
  else peekAt = t + PEEK_EVERY_MIN * 60_000 * (fresh ? 0.9 + Math.random() * 0.4 : 0.35 + Math.random() * 0.4);
  if (peekAt !== null && segDurationMs.value !== null && peekAt > segStartedAt.value + segDurationMs.value - 60_000) peekAt = null;
}
function nextPeek(): number | null {
  if (timerKind.value === 'pomodoro') return null;
  const next = Date.now() + PEEK_EVERY_MIN * 60_000 * (0.8 + Math.random() * 0.4);
  return segDurationMs.value !== null && next > segStartedAt.value + segDurationMs.value - 60_000 ? null : next;
}
function retryArt() {
  artIssue.value = null;
  void drawMoment('peek', 'user');
}
function toggleAutoDraw() {
  gallery.autoDraw = !gallery.autoDraw;
  showToast(gallery.autoDraw ? '自动画图开了：专注开始画一张、之后每个番茄偷拍一张、学完一张' : '自动画图关了：点"看一眼"时才画');
  if (gallery.autoDraw && (phase.value === 'focus' || phase.value === 'break') && !drawingNow.value) ensureArt();
}
/** 这次画的图：点一张从它开始翻 */
async function previewSession(start: number) {
  const urls = await Promise.all(sessionArt.value.map(async (i) => (i.assetKey ? await assetUrl(i.assetKey) : (i.url ?? null))));
  const images = urls.filter((u): u is string => !!u);
  if (images.length) showImagePreview({ images, startPosition: Math.min(start, images.length - 1), closeable: true });
  else showToast('本机找不到这几张图了');
}

// —— 你这边的画面（各自专注的下半屏）：照片 / 按你的人设画 / 摄像头（后续） ——
const mineOpen = ref(false);
const mineDrawing = ref<string | null>(null);
const mineIssue = ref<{ text: string; settings: boolean } | null>(null);
const mineTags = computed({
  get: () => mine.tags[persona.value.id] ?? '',
  set: (v: string) => {
    mine.tags[persona.value.id] = v;
  },
});
/** 按现在这个人设画过的那张 */
const mineArt = computed(() => (mine.drawn && mine.drawn.personaId === persona.value.id ? mine.drawn : null));
const mineSummary = computed(() => {
  if (mine.source === 'photo') return mine.photoKey ? '用你上传的照片' : '照片还没上传';
  if (mine.source === 'persona') return mineArt.value ? `按「${persona.value.name}」的人设画的` : `按「${persona.value.name}」的人设画一张（开始时自动画）`;
  if (mine.source === 'camera') return '摄像头后续支持';
  return '还没设置：放一张照片，或按你的人设画';
});
function dataUrlBytes(dataUrl: string): { bytes: Uint8Array<ArrayBuffer>; mime: string } {
  const [head = '', b64 = ''] = dataUrl.split(',');
  const bin = atob(b64);
  const bytes = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return { bytes, mime: /data:([^;,]+)/.exec(head)?.[1] ?? 'image/jpeg' };
}
async function pickPhoto(file: File) {
  try {
    const { bytes, mime } = dataUrlBytes(await compressImage(file, { max: 1600 }));
    mine.photoKey = await putAsset(bytes, mime);
    mine.source = 'photo';
    showToast('放好了：各自专注时显示在下半屏');
  } catch {
    showToast('这张图读不出来，换一张试试');
  }
}
function mineCaption(): string {
  const place = yourPlace.value || '自己那边';
  const desc = persona.value.description.trim();
  return [`${userName.value}在${place}的书桌前学习`, desc ? `${userName.value}的人设：${desc}` : '', `${her.value.name}在${herWhere.value}，隔着屏幕陪着（不在画面里）`].filter(Boolean).join('；');
}
async function drawMine(priority: 'user' | 'auto') {
  if (mineDrawing.value) return;
  if (priority === 'auto' && !gallery.autoCheck().ok) return;
  if (!services.image.live) {
    mineIssue.value = { text: '生图 API 还没接通', settings: true };
    return;
  }
  mineIssue.value = null;
  mineDrawing.value = '排队等前一张画完';
  const size = halfShape.value;
  const personaId = persona.value.id;
  try {
    const out = await services.image.illustrate(
      {
        characterId: her.value.id,
        caption: mineCaption(),
        use: sceneImageUse('study'),
        moment: 'mine',
        sceneId: 'study',
        place: yourPlace.value || '家',
        size,
        subject: { name: userName.value, appearanceTags: mineTags.value.trim() },
      },
      { priority, onStage: (s) => (mineDrawing.value = s === 'queued' ? '排队等前一张画完' : s === 'prompt' ? '正在写 tags' : '正在画') },
    );
    mine.drawn = { assetKey: out.assetKey, ...(out.url ? { url: out.url } : {}), title: out.caption, size, personaId, at: Date.now() };
  } catch (e) {
    mineIssue.value = { text: `没画出来：${errorText(e)}`, settings: false };
  } finally {
    mineDrawing.value = null;
  }
}

// —— 她说的话：都来自「陪伴 · 快速」，存进聊天；你说的话显示在你那边的气泡里 ——
const herLine = ref('');
const lineUntil = ref(0);
const myLine = ref('');
const myLineUntil = ref(0);
const notConnected = ref('');
const stream = computed(() => (chatId.value ? chat.streams[chatId.value] : undefined));
const streamingText = computed(() => (stream.value ? (chat.list(chatId.value).find((m) => m.id === stream.value!.messageId)?.text ?? '') : ''));
const cue = computed(() => {
  if (phase.value === 'setup') return '开场';
  if (phase.value === 'done') return '结束';
  const n = blocks.value;
  if (phase.value === 'focus') return timerKind.value === 'pomodoro' ? `第 ${n + 1} 个番茄` : timerKind.value === 'countdown' ? `倒计时第 ${n + 1} 段` : `正计时第 ${n + 1} 段`;
  return timerKind.value === 'pomodoro' ? `第 ${n} 个番茄后休息` : `第 ${n} 段专注后休息`;
});
const shownLine = computed(() => {
  if (streamingText.value) return streamingText.value;
  if (!herLine.value) return '';
  if (phase.value === 'focus' && now.value > lineUntil.value) return '';
  return herLine.value;
});
const shownMine = computed(() => (myLine.value && now.value < myLineUntil.value ? myLine.value : ''));
function sayMine(text: string) {
  myLine.value = text;
  myLineUntil.value = Date.now() + LINE_MS;
  now.value = Date.now();
}
const chatLink = computed(() => `/chat/${chatId.value}?mode=stage`);

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
function timerLine(): string {
  if (timerKind.value === 'pomodoro') return `计时：番茄钟，${plan.value} 个，每个 ${focusMin.value} 分钟，休息 ${restMin.value} 分钟`;
  if (timerKind.value === 'countdown') return `计时：倒计时 ${countdownMin.value} 分钟（到点再决定继续还是结束）`;
  return '计时：正计时（不定时长，累了自己说休息，学完自己说结束）';
}
function modeLine(): string {
  if (focusMode.value === 'together') return '专注方式：一起专注——共用一个计时器，到点一起休息';
  const into = Math.round((Date.now() - herSeg.startedAt) / 60_000);
  return `专注方式：各自专注——各用各的计时器；${her.value.name}按自己的节奏（专注 ${HER_FOCUS_MIN} 分钟、休息 ${HER_REST_MIN} 分钟），${userName.value}来之前${her.value.pronoun}已经学了 ${into} 分钟`;
}
/** 各自专注时她这会儿在干嘛（给她说话时参考） */
function herSoloLine(): string {
  if (focusMode.value !== 'solo') return '';
  const left = Math.ceil(herSegLeftMs.value / 60_000);
  return herSeg.kind === 'focus'
    ? `各自专注：${her.value.name}自己还在专注（${her.value.pronoun}的第 ${herBlocks.value + 1} 个番茄，还剩 ${left} 分钟），小声说就好`
    : `各自专注：${her.value.name}正好也在休息（还剩 ${left} 分钟）`;
}
function goalReached(): boolean {
  if (timerKind.value === 'pomodoro') return blocks.value >= plan.value;
  if (timerKind.value === 'countdown') return countdownDone.value;
  return focusedMs.value >= COUNTUP_PROMISE_MIN * 60_000;
}
function keptLine(): string {
  return promise.value.trim() ? `约定"${promise.value.trim()}"${goalReached() ? '做到了' : '没做到'}` : '';
}

async function begin() {
  if (!chatId.value) return;
  // 白噪声：上次开着的接着放（点"开始"是一次点击，浏览器允许出声）
  if (noise.value) void ambience.start(mixOf(noise.value, volume.value));
  if (focusMode.value === 'solo') initHerSolo();
  startSegment('focus');
  if (focusMode.value === 'solo' && mine.source === 'persona' && !mineArt.value) void drawMine('auto');
  await reply('study-start', [
    `${userName.value}今天要学：${tasks.value.map((t) => t.text).join('、') || '没说'}`,
    `${userName.value}的状态：${MOODS.find((m) => m.id === mood.value)?.label}`,
    timerLine(),
    modeLine(),
    promise.value.trim() ? `约定：${promise.value.trim()}` : '',
    `${her.value.name}今天手头的事：${herGoal.value}`,
  ]);
}

async function onSegmentEnd() {
  if (ending) return;
  if (phase.value === 'focus') await endFocus('timer');
  else if (phase.value === 'break') startSegment('focus');
}
/** 一段专注结束：番茄 / 倒计时到点（timer），或者正计时你说休息（rest） */
async function endFocus(why: 'timer' | 'rest') {
  if (ending) return;
  ending = true;
  try {
    if (focusMode.value === 'together') advanceHer();
    const spent = why === 'timer' && segDurationMs.value !== null ? segDurationMs.value : elapsedMs.value;
    focusedMs.value += spent;
    blocks.value += 1;
    if (why === 'timer' && timerKind.value === 'countdown') countdownDone.value = true;
    services.native.vibrate([20, 60, 20]);
    dozing.value = false;
    startSegment('break');
    const notes = pendingNotes.splice(0);
    const minutes = Math.round(spent / 60_000);
    const what =
      timerKind.value === 'pomodoro'
        ? `第 ${blocks.value} 个番茄结束（${focusMin.value} 分钟）`
        : timerKind.value === 'countdown'
          ? `倒计时 ${minutes} 分钟到了（今天第 ${blocks.value} 段）`
          : `${userName.value}正计时学了 ${minutes} 分钟，说要休息一下`;
    await reply('study-break', [
      what,
      `${userName.value}已完成：${doneText() || '还没有'}；还没完成：${todoText() || '没有了'}`,
      awayThisRound.value ? `${userName.value}这段中途离开了 ${awayThisRound.value} 次${playedThisRound.value ? `，其中 ${playedThisRound.value} 次说是去玩了` : ''}` : '',
      notes.length ? `${userName.value}传来的纸条：${notes.map((n) => `「${n}」`).join(' ')}` : '',
      `${her.value.name}的进度：${Math.round(herProgress.value)}%${herStuck.value ? '，现在卡住了' : herStuckTimes.value ? '，中途卡住过' : ''}`,
      herSoloLine(),
    ]);
    playedThisRound.value = 0;
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
  showToast(`纸条递过去了，${her.value.pronoun}休息时回你`);
}

// —— 我卡住了：你那边的气泡；她的回答出现在她那边 ——
const stuckOpen = ref(false);
const stuckText = ref('');
async function askHelp() {
  const t = stuckText.value.trim();
  if (!t) return;
  stuckOpen.value = false;
  stuckText.value = '';
  sayMine(t);
  await reply('study-stuck', [`专注中（${cue.value}），${userName.value}卡住了`, herSoloLine()], t);
}

// —— 休息时聊天 ——
const chatText = ref('');
async function sendChat() {
  const t = chatText.value.trim();
  if (!t || stream.value) return;
  chatText.value = '';
  sayMine(t);
  await reply('study-chat', [`休息中（${cue.value}）`, herSoloLine()], t);
}

// —— 你的任务：专注时点右下角的卡片勾掉、加新的 ——
const tasksOpen = ref(false);

// —— 白噪声：本机合成（services/ambience.ts），不联网、不用 API ——
const noiseOpen = ref(false);
const noisePlaying = computed(() => ambience.state.playing && !ambience.state.fading);
function mixOf(kind: NoiseKind, v: number): NoiseMix {
  return { rain: 0, fire: 0, waves: 0, fan: 0, [kind]: v };
}
/** 在点击里调用（浏览器只允许点了以后出声） */
function pickNoise(kind: NoiseKind | null) {
  noise.value = kind;
  if (!kind) ambience.stop();
  else void ambience.start(mixOf(kind, volume.value));
}
watch(volume, (v) => {
  if (noise.value && ambience.state.playing) ambience.setMix(mixOf(noise.value, v));
});
const noiseIcon = computed(() => (noisePlaying.value && noise.value ? NOISE_LABEL[noise.value].icon : 'i-lucide-audio-lines'));
const noiseText = computed(() => (ambience.state.loading ? '准备中' : noisePlaying.value && noise.value ? NOISE_LABEL[noise.value].label : '白噪声'));

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

// —— 计时器上显示什么 ——
const display = computed(() => {
  const focus = phase.value === 'focus';
  const left = leftMs.value;
  // 有终点的显示剩下的，不限时的（正计时、自己休息）显示过了多久
  const sec = left === null ? Math.floor(elapsedMs.value / 1000) : Math.ceil(left / 1000);
  const total = segDurationMs.value === null ? (focus ? 3600 : 600) : segDurationMs.value / 1000;
  const kind = timerKind.value === 'pomodoro' ? `第 ${blocks.value + 1} 个番茄` : timerKind.value === 'countdown' ? '倒计时' : '正计时';
  const timeUp = !focus && !timedBreak.value && timerKind.value === 'countdown';
  return {
    sec,
    total,
    countUp: left === null,
    /** 圆环里（一起专注） */
    ring: focus ? (paused.value ? `暂停中 · ${kind}` : `一起专注 · ${kind}`) : timeUp ? '时间到 · 一起休息' : '一起休息',
    /** 你那块长方形里（各自专注；右边有按钮，字要短） */
    mine: focus ? (paused.value ? '暂停中' : kind) : timeUp ? '时间到 · 休息' : '休息一下',
    tone: focus ? FOCUS_TONE : 'var(--good)',
    fraction: left === null || !segDurationMs.value ? null : elapsedMs.value / segDurationMs.value,
  };
});

// —— 结束 ——
const diary = ref('');
async function finish() {
  if (!chatId.value) return;
  try {
    await showConfirmDialog({ title: '今天就学到这里？', confirmButtonText: '结束', cancelButtonText: '再学一会' });
  } catch {
    return;
  }
  if (phase.value === 'focus') {
    if (focusMode.value === 'together') advanceHer();
    focusedMs.value += elapsedMs.value;
    // 没走完的番茄不算一个；倒计时、正计时学了一分钟以上就算一段
    if (timerKind.value !== 'pomodoro' && elapsedMs.value >= 60_000) blocks.value += 1;
  }
  clearInterval(ticker);
  segPausedAt.value = null;
  void services.native.keepAwake(false);
  if (ambience.state.playing) void ambience.fadeOut(3);
  phase.value = 'done';
  dozing.value = false;
  awayAsk.value = false;
  noiseOpen.value = false;
  const minutes = Math.round(focusedMs.value / 60_000);
  const kept = goalReached();
  const msg = await reply('study-end', [
    `结束：一共专注 ${minutes} 分钟${timerKind.value === 'pomodoro' ? `，${blocks.value} 个番茄（计划 ${plan.value} 个）` : timerKind.value === 'countdown' ? `（倒计时 ${countdownMin.value} 分钟${countdownDone.value ? '，走完了' : '，没走完就结束了'}）` : '（正计时）'}`,
    focusMode.value === 'solo' ? `各自专注：${her.value.name}自己学了 ${herBlocks.value} 个番茄` : '一起专注',
    `${userName.value}完成了：${doneText() || '没有勾掉任务'}；没完成：${todoText() || '没有'}`,
    awayTotal.value ? `中途离开 ${awayTotal.value} 次` : '',
    promise.value.trim() ? `约定：${promise.value.trim()}（${kept ? '做到了' : '没做到'}）` : '',
    `${her.value.name}的进度：${Math.round(herProgress.value)}%`,
  ]);
  diary.value = msg?.text.split(/日记[:：]/)[1]?.trim() ?? '';
  const card: MessagePart = {
    type: 'study',
    logId: uid('study'),
    pomodoros: blocks.value,
    minutes,
    timer: timerKind.value,
    together: focusMode.value === 'together',
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
/** 学完时她那句话：日记单独放在下面，气泡里只放前面的 */
const doneLine = computed(() => (streamingText.value || herLine.value).split(/日记[:：]/)[0]?.trim() ?? '');
function again() {
  const loc = location.value;
  if (loc) chat.enterScene(her.value.id, loc.id, 'study');
  phase.value = 'setup';
  blocks.value = 0;
  focusedMs.value = 0;
  countdownDone.value = false;
  awayTotal.value = 0;
  herProgress.value = 0;
  herStuck.value = false;
  herStuckTimes.value = 0;
  herLine.value = '';
  myLine.value = '';
  diary.value = '';
  rewardArt.value = null;
  sessionArt.value = [];
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
const todayMinutes = computed(() => studyCards.value.filter((c) => dayKey(c.at) === dayKey(Date.now())).reduce((n, c) => n + c.p.minutes, 0));

onMounted(() => {
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('resize', onResize);
});
onBeforeUnmount(() => {
  clearInterval(ticker);
  document.removeEventListener('visibilitychange', onVisibility);
  window.removeEventListener('resize', onResize);
  void services.native.keepAwake(false);
  ambience.stop();
});

/** 立绘放哪：分屏时在上半屏；一起专注没图时坐在计时器下面（像隔着桌子坐你对面）；各自专注没图时在上半屏右边 */
const figureLayout = computed(() => {
  if (view.value === 'split') return { left: 50, bottom: 50, height: 46 };
  if (view.value === 'together') return { left: 50, bottom: -30, height: 76 };
  return { left: 72, bottom: 50, height: 40 };
});
const figureHidden = computed(() => {
  if (view.value === 'together') return !!togetherArt.value;
  if (view.value === 'solo') return !!soloArt.value;
  return phase.value === 'done' && !!rewardArt.value;
});
const herPct = computed(() => Math.round(herProgress.value));
</script>

<template>
  <SceneShell
    scene-id="study"
    bare
    pose="study"
    :rain="noisePlaying && noise === 'rain'"
    :layout="figureLayout"
    :hide-figure="figureHidden"
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
      <div class="study" :class="`v-${view}`" :style="{ '--ring': `${ringSize}px` }" :data-view="view">
        <!-- ============ 开始前 / 学完：上下各一半 ============ -->
        <template v-if="view === 'split'">
          <Transition name="fade">
            <button v-if="phase === 'done' && rewardArt" :key="rewardArt.id" type="button" class="half-art top" :aria-label="`看大图：${rewardArt.title}`" @click="preview(rewardArt)">
              <AssetImg :asset-key="rewardArt.assetKey" :url="rewardArt.url" :alt="rewardArt.title" />
            </button>
          </Transition>

          <!-- 她那边的计划：半透明的框压在立绘上 -->
          <div v-if="phase === 'setup'" class="plan" data-testid="her-plan">
            <div class="flex items-center gap-2.5">
              <Avatar :character="her" :size="34" live />
              <div class="flex-1 min-w-0">
                <div class="text-[12px] text-ink-2 truncate">{{ herHeading }}</div>
                <div class="text-[14.5px] leading-snug mt-0.5"><span class="text-ink-2">今天要做：</span>{{ herGoal || '还没定' }}</div>
              </div>
            </div>
            <div v-if="herSlot" class="plan-slots">
              <span class="slot now"><span class="num">{{ herSlot.from }}–{{ herSlot.to }}</span>{{ herSlot.status }}</span>
              <span v-if="herNext" class="slot"><span class="num">{{ herNext.from }}</span>{{ herNext.status }}</span>
            </div>
          </div>
          <div v-else-if="doneLine || stream" class="done-say">
            <StudyBubble side="her" :text="doneLine" :typing="!!stream && !streamingText" :to="chatLink" :label="`去和${her.name}聊天`" />
          </div>

          <section class="split-panel" :aria-label="phase === 'setup' ? '你的安排' : '今天学完了'">
            <div class="split-scroll">
              <div v-if="notConnected" class="notice">
                <span class="i-lucide-plug-zap shrink-0" />
                <span class="flex-1 min-w-0">{{ notConnected }}</span>
                <button class="text-accent-ink shrink-0" @click="router.push('/me/api?feature=companion')">去设置</button>
              </div>
              <div v-if="artIssue && phase === 'done'" class="notice">
                <span class="i-lucide-image-off shrink-0" />
                <span class="flex-1 min-w-0">{{ artIssue.text }}</span>
                <button v-if="artIssue.settings" class="text-accent-ink shrink-0" @click="router.push('/me/api?feature=image')">去设置</button>
              </div>

              <!-- 开始前：你的安排 -->
              <template v-if="phase === 'setup'">
                <div class="label first">怎么专注</div>
                <Segmented v-model="focusMode" :options="FOCUS_OPTIONS" />
                <p class="hint">
                  {{ focusMode === 'together' ? `共用一个计时器，到点一起休息；专注时画面是${her.pronoun}专心的样子` : `上下分屏，各用各的计时器：${her.pronoun}按自己的节奏（${HER_FOCUS_MIN} / ${HER_REST_MIN} 分钟），你按你的` }}
                </p>
                <button v-if="focusMode === 'solo'" type="button" class="mine-row" data-testid="mine-row" @click="mineOpen = true">
                  <span class="mine-thumb">
                    <AssetImg v-if="mine.source === 'photo' && mine.photoKey" :asset-key="mine.photoKey" alt="" />
                    <AssetImg v-else-if="mine.source === 'persona' && mineArt" :asset-key="mineArt.assetKey" :url="mineArt.url" alt="" />
                    <PersonaAvatar v-else :persona="persona" :size="40" />
                  </span>
                  <span class="flex-1 min-w-0 text-left">
                    <span class="block text-[13.5px]">下半屏 · 你这边的画面</span>
                    <span class="block text-[12px] text-ink-3 truncate">{{ mineSummary }}</span>
                  </span>
                  <span class="i-lucide-chevron-right text-ink-3 shrink-0" />
                </button>

                <div class="label">计时</div>
                <Segmented v-model="timerKind" :options="TIMER_OPTIONS" />
                <div v-if="timerKind === 'pomodoro'" class="flex gap-2 items-center flex-wrap mt-2.5">
                  <button v-for="(L, k) in LENGTHS" :key="k" type="button" class="chip" :class="{ on: length === k }" @click="length = k">{{ L.label }}</button>
                  <van-stepper v-model="plan" :min="1" :max="12" integer button-size="26px" />
                  <span class="text-[12.5px] text-ink-3">个</span>
                </div>
                <div v-else-if="timerKind === 'countdown'" class="flex gap-2 items-center flex-wrap mt-2.5">
                  <button v-for="m in COUNTDOWNS" :key="m" type="button" class="chip num" :class="{ on: countdownMin === m }" @click="countdownMin = m">{{ m }}</button>
                  <van-stepper v-model="countdownMin" :min="5" :max="180" :step="5" integer button-size="26px" input-width="40px" />
                  <span class="text-[12.5px] text-ink-3">分钟</span>
                </div>
                <p v-else class="hint">从 0 往上数，学多久都行：累了点"休息"，学完点"结束"</p>

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
                <div class="label">约定（可以不写）</div>
                <input v-model="promise" class="field w-full" placeholder="例如：学满 4 个番茄一起去吃砂锅粥" aria-label="约定" />
              </template>

              <!-- 学完 -->
              <template v-else>
                <div class="text-[16px] font-700">今天一起学了 {{ Math.round(focusedMs / 60000) }} 分钟<template v-if="timerKind === 'pomodoro'"> · {{ blocks }} 个番茄</template></div>
                <div class="text-[12.5px] text-ink-3 mt-1">
                  {{ focusMode === 'together' ? '一起专注' : '各自专注' }} · 完成 {{ doneCount }} / {{ tasks.length }} 个任务<template v-if="awayTotal"> · 离开 {{ awayTotal }} 次</template><template v-if="promise.trim()"> · 约定{{ goalReached() ? '做到了' : '没做到' }}</template> · {{ her.pronoun }}的进度 {{ herPct }}%
                </div>
                <div v-if="diary" class="diary"><span class="i-lucide-notebook-pen text-accent-ink" /> {{ diary }}</div>
                <div v-if="sessionArt.length" class="shots" aria-label="这次画的图">
                  <button v-for="(i, n) in sessionArt" :key="i.id" type="button" class="shot" :aria-label="`看大图：${i.title}`" @click="previewSession(n)">
                    <AssetImg :asset-key="i.assetKey" :url="i.url" :alt="i.title" />
                  </button>
                </div>
              </template>

              <div class="stamps">
                <div v-for="d in week" :key="d.key" class="stamp" :class="{ on: d.on }">
                  <span v-if="d.on" class="i-lucide-check" />
                  <span class="text-[11px]">{{ d.label }}</span>
                </div>
              </div>
              <div class="stats num">
                今天学了 {{ todayMinutes }} 分钟<template v-if="streak"> · 连续 {{ streak }} 天</template><template v-if="weekMinutes"> · 这周一起学了 {{ Math.round(weekMinutes / 6) / 10 }} 小时</template>
              </div>
            </div>
            <div class="split-foot">
              <van-button v-if="phase === 'setup'" type="primary" round block data-testid="begin" @click="begin">开始{{ focusMode === 'together' ? '一起专注' : '各自专注' }}</van-button>
              <div v-else class="flex gap-2.5">
                <van-button round block @click="again">再学一轮</van-button>
                <van-button type="primary" round block @click="router.push(`/chat/${chatId}`)">回聊天</van-button>
              </div>
            </div>
          </section>
        </template>

        <!-- ============ 专注 / 休息 ============ -->
        <template v-else>
          <!-- 画面层：一起专注整屏竖图；各自专注上半屏她的图、下半屏你这边 -->
          <template v-if="view === 'together'">
            <Transition name="fade">
              <button v-if="togetherArt" :key="togetherArt.id" type="button" class="full-art" :aria-label="`看大图：${togetherArt.title}`" @click="preview(togetherArt)">
                <AssetImg :asset-key="togetherArt.assetKey" :url="togetherArt.url" :alt="togetherArt.title" />
              </button>
            </Transition>
          </template>
          <template v-else>
            <Transition name="fade">
              <button v-if="soloArt" :key="soloArt.id" type="button" class="half-art top" :aria-label="`看大图：${soloArt.title}`" @click="preview(soloArt)">
                <AssetImg :asset-key="soloArt.assetKey" :url="soloArt.url" :alt="soloArt.title" />
              </button>
            </Transition>
            <div class="half bottom">
              <MineView :source="mine.source" :photo-key="mine.photoKey" :art="mineArt" :persona="persona" :drawing="mineDrawing" @open="mineOpen = true" />
            </div>
            <div class="pitch" aria-hidden="true"><span class="midline" /><span class="circle" /></div>
          </template>
          <div class="shade top" aria-hidden="true" />
          <div class="shade bottom" aria-hidden="true" />

          <!-- 左上：她的任务与进度，下面是她说的话 -->
          <div class="her-col">
            <div class="her-card" data-testid="her-card">
              <div class="flex items-center gap-2">
                <Avatar :character="her" :size="24" live />
                <span class="flex-1 min-w-0 text-[12px] text-ink-2 truncate">{{ her.name }} · {{ herWhere }}</span>
                <span class="num text-[12px] text-accent-ink shrink-0">{{ herPct }}%</span>
              </div>
              <div class="card-task">{{ herGoal || '在学自己的东西' }}</div>
              <span class="bar" aria-hidden="true"><span :style="{ width: `${herPct}%` }" /></span>
              <div v-if="herState" class="text-[11.5px] text-accent-ink mt-1">{{ herState }}</div>
            </div>
            <StudyBubble v-if="shownLine || stream" side="her" :text="shownLine" :typing="!!stream && !streamingText" :to="chatLink" :label="`去和${her.name}聊天`" />
            <div v-if="notConnected" class="mini-notice">
              <span class="i-lucide-plug-zap shrink-0" /><span class="flex-1 min-w-0">{{ notConnected }}</span>
              <button class="text-accent-ink shrink-0" @click="router.push('/me/api?feature=companion')">去设置</button>
            </div>
            <div v-if="artIssue" class="mini-notice" data-testid="art-issue">
              <span class="i-lucide-image-off shrink-0" /><span class="flex-1 min-w-0">{{ artIssue.text }}</span>
              <button v-if="artIssue.settings" class="text-accent-ink shrink-0" @click="router.push('/me/api?feature=image')">去设置</button>
              <button v-else class="text-accent-ink shrink-0" @click="retryArt">重试</button>
            </div>
          </div>

          <!-- 中间：一起专注是一个圆形共用计时器；各自专注是一上一下两块长方形计时器 -->
          <div v-if="view === 'together'" class="ring-zone">
            <div class="ring-disc" role="timer" :aria-label="`共用计时器：${clock(display.sec)}，${display.ring}`" data-testid="ring">
              <TimerRing :remain-sec="display.sec" :total-sec="display.total" :count-up="display.countUp" :size="ringSize" :label="display.ring" :tone="display.tone">
                <TimerControls class="mt-2" :phase="phase === 'focus' ? 'focus' : 'break'" :paused="paused" :kind="timerKind" :timed-break="timedBreak" @toggle="togglePause" @add="addFive" @rest="restNow" @resume="resumeFocus" @finish="finish" />
              </TimerRing>
            </div>
            <div v-if="awayAsk" class="away" role="alert">
              <div class="text-[13.5px]">刚才离开了一会儿，是去查资料，还是去玩了？</div>
              <div class="flex gap-2 mt-2 justify-center">
                <van-button size="small" round @click="answerAway(false)">查资料</van-button>
                <van-button size="small" round @click="answerAway(true)">去玩了</van-button>
              </div>
            </div>
          </div>
          <template v-else>
            <div class="duo-slot her" data-testid="duo-her">
              <DuoTimer
                side="her"
                :who="`${her.name} · ${herWhere}`"
                :time="clock(Math.ceil(herSegLeftMs / 1000))"
                :state="herSeg.kind === 'focus' ? (dozing ? '趴着睡着了' : herStuck ? '卡住了' : `专注中 · 第 ${herBlocks + 1} 个番茄`) : '休息中'"
                :fraction="(now - herSeg.startedAt) / herSeg.durationMs"
                :tone="herSeg.kind === 'focus' ? her.accent : 'var(--good)'"
              />
            </div>
            <div class="duo-slot me" data-testid="duo-me">
              <DuoTimer side="me" :who="yourPlace ? `我 · ${yourPlace}` : '我'" :time="clock(display.sec)" :state="display.mine" :fraction="display.fraction" :tone="display.tone">
                <TimerControls :phase="phase === 'focus' ? 'focus' : 'break'" :paused="paused" :kind="timerKind" :timed-break="timedBreak" @toggle="togglePause" @add="addFive" @rest="restNow" @resume="resumeFocus" @finish="finish" />
              </DuoTimer>
              <div v-if="awayAsk" class="away" role="alert">
                <div class="text-[13.5px]">刚才离开了一会儿，是去查资料，还是去玩了？</div>
                <div class="flex gap-2 mt-2 justify-center">
                  <van-button size="small" round @click="answerAway(false)">查资料</van-button>
                  <van-button size="small" round @click="answerAway(true)">去玩了</van-button>
                </div>
              </div>
            </div>
          </template>

          <!-- 右下：你的任务与进度（有的话），"我卡住了"是它上面的气泡 -->
          <div class="me-col">
            <StudyBubble v-if="shownMine" side="me" :text="shownMine" label="你刚说的" />
            <StudyBubble v-else-if="phase === 'focus'" side="me" label="我卡住了：问问她" data-testid="stuck-bubble" @click="stuckOpen = true">
              <span class="inline-flex items-center gap-1.5"><span class="i-lucide-message-circle-question text-accent-ink" />我卡住了</span>
            </StudyBubble>
            <button v-if="tasks.length" type="button" class="my-card" data-testid="my-card" aria-label="你的任务：点开勾掉、加新的" @click="tasksOpen = true">
              <span class="flex items-center gap-2">
                <span class="flex-1 min-w-0 text-[12px] text-ink-2 text-left truncate">我 · 这次要完成</span>
                <span class="num text-[12px] text-accent-ink shrink-0">{{ doneCount }} / {{ tasks.length }}</span>
              </span>
              <span class="card-task text-left">{{ currentTask }}</span>
              <span class="bar" aria-hidden="true"><span :style="{ width: `${Math.round((doneCount / tasks.length) * 100)}%` }" /></span>
            </button>
            <button v-else type="button" class="ghost-pill" @click="tasksOpen = true"><span class="i-lucide-plus" />加个任务</button>
          </div>

          <!-- 最下面：白噪声、传纸条、看她一眼，和顶栏对着；休息时换成聊天 -->
          <nav class="bottom-bar" aria-label="专注时的小动作" data-testid="bottom-bar">
            <button type="button" class="pill" :class="{ on: noisePlaying }" :aria-expanded="noiseOpen" aria-label="白噪声" @click="noiseOpen = !noiseOpen">
              <span :class="[noiseIcon, { spin: ambience.state.loading }]" class="shrink-0" /><span>{{ noiseText }}</span>
            </button>
            <template v-if="phase === 'focus'">
              <span class="flex-1" />
              <button type="button" class="pill" @click="noteOpen = true"><span class="i-lucide-sticky-note shrink-0" /><span>传纸条</span></button>
              <button v-if="dozing" type="button" class="pill" @click="wakeHer"><span class="i-lucide-bell shrink-0" /><span>叫醒{{ her.pronoun }}</span></button>
              <button v-else type="button" class="pill" :disabled="drawingNow?.priority === 'user'" data-testid="look-at-her" @click="lookAtHer">
                <span :class="drawingNow?.priority === 'user' ? 'i-lucide-loader-circle spin' : 'i-lucide-eye'" class="shrink-0" /><span>{{ drawingNow?.priority === 'user' ? '在看…' : `看${her.pronoun}一眼` }}</span>
              </button>
            </template>
            <form v-else class="chat-form" @submit.prevent="sendChat">
              <input v-model="chatText" class="chat-input" :placeholder="`休息一下，和${her.pronoun}说点什么`" aria-label="休息时聊天" enterkeyhint="send" />
              <button type="submit" class="pill icon" :disabled="!!stream || !chatText.trim()" aria-label="发送"><span class="i-lucide-send" /></button>
            </form>
          </nav>
          <template v-if="noiseOpen">
            <div class="pop-catcher" @click="noiseOpen = false" />
            <div class="noise-pop" role="dialog" aria-label="白噪声">
              <div class="flex gap-2 flex-wrap">
                <button type="button" class="chip" :class="{ on: !noisePlaying }" @click="pickNoise(null)"><span class="i-lucide-volume-x" />关</button>
                <button v-for="k in NOISE_KINDS" :key="k" type="button" class="chip" :class="{ on: noisePlaying && noise === k }" :aria-pressed="noisePlaying && noise === k" @click="pickNoise(k)">
                  <span :class="NOISE_LABEL[k].icon" />{{ NOISE_LABEL[k].label }}
                </button>
              </div>
              <div class="flex items-center gap-3 mt-3 px-1">
                <span class="i-lucide-volume-2 text-ink-3 shrink-0" />
                <van-slider v-model="volume" class="flex-1" bar-height="4px" button-size="16px" aria-label="白噪声音量" />
              </div>
              <p v-if="ambience.state.error" class="text-[12px] text-bad mt-2 mb-0">{{ ambience.state.error }}</p>
              <p class="text-[11.5px] text-ink-3 mt-2 mb-0">在这台设备上合成，不联网、不用流量</p>
            </div>
          </template>
        </template>

        <!-- 弹窗 -->
        <van-popup v-model:show="noteOpen" position="bottom" round>
          <div class="sheet">
            <div class="sheet-title mb-2">传一张纸条</div>
            <textarea v-model="noteText" class="area" rows="3" :placeholder="`${her.pronoun}休息时回你，计时不停`" aria-label="纸条" />
            <van-button type="primary" round block class="!mt-2" @click="sendNote">递过去</van-button>
          </div>
        </van-popup>
        <van-popup v-model:show="stuckOpen" position="bottom" round>
          <div class="sheet">
            <div class="sheet-title mb-2">哪里卡住了？</div>
            <textarea v-model="stuckText" class="area" rows="3" placeholder="写下题目或者不懂的地方" aria-label="卡住的地方" />
            <van-button type="primary" round block class="!mt-2" @click="askHelp">问{{ her.pronoun }}</van-button>
          </div>
        </van-popup>
        <van-popup v-model:show="tasksOpen" position="bottom" round>
          <div class="sheet">
            <div class="sheet-title mb-1">这次要完成<span v-if="tasks.length" class="num text-[13px] text-ink-3 font-400"> · {{ doneCount }} / {{ tasks.length }}</span></div>
            <label v-for="(t, i) in tasks" :key="i" class="task">
              <van-checkbox v-model="t.done" icon-size="18px" />
              <span :class="{ 'line-through text-ink-3': t.done }">{{ t.text }}</span>
            </label>
            <div class="flex gap-2 mt-2">
              <input v-model="newTask" class="field" placeholder="加一个任务" aria-label="新任务" @keydown.enter="addTask" />
              <van-button size="small" round @click="addTask">添加</van-button>
            </div>
          </div>
        </van-popup>
        <van-popup v-model:show="mineOpen" position="bottom" round>
          <div class="sheet" data-testid="mine-sheet">
            <div class="sheet-title">你这边的画面</div>
            <p class="text-[12.5px] text-ink-3 mt-1 mb-0">各自专注时放在下半屏，像连线时你这边的镜头</p>
            <div class="flex gap-2 flex-wrap mt-3">
              <button type="button" class="chip" :class="{ on: mine.source === 'photo' }" @click="mine.source = 'photo'"><span class="i-lucide-image" />照片</button>
              <button type="button" class="chip" :class="{ on: mine.source === 'persona' }" @click="mine.source = 'persona'"><span class="i-lucide-sparkles" />按人设画</button>
              <button type="button" class="chip" disabled aria-disabled="true"><span class="i-lucide-camera" />摄像头 · 后续支持</button>
            </div>
            <template v-if="mine.source === 'photo'">
              <div v-if="mine.photoKey" class="mine-preview"><AssetImg :asset-key="mine.photoKey" alt="你上传的照片" /></div>
              <div class="flex items-center gap-3 mt-3">
                <ImagePick class="pick" @pick="pickPhoto"><span class="i-lucide-image-plus" />{{ mine.photoKey ? '换一张' : '上传照片' }}</ImagePick>
                <button v-if="mine.photoKey" type="button" class="text-[13px] text-ink-3" @click="mine.photoKey = null">不用这张了</button>
              </div>
              <p class="text-[12px] text-ink-3 mt-2 mb-0">书桌、窗外、你自己都行；只存在这台设备上</p>
            </template>
            <template v-else-if="mine.source === 'persona'">
              <div class="persona-line">
                <PersonaAvatar :persona="persona" :size="32" />
                <span class="flex-1 min-w-0 text-[13px] text-ink-2">按「{{ persona.name }}」的人设：{{ persona.description || '（人设还没写描述）' }}</span>
              </div>
              <label class="field-label" for="mine-tags">你的外观 tags（可以不填，例如 1boy, short hair, glasses）</label>
              <input id="mine-tags" v-model="mineTags" class="input" autocapitalize="off" spellcheck="false" />
              <div v-if="mineArt" class="mine-preview"><AssetImg :asset-key="mineArt.assetKey" :url="mineArt.url" :alt="mineArt.title" /></div>
              <div class="flex items-center gap-3 mt-3">
                <van-button size="small" round type="primary" :loading="!!mineDrawing" :loading-text="mineDrawing ?? ''" @click="drawMine('user')">{{ mineArt ? '重画一张' : '画一张' }}</van-button>
                <span class="text-[12px] text-ink-3">用"生图 · 陪伴学习"的"你这边"一块</span>
              </div>
              <p v-if="mineIssue" class="text-[12.5px] text-bad mt-2 mb-0">
                {{ mineIssue.text }}<button v-if="mineIssue.settings" type="button" class="text-accent-ink ml-2" @click="router.push('/me/api?feature=image')">去设置</button>
              </p>
            </template>
            <van-button round block class="!mt-4" @click="mineOpen = false">好了</van-button>
          </div>
        </van-popup>
      </div>
    </template>
  </SceneShell>
</template>

<style scoped>
.study {
  position: absolute;
  inset: 0;
  z-index: 6;
  pointer-events: none;
}
.study > * {
  pointer-events: auto;
}
.study > .shade,
.study > .pitch {
  pointer-events: none;
}
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.6s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

/* —— 画面层 —— */
.full-art,
.half-art {
  position: absolute;
  left: 0;
  right: 0;
  display: block;
  padding: 0;
  border: 0;
  background: #000;
  cursor: zoom-in;
  overflow: hidden;
}
.full-art {
  top: 0;
  bottom: 0;
}
.half-art.top {
  top: 0;
  height: 50%;
}
.full-art :deep(.asset-img) {
  object-position: 50% 22%;
}
.half-art :deep(.asset-img) {
  object-position: 50% 30%;
}
.half.bottom {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 50%;
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
  background: linear-gradient(to bottom, rgba(0, 0, 0, 0.28), transparent);
}
.shade.bottom {
  bottom: 0;
  height: 170px;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.3), transparent);
}
/* 足球场的中线和中圈 */
.pitch {
  position: absolute;
  inset: 0;
}
.midline {
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  height: 2px;
  margin-top: -1px;
  background: rgba(255, 255, 255, 0.85);
  box-shadow:
    0 0 0 1px rgba(0, 0, 0, 0.1),
    0 0 8px rgba(0, 0, 0, 0.22);
}
.circle {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 236px;
  height: 236px;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.72);
  transform: translate(-50%, -50%);
  box-shadow:
    0 0 0 1px rgba(0, 0, 0, 0.08),
    inset 0 0 0 1px rgba(0, 0, 0, 0.08);
}

/* —— 开始前 / 学完：上下各一半 —— */
.plan,
.done-say {
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: calc(50% + 12px);
}
.plan {
  padding: 12px 14px;
  border-radius: 18px;
  background: var(--glass);
  border: 1px solid var(--glass-line);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  box-shadow: var(--shadow-sm);
}
.plan-slots {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 9px;
}
.slot {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  height: 24px;
  padding: 0 9px;
  border-radius: 99px;
  background: var(--glass-line);
  font-size: 12px;
  color: var(--ink-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.slot.now {
  background: var(--accent-soft);
  color: var(--accent-ink);
}
.slot .num {
  font-size: 11.5px;
  opacity: 0.85;
}
.done-say :deep(.bubble) {
  max-height: min(9.6em, calc(50vh - 120px));
}
.split-panel {
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  bottom: 0;
  display: flex;
  flex-direction: column;
  border-radius: 26px 26px 0 0;
  background: var(--glass-strong);
  border-top: 1px solid var(--glass-line);
  backdrop-filter: blur(22px);
  -webkit-backdrop-filter: blur(22px);
}
.split-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 14px 16px 12px;
}
.split-foot {
  flex: none;
  padding: 10px 16px calc(var(--safe-bottom) + 12px);
  border-top: 1px solid var(--glass-line);
}
.label {
  margin: 14px 0 7px;
  font-size: 12.5px;
  color: var(--ink-3);
}
.label.first {
  margin-top: 2px;
}
.hint {
  margin: 7px 2px 0;
  font-size: 12px;
  line-height: 1.55;
  color: var(--ink-3);
}
.mine-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  margin-top: 10px;
  padding: 8px 10px;
  border-radius: 14px;
  background: var(--panel);
}
.mine-thumb {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 44px;
  height: 44px;
  border-radius: 10px;
  overflow: hidden;
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
.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
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
.chip:disabled {
  opacity: 0.5;
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
.diary {
  margin-top: 10px;
  padding: 10px 12px;
  border-radius: 14px;
  background: var(--panel);
  font-size: 13.5px;
  line-height: 1.6;
  color: var(--ink-2);
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
.stamps {
  display: flex;
  justify-content: space-between;
  gap: 4px;
  margin-top: 16px;
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

/* —— 专注：左上她、右下你 —— */
.her-col,
.me-col {
  position: absolute;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: min(64%, 270px);
}
.her-col {
  top: calc(var(--safe-top) + 58px);
  left: 12px;
  align-items: flex-start;
}
.v-together .her-col :deep(.bubble) {
  max-height: min(9.6em, calc(50vh - var(--ring) / 2 - 160px));
}
.v-solo .her-col :deep(.bubble) {
  max-height: min(9.6em, calc(50vh - 250px));
}
.me-col {
  right: 12px;
  bottom: calc(var(--safe-bottom) + 62px);
  align-items: flex-end;
}
.me-col :deep(.bubble) {
  max-height: 6.4em;
}
.her-card,
.my-card {
  display: block;
  width: 100%;
  padding: 9px 12px 10px;
  border-radius: 16px;
  background: var(--veil);
  border: 1px solid var(--glass-line);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  box-shadow: var(--shadow-sm);
}
.card-task {
  display: -webkit-box;
  margin-top: 4px;
  font-size: 13.5px;
  line-height: 1.45;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.bar {
  display: block;
  height: 4px;
  margin-top: 7px;
  border-radius: 2px;
  background: var(--glass-line);
  overflow: hidden;
}
.bar > span {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: var(--accent);
  transition: width 0.9s ease;
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
.ghost-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 30px;
  padding: 0 12px;
  border-radius: 99px;
  background: var(--veil);
  border: 1px dashed var(--glass-line);
  color: var(--ink-2);
  font-size: 12.5px;
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}

/* —— 一起专注：中间的圆形计时器 —— */
.ring-zone {
  position: absolute;
  z-index: 2;
  left: 50%;
  top: 50%;
  display: flex;
  flex-direction: column;
  align-items: center;
  width: min(320px, 88%);
  transform: translate(-50%, calc(var(--ring) / -2));
}
.ring-disc {
  border-radius: 50%;
  background: var(--veil);
  border: 1px solid var(--glass-line);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  box-shadow: var(--shadow);
}
.away {
  margin-top: 12px;
  padding: 10px 12px;
  border-radius: 16px;
  background: var(--glass-strong);
  border: 1px solid var(--accent-line);
  text-align: center;
  box-shadow: var(--shadow-sm);
}

/* —— 各自专注：中线两边的长方形计时器 —— */
.duo-slot {
  position: absolute;
  left: 50%;
  width: min(68%, 264px);
  transform: translateX(-50%);
}
.duo-slot.her {
  bottom: calc(50% + 1px);
}
.duo-slot.me {
  z-index: 2;
  top: calc(50% + 1px);
}

/* —— 最下面一排：和顶栏一样的玻璃小圆角 —— */
.bottom-bar {
  position: absolute;
  left: 10px;
  right: 10px;
  bottom: calc(var(--safe-bottom) + 10px);
  display: flex;
  align-items: center;
  gap: 6px;
}
.pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  min-width: 38px;
  height: 38px;
  padding: 0 12px;
  border-radius: 99px;
  background: var(--glass);
  border: 1px solid var(--glass-line);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  color: var(--ink);
  font-size: 13.5px;
  white-space: nowrap;
  flex-shrink: 0;
}
.pill.on {
  color: var(--accent-ink);
  border-color: var(--accent-line);
}
.pill.icon {
  padding: 0;
}
.pill:disabled {
  opacity: 0.6;
}
.chat-form {
  flex: 1;
  min-width: 0;
  display: flex;
  gap: 6px;
}
.chat-input {
  flex: 1;
  min-width: 0;
  height: 38px;
  padding: 0 14px;
  border-radius: 99px;
  border: 1px solid var(--glass-line);
  background: var(--glass-strong);
  outline: none;
  font-size: 14px;
}
.pop-catcher {
  position: absolute;
  inset: 0;
}
.noise-pop {
  position: absolute;
  left: 10px;
  bottom: calc(var(--safe-bottom) + 56px);
  width: min(320px, calc(100% - 20px));
  padding: 12px;
  border-radius: 18px;
  background: var(--glass-strong);
  border: 1px solid var(--glass-line);
  backdrop-filter: blur(22px);
  -webkit-backdrop-filter: blur(22px);
  box-shadow: var(--shadow);
  animation: rise 0.2s var(--ease) both;
}
.spin {
  animation: spin 1s linear infinite;
}

/* —— 顶栏右边的自动画开关 —— */
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

/* —— 弹窗里 —— */
.mine-preview {
  width: 100%;
  aspect-ratio: 4 / 3;
  margin-top: 12px;
  border-radius: 14px;
  overflow: hidden;
  background: var(--panel);
}
.pick {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 32px;
  padding: 0 14px;
  border-radius: 99px;
  background: var(--accent-soft);
  border: 1px solid var(--accent-line);
  color: var(--accent-ink);
  font-size: 13px;
}
.persona-line {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-top: 12px;
  padding: 10px 12px;
  border-radius: 14px;
  background: var(--panel);
}
</style>
