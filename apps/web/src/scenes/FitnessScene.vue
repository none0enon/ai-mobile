<script setup lang="ts">
import { estimateKcal, FIT_METHODS, fitMethod, metFor, moveAmount, paceText, shiftDate, weekStartOf, type FitMove, type MessagePart } from '@app/shared';
import { showConfirmDialog, showToast } from 'vant';
import { computed, inject, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Avatar from '@/components/common/Avatar.vue';
import Segmented from '@/components/common/Segmented.vue';
import MoveHow from '@/components/health/MoveHow.vue';
import { SCENE_LOCATION } from '@/components/scene/location';
import MicLinkBar from '@/components/scene/MicLinkBar.vue';
import PlaylistMusic from '@/components/scene/PlaylistMusic.vue';
import SceneShell from '@/components/scene/SceneShell.vue';
import StudyBubble from '@/components/scene/study/StudyBubble.vue';
import TimerRing from '@/components/scene/TimerRing.vue';
import { useDragFloat, type FloatPos } from '@/composables/useDragFloat';
import { useMicLink } from '@/composables/useMicLink';
import { services } from '@/services';
import { fitMusic, type PlaylistSearch } from '@/services/musicPlayer';
import { personaOf } from '@/services/prompt';
import { SpeechQueue } from '@/services/speech';
import { bluetoothSupported, createGpsTracker, createHeartRate, createStepCounter, isAndroid } from '@/services/workoutSensors';
import { useAiStore } from '@/stores/ai';
import { useAppStore } from '@/stores/app';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';
import { useHealthStore, type WorkoutLog } from '@/stores/health';
import { useRhythmStore } from '@/stores/rhythm';
import { uid } from '@/utils/id';
import { clock } from '@/utils/time';

/**
 * 健身（以前的"一起运动"，设计文档 §9.1）：照"一起学习"的样子，画面用她的立绘（穿节律里那套运动服），不生图。
 * - 开始前（和练完）：上下各一半。上半屏是她的立绘和她那边在干什么；下半屏是你的安排：
 *   按照计划（今天的健身计划，一个动作一个动作地练）或者随便动动（从你人设里能接受的健身方式挑一个，可以定个时长）；
 *   记录：时长一直记；心率、消耗可选；室外的再加步数和距离。进阶的自动记录先只做安卓（蓝牙心率、计步、GPS），别的手机结束时手动填。
 * - 练的时候：整屏立绘，一个半透明的圆形计时器（照计划练：每组的计时、组间休息倒计时；随便动动：时长），按住能拖到哪儿都行、记住位置；
 *   下面是现在这个动作，怎么做直接展开着（开练了就不用再点）、心率、消耗、步数、距离；最下面音乐、跟她说一句。
 * - 她说的话（开练、做完一个动作、练了一段时间、边练边聊、结束）都来自「陪伴 · 快速」按"健身"功能预设，存进聊天；可以让她读出来。
 * - 右上角连麦（composables/useMicLink.ts，和共同的家一样）：手上忙着，说话她就听得到、用她的声音回你（fit-call）；
 *   连着的时候开练、做完一个动作、练了一段时间、练完她也在麦里说，不另外念。
 * - 练完：统计、补上手表上的数，"发给她"：运动卡片进聊天，她具体地评价；记录也记进健康计划（她平时聊天也知道你今天练没练）。
 */
type Phase = 'setup' | 'active' | 'done';
type Mode = 'plan' | 'free';
type Step = { kind: 'warmup' | 'items' | 'cooldown'; move: FitMove };

const MODE_OPTIONS: { value: Mode; label: string; icon: string }[] = [
  { value: 'plan', label: '按照计划', icon: 'i-lucide-list-checks' },
  { value: 'free', label: '随便动动', icon: 'i-lucide-person-standing' },
];
const TARGETS = [0, 15, 30, 45, 60];
const FIT_SEARCHES: PlaylistSearch[] = [
  { name: '燃脂', keyword: '燃脂 健身 音乐', icon: 'i-lucide-flame' },
  { name: '跑步', keyword: '跑步 节奏 歌单', icon: 'i-lucide-footprints' },
  { name: '力量', keyword: '健身房 力量 训练 音乐', icon: 'i-lucide-dumbbell' },
  { name: '瑜伽', keyword: '瑜伽 冥想 轻音乐', icon: 'i-lucide-flower-2' },
  { name: '元气', keyword: '元气 活力 歌曲', icon: 'i-lucide-sun' },
];
const KIND_LABEL: Record<Step['kind'], string> = { warmup: '热身', items: '动作', cooldown: '拉伸放松' };
/** 随便动动时大约每隔多久她打一次气 */
const CHEER_EVERY_MIN = 10;
const SAVE_KEY = 'ai-mobile:fitness';

const app = useAppStore();
const chars = useCharacterStore();
const chat = useChatStore();
const ai = useAiStore();
const health = useHealthStore();
const rhythm = useRhythmStore();
const route = useRoute();
const router = useRouter();
const location = inject(SCENE_LOCATION, ref(null));

const her = computed(() => chars.byId(app.activeCharacterId) ?? chars.list[0]!);
const chatId = computed(() => chat.chatOfCharacter(her.value.id)?.id ?? '');
const persona = computed(() => personaOf(chat.chatById(chatId.value)));
const userName = computed(() => persona.value.name);
const hs = computed(() => (persona.value.health?.enabled ? persona.value.health : null));
const herWhere = computed(() => location.value?.name ?? '');
const herSlot = computed(() => rhythm.slotNow(her.value.id));
const android = isAndroid();

// —— 设置：记在本机 ——
interface Saved {
  mode?: Mode;
  method?: string;
  targetMin?: number;
  voiceOn?: boolean;
  track?: boolean;
  /** 计时器拖到了哪儿 */
  ringPos?: FloatPos;
}
function loadSaved(): Saved {
  try {
    const v = JSON.parse(localStorage.getItem(SAVE_KEY) ?? '{}') as unknown;
    return v && typeof v === 'object' ? (v as Saved) : {};
  } catch {
    return {};
  }
}
const saved = loadSaved();
const mode = ref<Mode>(route.query.mode === 'plan' || route.query.mode === 'free' ? route.query.mode : saved.mode === 'free' ? 'free' : 'plan');
const methods = computed(() => (hs.value?.methods.length ? hs.value.methods : FIT_METHODS.slice(0, 8).map((m) => m.name)));
const method = ref(saved.method && methods.value.includes(saved.method) ? saved.method : (methods.value[0] ?? '快走'));
const targetMin = ref(TARGETS.includes(saved.targetMin ?? -1) ? saved.targetMin! : 0);
const voiceOn = ref(saved.voiceOn ?? false);
/** 室外：用 GPS 记距离、用手机数步（安卓） */
const track = ref(saved.track ?? true);
/**
 * 计时器的位置（能放的范围里的比例）。你拖过就一直放在那儿（记在本机）；
 * 没拖过时每次开练放在左边、动作卡上面，不挡怎么做（随便动动没有动作卡，放在左边偏上）
 */
const RING_HOME: FloatPos = { x: 0, y: 0.3 };
const validPos = (p: unknown): p is FloatPos => !!p && typeof p === 'object' && Number.isFinite((p as FloatPos).x) && Number.isFinite((p as FloatPos).y);
const ringPos = ref<FloatPos>(validPos(saved.ringPos) ? saved.ringPos : { ...RING_HOME });
let ringMoved = validPos(saved.ringPos);
function persist() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({ mode: mode.value, method: method.value, targetMin: targetMin.value, voiceOn: voiceOn.value, track: track.value, ...(ringMoved ? { ringPos: ringPos.value } : {}) }));
  } catch {
    // 存不下就算了
  }
}
watch([mode, method, targetMin, voiceOn, track], persist);
const {
  el: ringEl,
  dragging: ringDragging,
  style: ringStyle,
  listeners: ringListeners,
  onClickCapture: ringClickCapture,
} = useDragFloat(ringPos, () => {
  ringMoved = true;
  persist();
});
const moveCardEl = ref<HTMLElement | null>(null);
function placeRing() {
  if (ringMoved) return;
  const disc = ringEl.value;
  const area = disc?.offsetParent as HTMLElement | null;
  const card = moveCardEl.value;
  if (!disc || !area || !card) {
    ringPos.value = { ...RING_HOME };
    return;
  }
  const room = area.clientHeight - disc.offsetHeight;
  const top = card.getBoundingClientRect().top - area.getBoundingClientRect().top - disc.offsetHeight - 8;
  ringPos.value = { x: 0, y: room > 0 ? Math.min(1, Math.max(0, top / room)) : 0 };
}
const methodInfo = computed(() => fitMethod(method.value));
const outdoor = computed(() => mode.value === 'free' && methodInfo.value.outdoor);

// —— 今天的计划 ——
const plan = computed(() => health.dayOf(persona.value.id));
const planWorkout = computed(() => (plan.value && !plan.value.rest ? plan.value.workout : null));
const planBusy = computed(() => health.busy[persona.value.id]);
const planError = computed(() => health.errors[persona.value.id]);
const healthStatus = computed(() => ai.status('health'));
async function makePlan() {
  const r = await health.planDay(persona.value);
  if (!r.ok && !r.notConnected) showToast(r.reason);
}
const steps = computed<Step[]>(() => {
  const w = planWorkout.value;
  if (!w) return [];
  return [...w.warmup.map((move) => ({ kind: 'warmup' as const, move })), ...w.items.map((move) => ({ kind: 'items' as const, move })), ...w.cooldown.map((move) => ({ kind: 'cooldown' as const, move }))];
});
const openSetupMove = ref<number | null>(null);

// —— 计时：按时间戳算（暂停时记下暂停的时刻，继续时把开始时间往后挪） ——
const phase = ref<Phase>('setup');
const now = ref(Date.now());
const startedAt = ref(0);
const pausedAt = ref<number | null>(null);
const activeSec = computed(() => (startedAt.value ? Math.max(0, Math.floor(((pausedAt.value ?? now.value) - startedAt.value) / 1000)) : 0));
const paused = computed(() => pausedAt.value !== null);
let ticker: ReturnType<typeof setInterval> | undefined;

// 照计划：现在第几个动作、第几组、是不是在组间休息（休息、按时间做的组都有自己的倒计时）
const stepIndex = ref(0);
const setNo = ref(1);
const resting = ref(false);
const segEndsAt = ref<number | null>(null);
const segPausedLeft = ref<number | null>(null);
const doneMoves = ref<string[]>([]);
const current = computed(() => steps.value[stepIndex.value] ?? null);
// 开练、换到下一个动作（动作卡高矮不一样）：没拖过的计时器重新放到动作卡上面
watch([phase, stepIndex], () => {
  if (phase.value === 'active') void nextTick(placeRing);
});
const segLeftSec = computed(() => {
  if (segPausedLeft.value !== null) return segPausedLeft.value;
  return segEndsAt.value === null ? null : Math.max(0, Math.ceil((segEndsAt.value - now.value) / 1000));
});

// —— 记录：心率（蓝牙）、步数（加速度）、距离（GPS），只在安卓上开 ——
const hr = createHeartRate();
const stepCounter = createStepCounter();
const gps = createGpsTracker();
const manual = reactive({ hrAvg: '', hrMax: '', kcal: '', steps: '', km: '' });
function setCounting(on: boolean) {
  hr.setCounting(on);
  stepCounter.setCounting(on);
  gps.setCounting(on);
}

const intensityMet = computed(() => {
  const t = planWorkout.value?.intensity ?? '';
  return /轻松|低/.test(t) ? 3.5 : /累|高|强/.test(t) ? 7 : 5;
});
const kmh = computed(() => (gps.state.km > 0 && activeSec.value > 60 ? gps.state.km / (activeSec.value / 3600) : null));
const kcalLive = computed(() => {
  const h = hs.value;
  const met = mode.value === 'plan' ? intensityMet.value : metFor(methodInfo.value, kmh.value);
  return estimateKcal({ met, minutes: activeSec.value / 60, weightKg: h?.weightKg ?? null, hrAvg: hr.state.avg || null, age: h?.age ?? null, sex: h?.sex ?? null });
});
const paceLive = computed(() => (gps.state.km >= 0.05 ? paceText(activeSec.value / gps.state.km) : `--'--"`));

// —— 她说的话：都来自「陪伴 · 快速」，存进聊天 ——
const herLine = ref('');
const notConnected = ref('');
const stream = computed(() => (chatId.value ? chat.streams[chatId.value] : undefined));
const streamingText = computed(() => (stream.value ? (chat.list(chatId.value).find((m) => m.id === stream.value!.messageId)?.text ?? '') : ''));
/** 连着麦时是她在麦里最近说的那句 */
const shownLine = computed(() => (link.state.on && lastCaption.value) || streamingText.value || herLine.value);
const lastCaption = computed(() => [...link.state.captions].reverse().find((c) => c.who === 'her')?.text ?? '');
const chatLink = computed(() => `/chat/${chatId.value}?mode=stage`);
const cue = computed(() => {
  if (phase.value === 'setup') return '开练';
  if (phase.value === 'done') return '练完';
  if (mode.value === 'plan' && current.value) return `${current.value.move.name} · 第 ${setNo.value} 组`;
  return clock(activeSec.value);
});

function statsLines(): string[] {
  const parts = [
    `已经练了 ${Math.max(1, Math.round(activeSec.value / 60))} 分钟`,
    hr.state.bpm ? `现在心率 ${hr.state.bpm}` : '',
    hr.state.avg ? `平均心率 ${hr.state.avg}、最高 ${hr.state.max}` : '',
    stepCounter.state.steps ? `${stepCounter.state.steps} 步` : '',
    gps.state.km >= 0.05 ? `${gps.state.km.toFixed(2)} 公里，配速 ${paceLive.value}` : '',
    kcalLive.value.kcal ? `大约消耗 ${kcalLive.value.kcal} 千卡（${kcalLive.value.basis}）` : '',
  ].filter(Boolean);
  return [parts.join('，')];
}
function whatLine(): string {
  if (mode.value === 'plan' && planWorkout.value) return `照今天的健身计划练：${planWorkout.value.title}（${planWorkout.value.minutes} 分钟，${planWorkout.value.intensity || '中等'}；${planWorkout.value.items.map((m) => m.name).join('、')}）`;
  return `随便动动：${method.value}${outdoor.value ? '（室外）' : ''}${targetMin.value ? `，打算练 ${targetMin.value} 分钟` : '，不定时'}`;
}

async function speak(text: string) {
  if (!voiceOn.value || !text) return;
  fitMusic.duck(true);
  try {
    await services.tts.speak(text, { characterId: her.value.id, expression: chars.expression[her.value.id] ?? 'smile' });
  } catch {
    // 没接通语音合成：只显示字
  } finally {
    fitMusic.duck(false);
  }
}

async function reply(task: string, lines: string[], userText?: string) {
  if (!chatId.value) return;
  const input = lines.filter(Boolean).join('\n');
  // 连着麦：她在麦里说（用她的声音，和回你的话同一路）
  if (!userText && link.announce(task, input)) return;
  if (!userText && chat.streams[chatId.value]) chat.stop(chatId.value);
  const r = await chat.sceneReply(chatId.value, { task, input, userText, cue: cue.value, quick: true });
  if (!r.ok) {
    if (r.notConnected) notConnected.value = r.reason;
    else if (!/还在回上一句/.test(r.reason)) showToast(r.reason);
    return;
  }
  notConnected.value = '';
  herLine.value = r.message.text;
  void speak(r.message.text);
}

// —— 开始、暂停、结束 ——
async function begin() {
  if (mode.value === 'plan' && !steps.value.length) {
    showToast('今天还没有健身计划：先排一下，或者选"随便动动"');
    return;
  }
  now.value = Date.now();
  startedAt.value = now.value;
  pausedAt.value = null;
  stepIndex.value = 0;
  setNo.value = 1;
  resting.value = false;
  doneMoves.value = [];
  hr.reset();
  stepCounter.state.steps = 0;
  gps.state.km = 0;
  Object.assign(manual, { hrAvg: '', hrMax: '', kcal: '', steps: '', km: '' });
  sent.value = false;
  lastCheerMin = 0;
  phase.value = 'active';
  if (android && track.value && outdoor.value) {
    gps.start();
    if (methodInfo.value.steps) stepCounter.start();
  }
  setCounting(true);
  startSegment();
  clearInterval(ticker);
  ticker = setInterval(tick, 1000);
  void services.native.keepAwake(true);
  chars.setExpression(her.value.id, 'laugh');
  await reply('fit-start', [whatLine(), herSlot.value ? `你自己这会儿：${herSlot.value.status}（在${herWhere.value || '你那边'}）` : '', hs.value?.goal ? `${userName.value}的目标：${hs.value.goal}` : '']);
}

/** 照计划：这一组按时间做的开倒计时，按次数做的等你点"这组做完了" */
function startSegment() {
  segPausedLeft.value = null;
  const m = current.value?.move;
  segEndsAt.value = mode.value === 'plan' && m && m.seconds > 0 ? Date.now() + m.seconds * 1000 : null;
}
function startRest(sec: number) {
  resting.value = true;
  segPausedLeft.value = null;
  segEndsAt.value = Date.now() + sec * 1000;
}

let lastCheerMin = 0;
function tick() {
  now.value = Date.now();
  if (phase.value !== 'active' || paused.value) return;
  if (mode.value === 'plan' && segEndsAt.value !== null && now.value >= segEndsAt.value) {
    if (resting.value) {
      resting.value = false;
      startSegment();
      services.native.vibrate([30, 80, 30]);
    } else void finishSet();
  }
  // 随便动动：每 10 分钟她打一次气；定了时长的到点说一句
  if (mode.value === 'free') {
    const min = Math.floor(activeSec.value / 60);
    if (targetMin.value && min >= targetMin.value && lastCheerMin < targetMin.value) {
      lastCheerMin = targetMin.value;
      services.native.vibrate([40, 80, 40]);
      void reply('fit-cheer', [whatLine(), `定的 ${targetMin.value} 分钟到了（还可以接着练，也可以结束）`, ...statsLines()]);
    } else if (min > 0 && min % CHEER_EVERY_MIN === 0 && min !== lastCheerMin) {
      lastCheerMin = min;
      void reply('fit-cheer', [whatLine(), ...statsLines()]);
    }
  }
}

function togglePause() {
  const t = Date.now();
  if (pausedAt.value === null) {
    pausedAt.value = t;
    if (segEndsAt.value !== null) segPausedLeft.value = Math.max(0, Math.ceil((segEndsAt.value - t) / 1000));
    setCounting(false);
  } else {
    startedAt.value += t - pausedAt.value;
    if (segPausedLeft.value !== null) segEndsAt.value = t + segPausedLeft.value * 1000;
    segPausedLeft.value = null;
    pausedAt.value = null;
    setCounting(true);
  }
  now.value = t;
}

/** 这一组做完了（按次数的点的，按时间的到点自动） */
async function finishSet() {
  const s = current.value;
  if (!s || resting.value) return;
  services.native.vibrate(20);
  if (setNo.value < s.move.sets) {
    setNo.value += 1;
    if (s.move.rest) startRest(s.move.rest);
    else startSegment();
    return;
  }
  await nextMove(true);
}
async function nextMove(completed: boolean) {
  const s = current.value;
  if (!s) return;
  if (completed) doneMoves.value.push(s.move.name);
  const next = steps.value[stepIndex.value + 1] ?? null;
  stepIndex.value += 1;
  setNo.value = 1;
  resting.value = false;
  if (!next) {
    segEndsAt.value = null;
    void finish(true);
    return;
  }
  startSegment();
  // 正式的动作做完了才让她说一句（热身、拉伸不说）
  if (completed && s.kind === 'items') {
    await reply('fit-move', [`${userName.value}做完了：${s.move.name}（${moveAmount(s.move)}）`, `下一个：${next.move.name}（${moveAmount(next.move)}）${next.move.tips ? `；要注意：${next.move.tips}` : ''}`, ...statsLines()]);
  }
}
function skipRest() {
  resting.value = false;
  startSegment();
}

// —— 边练边聊 ——
function doingLine(): string {
  return mode.value === 'plan' && current.value ? `现在在做：${current.value.move.name}（第 ${setNo.value}/${current.value.move.sets} 组${resting.value ? '，组间休息' : ''}）` : '';
}
const chatText = ref('');
async function sendChat() {
  const t = chatText.value.trim();
  if (!t) return;
  // 连着麦：打的字也走麦里那一路，她用声音回
  if (link.state.on) {
    chatText.value = '';
    void link.say(t);
    return;
  }
  if (stream.value) return;
  chatText.value = '';
  await reply('fit-chat', [whatLine(), doingLine(), paused.value ? '暂停着' : '', ...statsLines()], t);
}
const musicOpen = ref(false);

// —— 连麦：手上忙着，说话她就听得到，用她的声音回你 ——
let speech: SpeechQueue | null = null;
function newSpeech(o: { onSentence?(text: string, i: number): void } = {}): SpeechQueue {
  speech?.stop();
  const q = new SpeechQueue({ characterId: her.value.id, onSentence: o.onSentence });
  speech = q;
  fitMusic.duck(true);
  void q.drained().then(() => {
    if (speech === q) fitMusic.duck(false);
  });
  return q;
}
function linkContext(): string {
  if (phase.value === 'setup') return `${userName.value}还没开练，在准备。打算：${whatLine()}`;
  if (phase.value === 'done') return `${userName.value}刚练完（${whatLine()}），一共练了 ${Math.max(1, Math.round((endedSec || activeSec.value) / 60))} 分钟`;
  return [whatLine(), doingLine(), paused.value ? '暂停着' : '', ...statsLines()].filter(Boolean).join('\n');
}
const link = useMicLink({
  chatId,
  character: her,
  userName,
  newSpeech: (o) => newSpeech({ onSentence: o.onSentence }),
  context: linkContext,
  herBusy: () => false,
  onInterrupt: () => undefined,
  autoWhisper: () => false,
  tasks: { reply: 'fit-call' },
  input: (kind, info) =>
    kind === 'open'
      ? `${info.context}\n你们刚连上麦，${userName.value}${phase.value === 'active' ? '一边练一边' : ''}用语音跟你说话。先开口说第一句，1–2 个短句。`
      : `${info.context}\n连麦中（已经连了 ${info.linked}）。回${userName.value}刚才说的话。`,
});
// 练着的时候挂断了麦：屏幕接着保持亮着（连麦挂断时会把它关掉）
watch(
  () => link.state.on,
  (on) => {
    if (!on && phase.value === 'active') void services.native.keepAwake(true);
  },
);
function toggleLink() {
  if (link.state.on) void link.hangUp();
  else link.connect();
}

// —— 结束 ——
const sent = ref(false);
/** 这次进来发给她的几次一共练了多久（离开时那一段的总结） */
const visitMinutes = ref(0);
const sending = ref(false);
let endedSec = 0;
async function finish(auto = false) {
  if (phase.value !== 'active') return;
  if (!auto) {
    try {
      await showConfirmDialog({ title: '今天就练到这里？', confirmButtonText: '结束', cancelButtonText: '再练一会' });
    } catch {
      return;
    }
  }
  if (pausedAt.value !== null) togglePause();
  endedSec = activeSec.value;
  clearInterval(ticker);
  setCounting(false);
  gps.stop();
  stepCounter.stop();
  // 还连着麦时屏幕接着亮（熄屏就听不到了），挂断时再关
  if (!link.state.on) void services.native.keepAwake(false);
  now.value = Date.now();
  phase.value = 'done';
  musicOpen.value = false;
  // 自动记到的数先填进去，可以改
  Object.assign(manual, {
    hrAvg: hr.state.avg ? String(hr.state.avg) : '',
    hrMax: hr.state.max ? String(hr.state.max) : '',
    steps: stepCounter.state.steps ? String(stepCounter.state.steps) : '',
    km: gps.state.km >= 0.05 ? gps.state.km.toFixed(2) : '',
    kcal: '',
  });
  hr.disconnect();
  // 上面的气泡等"发给她"以后放她的评价，不留练的时候的那句
  herLine.value = '';
  chars.setExpression(her.value.id, 'smile');
}
const num = (s: string) => {
  const n = Number(s.trim());
  return s.trim() && Number.isFinite(n) && n > 0 ? n : undefined;
};
const summary = computed(() => {
  const h = hs.value;
  const sec = endedSec || activeSec.value;
  const hrAvg = num(manual.hrAvg);
  const km = num(manual.km);
  const met = mode.value === 'plan' ? intensityMet.value : metFor(methodInfo.value, km && sec ? km / (sec / 3600) : null);
  const est = estimateKcal({ met, minutes: sec / 60, weightKg: h?.weightKg ?? null, hrAvg: hrAvg ?? null, age: h?.age ?? null, sex: h?.sex ?? null });
  return {
    sec,
    hrAvg: hrAvg ? Math.round(hrAvg) : undefined,
    hrMax: num(manual.hrMax) ? Math.round(num(manual.hrMax)!) : undefined,
    steps: num(manual.steps) ? Math.round(num(manual.steps)!) : undefined,
    km: km ? Math.round(km * 100) / 100 : undefined,
    kcal: num(manual.kcal) ? Math.round(num(manual.kcal)!) : est.kcal || undefined,
    kcalBasis: num(manual.kcal) ? '你填的' : est.basis,
    pace: km ? paceText(sec / km) : undefined,
  };
});
const totalMoves = computed(() => steps.value.filter((s) => s.kind === 'items').length);
const doneItems = computed(() => steps.value.filter((s) => s.kind === 'items' && doneMoves.value.includes(s.move.name)).length);

async function send() {
  if (!chatId.value || sent.value || sending.value) return;
  sending.value = true;
  try {
    const s = summary.value;
    const auto = hr.state.avg > 0 || stepCounter.state.steps > 0 || gps.state.km > 0;
    const source: WorkoutLog['source'] = num(manual.kcal) || (!auto && (s.hrAvg || s.steps || s.km)) ? 'manual' : auto ? 'auto' : 'estimate';
    const logId = uid('workout');
    const title = planWorkout.value?.title ?? '今天的训练';
    const part: MessagePart = {
      type: 'workout',
      logId,
      sport: mode.value === 'plan' ? title : method.value,
      durationSec: s.sec,
      mode: mode.value,
      ...(mode.value === 'plan' ? { plan: { title, done: doneItems.value, total: totalMoves.value, moves: [...doneMoves.value] } } : {}),
      ...(s.km ? { distanceKm: s.km, pace: s.pace } : {}),
      ...(s.hrAvg ? { heartRate: { avg: s.hrAvg, ...(s.hrMax ? { max: s.hrMax } : {}) } } : {}),
      ...(s.kcal ? { kcal: s.kcal } : {}),
      ...(s.steps ? { steps: s.steps } : {}),
      source,
    };
    chat.push(chatId.value, 'user', [part], { meta: { scene: 'exercise', cue: '练完' } });
    health.addLog({
      id: logId,
      personaId: persona.value.id,
      characterId: her.value.id,
      date: health.today(),
      startedAt: Date.now() - s.sec * 1000,
      durationSec: s.sec,
      mode: mode.value,
      sport: mode.value === 'plan' ? title : method.value,
      ...(mode.value === 'plan' ? { plan: { title, done: doneItems.value, total: totalMoves.value } } : {}),
      outdoor: outdoor.value,
      ...(s.km ? { distanceKm: s.km } : {}),
      ...(s.steps ? { steps: s.steps } : {}),
      ...(s.hrAvg ? { hrAvg: s.hrAvg } : {}),
      ...(s.hrMax ? { hrMax: s.hrMax } : {}),
      ...(s.kcal ? { kcal: s.kcal } : {}),
      source,
    });
    sent.value = true;
    visitMinutes.value += Math.max(1, Math.round(s.sec / 60));
    await reply('fit-end', [
      whatLine(),
      `一共练了 ${Math.max(1, Math.round(s.sec / 60))} 分钟`,
      mode.value === 'plan' ? `做完了 ${doneItems.value} / ${totalMoves.value} 个动作${doneMoves.value.length ? `：${doneMoves.value.join('、')}` : ''}` : '',
      s.hrAvg ? `平均心率 ${s.hrAvg}${s.hrMax ? `，最高 ${s.hrMax}` : ''}` : '',
      s.km ? `${s.km} 公里，配速 ${s.pace}` : '',
      s.steps ? `${s.steps} 步` : '',
      s.kcal ? `大约消耗 ${s.kcal} 千卡（${s.kcalBasis}）` : '',
    ]);
  } finally {
    sending.value = false;
  }
}
function again() {
  if (location.value) chat.enterScene(her.value.id, location.value.id, 'exercise');
  phase.value = 'setup';
  herLine.value = '';
  endedSec = 0;
  startedAt.value = 0;
}

// —— 这周练了几天（健康计划里的运动记录，按人设） ——
const DAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'];
const weekDays = computed(() => {
  const start = weekStartOf(health.today());
  const logs = health.logsOf(persona.value.id, start);
  return DAY_LABELS.map((label, i) => {
    const date = shiftDate(start, i);
    return { date, label, on: logs.some((l) => l.date === date) };
  });
});
const weekMinutes = computed(() => health.logsOf(persona.value.id, weekStartOf(health.today())).reduce((n, l) => n + Math.round(l.durationSec / 60), 0));

// —— 计时器上显示什么 ——
const display = computed(() => {
  if (mode.value === 'plan' && segLeftSec.value !== null) {
    const total = resting.value ? (current.value?.move.rest ?? 30) : (current.value?.move.seconds ?? 30);
    return { sec: segLeftSec.value, total: Math.max(1, total), countUp: false, label: resting.value ? '组间休息' : '这一组', tone: resting.value ? 'var(--good)' : 'var(--accent)' };
  }
  if (mode.value === 'free' && targetMin.value) return { sec: activeSec.value, total: targetMin.value * 60, countUp: true, label: `${method.value} · 目标 ${targetMin.value} 分钟`, tone: 'var(--accent)' };
  return { sec: activeSec.value, total: 3600, countUp: true, label: mode.value === 'plan' ? '一起练' : method.value, tone: 'var(--accent)' };
});
const herState = computed(() => {
  if (paused.value) return `${her.value.pronoun}在等你`;
  if (resting.value) return `${her.value.pronoun}也在喘口气`;
  return `${her.value.pronoun}在旁边陪你练`;
});

onMounted(() => {
  // 离开时那一段写"练了多久"
  chat.setLeaveSummary(her.value.id, () => (visitMinutes.value ? `练了 ${visitMinutes.value} 分钟` : undefined));
  if (mode.value === 'plan' && hs.value && !plan.value && healthStatus.value.live && !planBusy.value) void makePlan();
});
onBeforeUnmount(() => {
  chat.setLeaveSummary(her.value.id, null);
  clearInterval(ticker);
  link.dispose();
  speech?.stop();
  hr.disconnect();
  stepCounter.stop();
  gps.stop();
  fitMusic.stop();
  void services.native.keepAwake(false);
  if (chat.streams[chatId.value]) chat.stop(chatId.value);
});

const view = computed<'split' | 'active'>(() => (phase.value === 'active' ? 'active' : 'split'));
/** 立绘放哪：分屏时在上半屏；练的时候站在右边，计时器在左边一点 */
const figureLayout = computed(() => (view.value === 'split' ? { left: 50, bottom: 50, height: 46 } : { left: 70, bottom: 16, height: 62 }));
</script>

<template>
  <SceneShell scene-id="exercise" bare hide-mode outfit="sport" :layout="figureLayout">
    <template #actions>
      <button
        type="button"
        class="mic-pill"
        :class="{ live: link.state.on }"
        :aria-label="link.state.on ? `挂断连麦（已经连了 ${clock(link.state.seconds)}）` : `和${her.name}连麦：说话${her.pronoun}就听得到`"
        data-testid="fit-mic"
        @click="toggleLink"
      >
        <template v-if="link.state.on"><span class="i-lucide-phone-off shrink-0" /><span class="num">{{ clock(link.state.seconds) }}</span></template>
        <template v-else><span class="i-lucide-headphones shrink-0" />连麦</template>
      </button>
      <button type="button" class="pill-btn" :class="{ off: !voiceOn }" :aria-pressed="voiceOn" :aria-label="voiceOn ? `${her.pronoun}的声音：开（点一下关掉）` : `${her.pronoun}的声音：关（点一下打开）`" @click="voiceOn = !voiceOn">
        <span :class="voiceOn ? 'i-lucide-volume-2' : 'i-lucide-volume-x'" />
      </button>
    </template>

    <template #overlay>
      <div class="fit" :class="`v-${view}`" :data-view="view">
        <!-- ============ 开始前 / 练完：上下各一半 ============ -->
        <template v-if="view === 'split'">
          <div v-if="link.state.on" class="split-link"><MicLinkBar :link="link" :pronoun="her.pronoun" type-form /></div>
          <div v-if="phase === 'setup'" class="plan-card" data-testid="her-side">
            <div class="flex items-center gap-2.5">
              <Avatar :character="her" :size="34" live />
              <div class="flex-1 min-w-0">
                <div class="text-[12px] text-ink-2 truncate">{{ her.pronoun }}那边{{ herWhere ? ` · ${herWhere}` : '' }}</div>
                <div class="text-[14.5px] leading-snug mt-0.5">{{ her.pronoun }}也换好运动服了，等你一起练</div>
              </div>
            </div>
            <div v-if="herSlot" class="plan-slots"><span class="slot now"><span class="num">{{ herSlot.from }}–{{ herSlot.to }}</span>{{ herSlot.status }}</span></div>
          </div>
          <div v-else-if="shownLine || stream" class="done-say">
            <StudyBubble side="her" :text="shownLine" :typing="!!stream && !streamingText" :to="chatLink" :label="`去和${her.name}聊天`" />
          </div>

          <section class="split-panel" :aria-label="phase === 'setup' ? '你的安排' : '练完了'">
            <div class="split-scroll">
              <div v-if="notConnected" class="notice">
                <span class="i-lucide-plug-zap shrink-0" />
                <span class="flex-1 min-w-0">{{ notConnected }}</span>
                <button class="text-accent-ink shrink-0" @click="router.push('/me/api?feature=companion')">去设置</button>
              </div>

              <!-- 开始前 -->
              <template v-if="phase === 'setup'">
                <div class="label first">怎么练</div>
                <Segmented v-model="mode" :options="MODE_OPTIONS" />

                <template v-if="mode === 'plan'">
                  <div v-if="!hs" class="notice mt-2.5">
                    <span class="i-lucide-heart-pulse shrink-0" />
                    <span class="flex-1 min-w-0">健康系统没开，没有计划可以照着练：先在人设里打开，或者选"随便动动"</span>
                    <button class="text-accent-ink shrink-0" @click="router.push(`/me/personas/${persona.id}/health`)">去打开</button>
                  </div>
                  <template v-else-if="planWorkout">
                    <div class="plan-box" data-testid="plan-box">
                      <div class="flex items-center gap-2">
                        <span class="flex-1 min-w-0 text-[15px] font-600 truncate">{{ planWorkout.title }}</span>
                        <span class="num text-[12px] text-ink-3 shrink-0">{{ planWorkout.minutes }} 分钟<template v-if="planWorkout.intensity"> · {{ planWorkout.intensity }}</template></span>
                      </div>
                      <div v-for="(s, i) in steps" :key="i" class="step-row">
                        <button type="button" class="step-head" :aria-expanded="openSetupMove === i" @click="openSetupMove = openSetupMove === i ? null : i">
                          <span class="kind">{{ KIND_LABEL[s.kind] }}</span>
                          <span class="flex-1 min-w-0 text-left truncate">{{ s.move.name }}<span class="text-ink-3 text-[12px] num"> · {{ moveAmount(s.move) }}</span></span>
                          <span v-if="s.move.how.length || s.move.tips" class="how">{{ openSetupMove === i ? '收起' : '怎么做' }}</span>
                        </button>
                        <MoveHow v-if="openSetupMove === i" :move="s.move" class="pb-2" />
                      </div>
                    </div>
                  </template>
                  <div v-else-if="plan?.rest" class="notice mt-2.5"><span class="i-lucide-bed shrink-0" /><span class="flex-1">今天的计划是休息；想动的话选"随便动动"</span></div>
                  <div v-else class="plan-box text-center">
                    <div class="text-[14px]">今天的健身计划还没排</div>
                    <p v-if="!healthStatus.live" class="hint !text-center">「健康计划」还没接通：<RouterLink to="/me/api?feature=health" class="text-accent-ink">去设置</RouterLink></p>
                    <p v-else-if="planError" class="hint !text-center text-bad">{{ planError.reason }}</p>
                    <van-button class="!mt-2" size="small" round type="primary" :loading="!!planBusy" :loading-text="planBusy === 'week' ? '在排这周…' : '在排今天…'" :disabled="!healthStatus.live" data-testid="fit-make-plan" @click="makePlan">排今天的计划</van-button>
                  </div>
                </template>

                <template v-else>
                  <div class="label">做什么</div>
                  <div class="flex gap-2 flex-wrap">
                    <button v-for="m in methods" :key="m" type="button" class="chip" :class="{ on: method === m }" :data-method="m" @click="method = m">
                      <span :class="fitMethod(m).icon" />{{ m }}<span v-if="fitMethod(m).outdoor" class="text-[11px] opacity-70">室外</span>
                    </button>
                  </div>
                  <div class="label">练多久</div>
                  <div class="flex gap-2 flex-wrap">
                    <button v-for="t in TARGETS" :key="t" type="button" class="chip num" :class="{ on: targetMin === t }" @click="targetMin = t">{{ t ? `${t} 分钟` : '不定时' }}</button>
                  </div>
                </template>

                <div class="label">记录</div>
                <div class="rec">
                  <div class="rec-row"><span class="i-lucide-timer text-accent-ink" /><span class="flex-1">时长</span><span class="text-[12px] text-ink-3">一直记</span></div>
                  <template v-if="android">
                    <div class="rec-row">
                      <span class="i-lucide-heart-pulse text-accent-ink" />
                      <span class="flex-1 min-w-0">心率<span class="block text-[11.5px] text-ink-3">蓝牙心率带，或者打开手表的"心率广播"</span></span>
                      <span v-if="hr.state.status === 'on'" class="text-[12px] text-good num shrink-0">{{ hr.state.device }}{{ hr.state.bpm ? ` · ${hr.state.bpm}` : '' }}</span>
                      <van-button v-else size="mini" round :loading="hr.state.status === 'connecting'" :disabled="!bluetoothSupported()" data-testid="hr-connect" @click="hr.connect()">连接</van-button>
                    </div>
                    <p v-if="hr.state.error" class="hint text-bad">{{ hr.state.error }}</p>
                    <div v-if="mode === 'free' && outdoor" class="rec-row">
                      <span class="i-lucide-route text-accent-ink" />
                      <span class="flex-1 min-w-0">{{ methodInfo.steps ? '步数和距离' : '距离' }}<span class="block text-[11.5px] text-ink-3">GPS 记距离{{ methodInfo.steps ? '、手机数步（带在身上）' : '' }}；屏幕会保持亮着</span></span>
                      <van-switch v-model="track" size="20px" />
                    </div>
                    <div class="rec-row"><span class="i-lucide-flame text-accent-ink" /><span class="flex-1">消耗</span><span class="text-[12px] text-ink-3">按{{ hs?.weightKg ? '体重' : '强度' }}{{ hs?.age && hs?.sex ? '和心率' : '' }}估</span></div>
                  </template>
                  <p v-else class="hint !mt-1">自动记心率、步数、距离先只支持安卓（Chrome）；在这台设备上练完以后，可以把手表上的心率、消耗{{ outdoor ? '、步数、距离' : '' }}填进来。</p>
                </div>
              </template>

              <!-- 练完 -->
              <template v-else>
                <div class="text-[16px] font-700">{{ mode === 'plan' ? planWorkout?.title ?? '今天的训练' : method }} · 练了 {{ Math.max(1, Math.round(summary.sec / 60)) }} 分钟</div>
                <div class="text-[12.5px] text-ink-3 mt-1">{{ mode === 'plan' ? `做完 ${doneItems} / ${totalMoves} 个动作` : outdoor ? '室外' : '随便动动' }}<template v-if="summary.kcal"> · 约 {{ summary.kcal }} 千卡（{{ summary.kcalBasis }}）</template></div>
                <div class="stat-grid">
                  <div class="stat"><div class="v num">{{ clock(summary.sec) }}</div><div class="k">时长</div></div>
                  <div class="stat"><div class="v num">{{ summary.kcal ?? '—' }}</div><div class="k">千卡</div></div>
                  <div class="stat"><div class="v num">{{ summary.hrAvg ?? '—' }}</div><div class="k">平均心率</div></div>
                  <div v-if="outdoor || summary.km" class="stat"><div class="v num">{{ summary.km ?? '—' }}</div><div class="k">公里{{ summary.pace ? ` · ${summary.pace}` : '' }}</div></div>
                  <div v-if="outdoor || summary.steps" class="stat"><div class="v num">{{ summary.steps ?? '—' }}</div><div class="k">步</div></div>
                </div>
                <div v-if="!sent" class="manual">
                  <div class="text-[12.5px] text-ink-3 mb-1.5">{{ android ? '自动记到的在下面，可以改' : '手表上的数（可以不填）' }}</div>
                  <div class="grid grid-cols-2 gap-2">
                    <label class="mfield"><span>平均心率</span><input v-model="manual.hrAvg" inputmode="numeric" placeholder="—" /></label>
                    <label class="mfield"><span>最高心率</span><input v-model="manual.hrMax" inputmode="numeric" placeholder="—" /></label>
                    <label class="mfield"><span>消耗（千卡）</span><input v-model="manual.kcal" inputmode="numeric" :placeholder="summary.kcal ? `估 ${summary.kcal}` : '—'" /></label>
                    <template v-if="outdoor || mode === 'free'">
                      <label class="mfield"><span>步数</span><input v-model="manual.steps" inputmode="numeric" placeholder="—" /></label>
                      <label class="mfield"><span>距离（公里）</span><input v-model="manual.km" inputmode="decimal" placeholder="—" /></label>
                    </template>
                  </div>
                </div>
              </template>

              <div class="stamps" aria-label="这周练过的日子">
                <div v-for="d in weekDays" :key="d.date" class="stamp" :class="{ on: d.on }">
                  <span v-if="d.on" class="i-lucide-check" />
                  <span class="text-[11px]">{{ d.label }}</span>
                </div>
              </div>
              <div class="stats-line num">这周练了 {{ weekDays.filter((d) => d.on).length }} 天 · {{ weekMinutes }} 分钟<template v-if="hs"> · <RouterLink to="/me/health" class="text-accent-ink">健康计划</RouterLink></template></div>
            </div>
            <div class="split-foot">
              <van-button v-if="phase === 'setup'" type="primary" round block data-testid="fit-begin" :disabled="mode === 'plan' && !steps.length" @click="begin">{{ mode === 'plan' ? '照计划开练' : `开始${method}` }}</van-button>
              <div v-else-if="!sent" class="flex gap-2.5">
                <van-button round block @click="again">不发了，再练一次</van-button>
                <van-button type="primary" round block :loading="sending" data-testid="fit-send" @click="send">发给{{ her.pronoun }}</van-button>
              </div>
              <div v-else class="flex gap-2.5">
                <van-button round block @click="again">再练一次</van-button>
                <van-button type="primary" round block @click="router.push(`/chat/${chatId}`)">回聊天</van-button>
              </div>
            </div>
          </section>
        </template>

        <!-- ============ 练的时候 ============ -->
        <template v-else>
          <div class="shade top" aria-hidden="true" />
          <div class="shade bottom" aria-hidden="true" />

          <div class="her-col">
            <MicLinkBar v-if="link.state.on" :link="link" :pronoun="her.pronoun" />
            <div v-else class="her-card">
              <div class="flex items-center gap-2">
                <Avatar :character="her" :size="24" live />
                <span class="flex-1 min-w-0 text-[12px] text-ink-2 truncate">{{ her.name }} · {{ herState }}</span>
              </div>
            </div>
            <StudyBubble v-if="shownLine || stream" side="her" :text="shownLine" :typing="!!stream && !streamingText" :to="chatLink" :label="`去和${her.name}聊天`" />
            <div v-if="notConnected" class="mini-notice">
              <span class="i-lucide-plug-zap shrink-0" /><span class="flex-1 min-w-0">{{ notConnected }}</span>
              <button class="text-accent-ink shrink-0" @click="router.push('/me/api?feature=companion')">去设置</button>
            </div>
          </div>

          <!-- 照计划：现在这个动作 -->
          <div v-if="mode === 'plan' && current" ref="moveCardEl" class="move-card" data-testid="move-card">
            <div class="flex items-center gap-2">
              <span class="kind">{{ KIND_LABEL[current.kind] }} · {{ stepIndex + 1 }}/{{ steps.length }}</span>
              <span class="flex-1 min-w-0 text-[15.5px] font-700 truncate">{{ current.move.name }}</span>
              <span class="num text-[12.5px] text-accent-ink shrink-0">第 {{ setNo }}/{{ current.move.sets }} 组</span>
            </div>
            <div class="text-[12.5px] text-ink-2 mt-0.5 num">{{ moveAmount(current.move) }}<template v-if="current.move.rest && current.move.sets > 1"> · 组间歇 {{ current.move.rest }} 秒</template></div>
            <!-- 开练了就直接看得到怎么做，不用再点 -->
            <MoveHow :key="stepIndex" :move="current.move" class="how-box" data-testid="move-how" />
            <div class="flex gap-2 mt-2">
              <button type="button" class="act" @click="nextMove(false)">跳过这个</button>
              <button v-if="!resting && !current.move.seconds" type="button" class="act primary" data-testid="set-done" @click="finishSet"><span class="i-lucide-check" />这组做完了</button>
              <span v-else-if="resting" class="act ghost">休息一下，马上下一组</span>
              <span v-else class="act ghost">跟着计时做</span>
            </div>
          </div>

          <!-- 数 -->
          <div class="stat-strip" data-testid="fit-stats">
            <span><b class="num">{{ clock(activeSec) }}</b>时长</span>
            <span v-if="hr.state.status === 'on' || hr.state.bpm"><b class="num">{{ hr.state.bpm || '—' }}</b>心率</span>
            <span><b class="num">{{ kcalLive.kcal }}</b>千卡</span>
            <span v-if="stepCounter.state.on"><b class="num">{{ stepCounter.state.steps }}</b>步</span>
            <span v-if="gps.state.on"><b class="num">{{ gps.state.km.toFixed(2) }}</b>公里 · {{ paceLive }}</span>
          </div>
          <p v-if="gps.state.error || stepCounter.state.error" class="sensor-err">{{ gps.state.error || stepCounter.state.error }}</p>

          <nav class="bottom-bar" aria-label="健身时">
            <button type="button" class="pill" :class="{ on: fitMusic.state.playing }" :aria-expanded="musicOpen" aria-label="音乐" @click="musicOpen = !musicOpen">
              <span class="i-lucide-music shrink-0" /><span class="max-w-[5em] truncate">{{ fitMusic.state.playing ? (fitMusic.current()?.title ?? '音乐') : '音乐' }}</span>
            </button>
            <form class="chat-form" @submit.prevent="sendChat">
              <input v-model="chatText" class="chat-input" :placeholder="`跟${her.pronoun}说一句`" aria-label="边练边聊" enterkeyhint="send" />
              <button type="submit" class="pill icon" :disabled="(!link.state.on && !!stream) || !chatText.trim()" aria-label="发送"><span class="i-lucide-send" /></button>
            </form>
          </nav>

          <!-- 计时器：半透明，按住拖到哪儿都行（不挡她、不挡动作），位置记在本机 -->
          <div class="ring-track">
            <div
              ref="ringEl"
              class="ring-disc"
              :class="{ dragging: ringDragging }"
              :style="ringStyle"
              role="timer"
              :aria-label="`${display.label}：${clock(display.sec)}（按住可以拖动）`"
              data-testid="fit-ring"
              v-on="ringListeners"
              @click.capture="ringClickCapture"
            >
              <span class="grip i-lucide-grip-horizontal" aria-hidden="true" />
              <TimerRing :remain-sec="display.sec" :total-sec="display.total" :count-up="display.countUp" :size="156" :label="paused ? '暂停中' : display.label" :tone="display.tone">
                <div class="ctrls mt-1.5">
                  <button type="button" class="mini-c" :aria-label="paused ? '继续' : '暂停'" @click="togglePause"><span :class="paused ? 'i-lucide-play' : 'i-lucide-pause'" /></button>
                  <button v-if="resting" type="button" class="mini-c wide" @click="skipRest"><span class="i-lucide-skip-forward" />跳过</button>
                  <button type="button" class="mini-c wide" data-testid="fit-end" @click="finish()">结束</button>
                </div>
              </TimerRing>
            </div>
          </div>
          <template v-if="musicOpen">
            <div class="pop-catcher" @click="musicOpen = false" />
            <div class="music-pop" role="dialog" aria-label="音乐">
              <PlaylistMusic :player="fitMusic" :searches="FIT_SEARCHES" test-id="fit-music" />
            </div>
          </template>
        </template>
      </div>
    </template>
  </SceneShell>
</template>

<style scoped>
.fit {
  position: absolute;
  inset: 0;
  z-index: 6;
  pointer-events: none;
}
.fit > * {
  pointer-events: auto;
}
.fit > .shade,
.fit > .ring-track {
  pointer-events: none;
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
.mic-pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  flex-shrink: 0;
  height: 38px;
  padding: 0 13px;
  border-radius: 99px;
  background: var(--glass);
  border: 1px solid var(--glass-line);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  color: var(--accent-ink);
  font-size: 13.5px;
  white-space: nowrap;
}
.mic-pill.live {
  background: var(--bad);
  border-color: transparent;
  color: #fff;
}
.split-link {
  position: absolute;
  top: calc(var(--safe-top) + 58px);
  left: 12px;
  right: 12px;
}

/* —— 开始前 / 练完：上下各一半 —— */
.plan-card,
.done-say {
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: calc(50% + 12px);
}
.plan-card {
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
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.slot.now {
  background: var(--accent-soft);
  color: var(--accent-ink);
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
.plan-box {
  margin-top: 10px;
  padding: 10px 12px;
  border-radius: 16px;
  background: var(--panel);
}
.step-row {
  border-top: 1px solid var(--border);
  margin-top: 6px;
}
.step-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding-top: 6px;
  font-size: 14px;
}
.kind {
  flex-shrink: 0;
  height: 20px;
  padding: 0 7px;
  border-radius: 6px;
  background: var(--surface);
  color: var(--ink-3);
  font-size: 11px;
  line-height: 20px;
}
.how {
  flex-shrink: 0;
  height: 22px;
  padding: 0 8px;
  border-radius: 99px;
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: 11.5px;
  line-height: 22px;
}
.rec {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 2px;
}
.rec-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 2px;
  font-size: 14px;
}
.stat-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin-top: 10px;
}
.stat {
  padding: 8px 10px;
  border-radius: 14px;
  background: var(--panel);
}
.stat .v {
  font-size: 20px;
  font-weight: 700;
  line-height: 1.15;
}
.stat .k {
  font-size: 11.5px;
  color: var(--ink-3);
}
.manual {
  margin-top: 12px;
}
.mfield {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 12px;
  color: var(--ink-3);
}
.mfield input {
  height: 34px;
  padding: 0 10px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--ink);
  outline: none;
  font-size: 14px;
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
.stats-line {
  margin-top: 10px;
  font-size: 12.5px;
  color: var(--ink-3);
  text-align: center;
}

/* —— 练的时候 —— */
.shade {
  position: absolute;
  left: 0;
  right: 0;
}
.shade.top {
  top: 0;
  height: 150px;
  background: linear-gradient(to bottom, rgba(0, 0, 0, 0.28), transparent);
}
.shade.bottom {
  bottom: 0;
  height: 220px;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.32), transparent);
}
.her-col {
  position: absolute;
  top: calc(var(--safe-top) + 58px);
  left: 12px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  width: min(64%, 270px);
}
.her-col :deep(.bubble) {
  max-height: 7.2em;
}
.her-card {
  display: block;
  width: 100%;
  padding: 8px 12px;
  border-radius: 16px;
  background: var(--veil);
  border: 1px solid var(--glass-line);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  box-shadow: var(--shadow-sm);
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
}
/* 计时器能拖动的范围：顶栏下面到底栏上面 */
.ring-track {
  position: absolute;
  top: calc(var(--safe-top) + 56px);
  bottom: calc(var(--safe-bottom) + 54px);
  left: 8px;
  right: 8px;
}
.ring-disc {
  position: absolute;
  pointer-events: auto;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  cursor: grab;
  border-radius: 50%;
  /* 半透明：透过去看得到她和背景 */
  background: rgba(127, 127, 127, 0.18);
  background: color-mix(in srgb, var(--veil) 55%, transparent);
  border: 1px solid var(--glass-line);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  transition: box-shadow 0.15s ease, background-color 0.15s ease;
}
.ring-disc.dragging {
  cursor: grabbing;
  background: var(--veil);
  box-shadow: var(--shadow);
}
.ring-disc :deep(.timer-ring) {
  --ring-track: rgba(127, 127, 127, 0.25);
}
.ring-disc .grip {
  position: absolute;
  top: 15px;
  left: 50%;
  transform: translateX(-50%);
  font-size: 14px;
  color: var(--ink-3);
  opacity: 0.8;
}
.ctrls {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}
.mini-c {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  min-width: 30px;
  height: 30px;
  padding: 0 8px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 12.5px;
  font-weight: 600;
}
.mini-c.wide {
  padding: 0 10px;
}
.move-card {
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: calc(var(--safe-bottom) + 112px);
  padding: 10px 12px;
  border-radius: 18px;
  background: var(--glass-strong);
  border: 1px solid var(--glass-line);
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
  box-shadow: var(--shadow-sm);
}
.how-box {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--border);
  max-height: 26vh;
  overflow-y: auto;
  overscroll-behavior: contain;
}
/* 练的时候的步骤说明：字小一点、行挨紧一点（健康计划页里的照旧） */
.move-card .how-box {
  font-size: 12.5px;
  line-height: 1.45;
}
.how-box :deep(.steps li + li) {
  margin-top: 1px;
}
.how-box :deep(.line) {
  gap: 5px;
  margin-top: 3px;
}
.how-box :deep(.line > span:first-child) {
  margin-top: 2px;
}
.act {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 34px;
  padding: 0 12px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 13px;
}
.act.primary {
  flex: 1;
  background: var(--accent);
  color: var(--on-accent);
  font-weight: 600;
}
.act.ghost {
  flex: 1;
  background: transparent;
  color: var(--ink-3);
}
.stat-strip {
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: calc(var(--safe-bottom) + 60px);
  display: flex;
  gap: 6px;
  overflow-x: auto;
}
.stat-strip > span {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  flex-shrink: 0;
  height: 30px;
  padding: 0 10px;
  border-radius: 99px;
  background: var(--glass);
  border: 1px solid var(--glass-line);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  font-size: 11.5px;
  line-height: 30px;
  color: var(--ink-2);
}
.stat-strip b {
  font-size: 14px;
  color: var(--ink);
}
.sensor-err {
  position: absolute;
  left: 14px;
  right: 14px;
  bottom: calc(var(--safe-bottom) + 94px);
  margin: 0;
  font-size: 11.5px;
  color: var(--bad);
}
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
.music-pop {
  position: absolute;
  left: 10px;
  right: 10px;
  bottom: calc(var(--safe-bottom) + 56px);
  max-height: 60%;
  overflow-y: auto;
  padding: 4px 14px 14px;
  border-radius: 18px;
  background: var(--glass-strong);
  border: 1px solid var(--glass-line);
  backdrop-filter: blur(22px);
  -webkit-backdrop-filter: blur(22px);
  box-shadow: var(--shadow);
}
</style>
