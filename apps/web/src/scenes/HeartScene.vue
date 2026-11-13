<script setup lang="ts">
import { errorText } from '@app/ai';
import { DEVICE_INLINE_FLAG, getLocation, parseDeviceBlock, placeSteps, type ControlTagKind, type ParsedReply } from '@app/shared';
import { showImagePreview, showToast } from 'vant';
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import Waveform from '@/components/call/Waveform.vue';
import AssetImg from '@/components/common/AssetImg.vue';
import Avatar from '@/components/common/Avatar.vue';
import Segmented from '@/components/common/Segmented.vue';
import HeartPulse from '@/components/scene/heart/HeartPulse.vue';
import ToyPanel from '@/components/scene/heart/ToyPanel.vue';
import { SCENE_LOCATION } from '@/components/scene/location';
import SceneShell from '@/components/scene/SceneShell.vue';
import StudyBubble from '@/components/scene/study/StudyBubble.vue';
import PresetPicker from '@/components/settings/PresetPicker.vue';
import { useMicLink } from '@/composables/useMicLink';
import { assetUrl } from '@/services';
import { personaOf } from '@/services/prompt';
import { SpeechQueue } from '@/services/speech';
import { ReplyTimeline, type TimedCommand } from '@/services/toyPlayer';
import { useAiStore } from '@/stores/ai';
import { useAppStore } from '@/stores/app';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';
import { useGalleryStore, type GalleryItem } from '@/stores/gallery';
import { useLibraryStore } from '@/stores/library';
import { useRealWorldStore } from '@/stores/realworld';
import { useToyStore } from '@/stores/toys';
import { sleep } from '@/utils/id';
import { hhmm } from '@/utils/time';

/**
 * 心跳（设计文档 §9.14）：只属于你们两个人的时间。画面照"陪伴学习 · 一起专注"的样子：背景图铺满整屏、是视觉中心，
 * 左上只放她的名字（和没接通之类的提示），你们说的话像字幕一样在下面三分之一（不挡脸），
 * 最下面是心跳（心率、心电图、玩具的强度、停）和打字 / 连麦。
 *
 * - 背景：NovelAI 按"心跳"的生图预设画（氛围 / 第一视角 / 亲密，设置 → 画面里换），竖图铺满屏幕；
 *   进来时用今天在同一个地方画过的，没有就画一张"开场"；之后每几句换一张"这一刻"（可以关），右上角魔杖马上画。衣服不锁，按对话画。
 * - 打字：主对话按"心跳"功能预设（心跳 · 文字）回；连麦：「陪伴 · 快速」按"心跳 · 语音"预设回，用她的声音念
 *   （composables/useMicLink.ts，和哄睡的连麦一样：说话检测 → 语音识别 → 流式回复 → 按句合成）。两种的预设在设置 → 预设里换。
 * - 玩具：Intiface Central（stores/toys.ts）。指令默认由"控制指令"预设按她每一句话单独写（单独生成），也可以让她在回复里自己写 <device>；
 *   读到 / 念到那几个字时执行（services/toyPlayer.ts 的 ReplyTimeline），强度不超过你设的上限。
 *   "停"一下全部停下，之后她的指令先不执行；离开心跳、切到后台（可以关）、很久没有新指令时也停下。
 * - 动效：图慢慢推近、换图时淡入；心按心率跳，心电图一拍走一格；玩具动起来时屏幕边缘跟着心跳泛红、飘起小心心（系统设置了减少动态效果时都不动）。
 * 说的话都存进你们的聊天，离开时那一段写"心跳 N 分钟"。没接通时不出演示台词，写明原因。
 */
const app = useAppStore();
const chars = useCharacterStore();
const chat = useChatStore();
const ai = useAiStore();
const gallery = useGalleryStore();
const lib = useLibraryStore();
const toys = useToyStore();
const real = useRealWorldStore();
const router = useRouter();
const location = inject(SCENE_LOCATION, ref(null));

const her = computed(() => chars.byId(app.activeCharacterId) ?? chars.list[0]!);
const chatId = computed(() => chat.chatOfCharacter(her.value.id)?.id ?? '');
const persona = computed(() => personaOf(chat.chatById(chatId.value)));
const userName = computed(() => persona.value.name);
const mode = computed(() => chat.chatOfCharacter(her.value.id)?.togetherMode ?? 'remote');
const herWhere = computed(() => location.value?.name ?? `${her.value.pronoun}那边`);
const yourPlace = computed(() => getLocation(real.hereId)?.name ?? '家');
const togetherText = computed(() => {
  if (mode.value === 'visit') return `你在${her.value.pronoun}身边 · ${herWhere.value}`;
  if (mode.value === 'bring') return `${her.value.pronoun}在你这边`;
  return `连线 · ${her.value.pronoun}在${herWhere.value}，你在${yourPlace.value}`;
});
const startedAt = Date.now();
const now = ref(Date.now());

// —— 本机记住的：打字还是连麦、多久换一张图 ——
const SAVE_KEY = 'ai-mobile:heart';
function loadSaved(): { input?: string; artEvery?: number } {
  try {
    const v = JSON.parse(localStorage.getItem(SAVE_KEY) ?? '{}') as unknown;
    return v && typeof v === 'object' ? (v as { input?: string; artEvery?: number }) : {};
  } catch {
    return {};
  }
}
const saved = loadSaved();
const inputMode = ref<'type' | 'voice'>(saved.input === 'voice' ? 'voice' : 'type');
/** 她说几句换一张"这一刻"；0 = 不自动换 */
const artEvery = ref([0, 4, 6, 8].includes(saved.artEvery ?? -1) ? (saved.artEvery as number) : 6);
watch([inputMode, artEvery], () => {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({ input: inputMode.value, artEvery: artEvery.value }));
  } catch {
    // 存不下：这次打开仍然有效
  }
});
const ART_EVERY = [
  { v: 0, label: '不自动换' },
  { v: 4, label: '每 4 句' },
  { v: 6, label: '每 6 句' },
  { v: 8, label: '每 8 句' },
];

// —— 玩具的指令：每一句话一条时间线，读到 / 念到那里时执行 ——
/** 连麦时她念一个字大约多久（毫秒） */
const SPEAK_MS_PER_CHAR = 210;
let timeline: ReplyTimeline | null = null;
let directCtrl: AbortController | null = null;
/** 这一句里已经放进时间线的 <device> 有几个 */
let inlineSeen = 0;
const deviceIssue = ref<{ text: string; settings: boolean } | null>(null);
const inlineOn = computed(() => toys.wanted && toys.settings.source === 'inline');
const replyTags = (): ControlTagKind[] => (inlineOn.value ? ['expr', 'device'] : ['expr']);
const replyFlags = (): string[] => (inlineOn.value ? [DEVICE_INLINE_FLAG] : []);

function newTimeline(kind: 'read' | 'speech'): ReplyTimeline | null {
  timeline?.dispose();
  directCtrl?.abort();
  directCtrl = null;
  inlineSeen = 0;
  timeline = toys.wanted ? new ReplyTimeline(kind, kind === 'read' ? 1000 / toys.settings.readCps : SPEAK_MS_PER_CHAR, (cmd) => toys.apply(cmd)) : null;
  return timeline;
}

/** 她的回复写到哪了：正文交给时间线；她自己写的 <device> 按位置放进去 */
function onParsed(p: ParsedReply, done: boolean) {
  const tl = timeline;
  if (!tl) return;
  const visible = p.visible.trimStart();
  const lead = p.visible.length - visible.length;
  tl.setText(visible, done);
  if (toys.settings.source !== 'inline') return;
  const blocks = p.tags.filter((t) => t.tag.kind === 'device');
  const fresh = blocks.slice(inlineSeen);
  inlineSeen = blocks.length;
  const steps: TimedCommand[] = [];
  for (const t of fresh) {
    const cmd = parseDeviceBlock('value' in t.tag ? t.tag.value : '');
    if (cmd) steps.push({ pos: Math.max(0, t.at - lead), command: cmd });
  }
  if (steps.length) tl.add(steps);
}

/** 单独生成："控制指令"预设按她这句话写指令，放到原话的位置上 */
async function direct(text: string, tl: ReplyTimeline | null) {
  if (!tl || toys.settings.source !== 'separate' || !text.trim()) return;
  directCtrl?.abort();
  const ctrl = new AbortController();
  directCtrl = ctrl;
  try {
    const recent = chat.recentLines(chatId.value, 7).slice(0, -1);
    const steps = await toys.writeCommands({ character: her.value, userName: userName.value, line: text, recent, signal: ctrl.signal });
    if (ctrl.signal.aborted || timeline !== tl) return;
    tl.add(placeSteps(steps, text));
    deviceIssue.value = null;
  } catch (e) {
    if (ctrl.signal.aborted) return;
    const msg = errorText(e);
    deviceIssue.value = { text: `控制指令没写出来：${msg}`, settings: /没接通|预设/.test(msg) };
  }
}

function stopToys() {
  timeline?.dispose();
  timeline = null;
  directCtrl?.abort();
  toys.stopAll(true);
  showToast({ message: '都停下了，点 ▶ 再让她接着来', duration: 1800 });
}

// —— 她说的话（打字）：主对话按"心跳 · 文字"回 ——
const herLine = ref('');
const herIssue = ref('');
const notConnected = ref('');
const myLine = ref('');
const myLineUntil = ref(0);
const stream = computed(() => (chatId.value ? chat.streams[chatId.value] : undefined));
const streamingText = computed(() => (stream.value ? (chat.list(chatId.value).find((m) => m.id === stream.value!.messageId)?.text ?? '') : ''));

/** 现在的情况：几点、怎么在一起、玩具（写进场景任务） */
function situation(): string {
  const how =
    mode.value === 'visit'
      ? `${userName.value}来到了你身边（在${herWhere.value}）`
      : mode.value === 'bring'
        ? `你在${userName.value}那边，在${userName.value}身边`
        : `连线：你在${herWhere.value}，${userName.value}在${yourPlace.value}`;
  return [`现在 ${hhmm(Date.now())}`, how, toyLine()].filter(Boolean).join('\n');
}
function toyLine(): string {
  if (!toys.live) return `${userName.value}没连玩具`;
  if (toys.held) return `${userName.value}刚按了停，玩具先停着，等${userName.value}说继续`;
  const names = toys.ready ? toys.devices.map((d) => d.name).join('、') : '（没连真的玩具，只在界面上显示）';
  const line = `${userName.value}连着玩具：${names}；玩具现在：${toys.nowLine()}`;
  if (toys.settings.source !== 'inline') return line;
  return `${line}\n能写的键：\n${toys.toysLine()}\n${toys.limitsLine()}`;
}

async function herTurn(task: 'heart-open' | 'heart-chat') {
  const id = chatId.value;
  if (!id) return;
  const s = ai.status('main');
  if (!s.live) {
    notConnected.value = `${her.value.name}先不说话：${s.reason}`;
    return;
  }
  notConnected.value = '';
  if (chat.streams[id]) {
    chat.stop(id);
    for (let i = 0; i < 40 && chat.streams[id]; i += 1) await sleep(50);
  }
  const tl = newTimeline('read');
  const input = task === 'heart-open' ? `${situation()}\n${userName.value}刚来到"心跳"。你先开口。` : `${situation()}\n回${userName.value}刚才说的话。`;
  const msgId = await chat.generate(id, undefined, { agent: 'main', task: { name: task, input }, allowedTags: replyTags(), flags: replyFlags(), onParsed });
  const msg = msgId ? chat.list(id).find((m) => m.id === msgId) : undefined;
  if (!msg || msg.meta.interrupted) return;
  if (msg.meta.error) {
    herIssue.value = `${her.value.name}没回上：${msg.meta.error}`;
    return;
  }
  herIssue.value = '';
  herLine.value = msg.text;
  noteReply();
  void direct(msg.text, tl);
}

const text = ref('');
async function sendText() {
  const t = text.value.trim();
  const id = chatId.value;
  if (!t || !id || stream.value) return;
  text.value = '';
  myLine.value = t;
  myLineUntil.value = Date.now() + 40_000;
  chat.push(id, 'user', [{ type: 'text', text: t }], { meta: { scene: 'heart' } });
  await herTurn('heart-chat');
}

// —— 连麦：「陪伴 · 快速」按"心跳 · 语音"回，用她的声音念 ——
const level = ref(0);
let speech: SpeechQueue | null = null;
function newSpeech(o: { onSentence?(text: string, i: number): void } = {}): SpeechQueue {
  speech?.stop();
  const tl = timeline;
  const q = new SpeechQueue({
    characterId: her.value.id,
    onLevel: (l) => (level.value = l),
    onSentence: (t, i) => {
      tl?.sentence(t);
      o.onSentence?.(t, i);
    },
  });
  speech = q;
  // 念完了：剩下的指令都执行；被打断、挂断了：这句剩下的不再执行
  void q.drained().then(() => {
    if (timeline !== tl || !tl) return;
    if (q.stopped) tl.dispose();
    else tl.drained();
  });
  return q;
}
const link = useMicLink({
  chatId,
  character: her,
  userName,
  newSpeech: (o) => newSpeech({ onSentence: o.onSentence }),
  context: () => situation(),
  herBusy: () => false,
  onInterrupt: () => undefined,
  autoWhisper: () => true,
  tasks: { reply: 'heart-call', whisper: 'heart-murmur' },
  use: 'heart-voice',
  flags: replyFlags,
  allowedTags: replyTags,
  onTurnStart: () => void newTimeline('speech'),
  onParsed,
  onReply: (t) => {
    herLine.value = t;
    noteReply();
    void direct(t, timeline);
  },
  input: (kind, info) =>
    kind === 'open'
      ? `${info.context}\n你们刚连上麦，${userName.value}戴着耳机。你先开口，1–2 个短句。`
      : kind === 'whisper'
        ? `${info.context}\n连麦中（已经连了 ${info.linked}），${userName.value}安静了 ${info.quietMin} 分钟。`
        : `${info.context}\n连麦中（已经连了 ${info.linked}）。回${userName.value}刚才说的话。`,
});
const linkStatus = computed(() => {
  const s = link.state;
  const p = her.value.pronoun;
  if (s.her === 'speaking') return `${p}在说……`;
  if (s.her === 'thinking') return `${p}在想……`;
  if (s.you === 'recognizing') return '在听清你说的话……';
  if (s.you === 'speaking') return '在听你说……';
  if (s.muted) return '你闭麦了';
  return `说话${p}就听得到`;
});
const typed = ref('');
function sendTyped() {
  const t = typed.value.trim();
  if (!t) return;
  typed.value = '';
  void link.say(t);
}
function switchInput() {
  if (inputMode.value === 'type') {
    if (stream.value) chat.stop(chatId.value);
    inputMode.value = 'voice';
  } else {
    void link.hangUp();
    inputMode.value = 'type';
  }
}

// —— 气泡：她最近说的那句、你刚说的 ——
const lastCaption = computed(() => [...link.state.captions].reverse().find((c) => c.who === 'her')?.text ?? '');
const lastYou = computed(() => [...link.state.captions].reverse().find((c) => c.who === 'you')?.text ?? '');
const voiceOn = computed(() => inputMode.value === 'voice' && link.state.on);
const shownLine = computed(() => {
  if (voiceOn.value && lastCaption.value) return lastCaption.value;
  return streamingText.value || herLine.value;
});
const herTyping = computed(() => (!!stream.value && !streamingText.value) || link.state.her === 'thinking');
const shownMine = computed(() => (voiceOn.value ? lastYou.value : myLine.value && now.value < myLineUntil.value ? myLine.value : ''));

/** 这一次说过的话（点她的气泡展开） */
const logOpen = ref(false);
const logEl = ref<HTMLElement | null>(null);
const transcript = computed(() =>
  chat
    .list(chatId.value)
    .filter((m) => m.createdAt >= startedAt && (m.role === 'user' || m.role === 'assistant') && m.text.trim())
    .slice(-40),
);
watch([logOpen, () => transcript.value.length, () => transcript.value.at(-1)?.text], async () => {
  if (!logOpen.value) return;
  await nextTick();
  if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight;
});

// —— 背景图："心跳"的生图预设，竖图铺满屏幕 ——
const art = ref<GalleryItem | null>(null);
const sessionArt = ref<GalleryItem[]>([]);
const artIssue = ref<{ text: string; settings: boolean } | null>(null);
const drawingNow = computed(() => gallery.isDrawing(her.value.id, 'heart'));
const drawingText = computed(() => {
  const d = drawingNow.value;
  if (!d) return null;
  const what = d.moment === 'open' ? '开场' : '这一刻';
  return d.stage === 'queued' ? `${what}：排队等前一张画完` : d.stage === 'prompt' ? `${what}：正在写 tags` : `${what}：正在画`;
});
let repliesSinceArt = 0;
let autoNoted = false;

function captionFor(moment: 'open' | 'now'): string {
  const how = mode.value === 'visit' ? `${userName.value}在${her.value.pronoun}身边` : `${her.value.name}在${herWhere.value}，和${userName.value}连线`;
  if (moment === 'open') return `${userName.value}刚来，${her.value.name}在等${userName.value}；${how}`;
  const heat = toys.intensity >= 60 ? '；气氛正浓，心跳很快' : toys.intensity > 0 ? '；气氛渐渐升温' : '';
  return `${her.value.name}此刻的样子（按最近的对话）；${how}${heat}`;
}
async function drawMoment(moment: 'open' | 'now', priority: 'user' | 'auto') {
  if (priority === 'auto') {
    const chk = gallery.autoCheck();
    if (!chk.ok) {
      if (!autoNoted && chk.reason !== '自动画关着') artIssue.value = { text: `背景先用立绘：${chk.reason}`, settings: /没接通|API 设置/.test(chk.reason) };
      autoNoted = true;
      return;
    }
  }
  const r = await gallery.draw({
    characterId: her.value.id,
    sceneId: 'heart',
    moment,
    caption: captionFor(moment),
    priority,
    locationId: location.value?.id ?? null,
    expression: chars.expression[her.value.id],
    recent: chatId.value ? chat.recentLines(chatId.value, 6) : [],
    size: 'portrait',
    lockOutfit: false,
  });
  if (r.ok) {
    art.value = r.item;
    sessionArt.value.push(r.item);
    artIssue.value = null;
    repliesSinceArt = 0;
  } else if (!r.busy) artIssue.value = { text: `没画出来：${r.reason}`, settings: /没接通/.test(r.reason) };
}
/** 进来时：今天在同一个地方画过的直接用，没有就画一张"开场" */
function ensureArt() {
  const found = gallery.find(her.value.id, 'heart', { today: true, locationId: location.value?.id ?? null, size: 'portrait' })[0];
  if (found) art.value = found;
  else void drawMoment('open', 'auto');
}
function drawNow() {
  if (drawingNow.value?.priority === 'user') {
    showToast('正在画上一张，等一下');
    return;
  }
  void drawMoment('now', 'user');
}
function noteReply() {
  repliesSinceArt += 1;
  if (artEvery.value > 0 && repliesSinceArt >= artEvery.value && !drawingNow.value) void drawMoment('now', 'auto');
}
async function preview(item: { assetKey: string | null; url?: string } | null) {
  if (!item) return;
  const url = item.assetKey ? await assetUrl(item.assetKey) : (item.url ?? null);
  if (url) showImagePreview({ images: [url], closeable: true, showIndex: false });
  else showToast('本机找不到这张图了');
}
async function previewSession(start: number) {
  const urls = await Promise.all(sessionArt.value.map(async (i) => (i.assetKey ? await assetUrl(i.assetKey) : (i.url ?? null))));
  const images = urls.filter((u): u is string => !!u);
  if (images.length) showImagePreview({ images, startPosition: Math.min(start, images.length - 1), closeable: true });
}

// —— 心跳：玩具越激烈跳得越快；她说话时快一点 ——
const speaking = computed(() => link.state.her === 'speaking' || !!stream.value);
const targetBpm = computed(() => Math.round(68 + (speaking.value ? 6 : 0) + toys.intensity * 0.9));
const bpm = ref(68);
let peak = 0;
const beatMs = computed(() => Math.round(60_000 / Math.max(40, bpm.value)));
/** 屏幕边缘泛红、底下的光晕多亮（0–1） */
const glow = computed(() => Math.min(1, toys.intensity / 100 + (speaking.value ? 0.12 : 0)));

/** 飘起来的小心心（实心的，lucide 只有空心的） */
const HEART_PATH = 'M12 20.5C6 16 2.5 12.5 2.5 8.6 2.5 5.7 4.8 3.5 7.5 3.5c1.9 0 3.5 1.1 4.5 2.7 1-1.6 2.6-2.7 4.5-2.7 2.7 0 5 2.2 5 5.1 0 3.9-3.5 7.4-9.5 11.9z';
const hearts = ref<{ id: number; x: number; size: number; dur: number; drift: number }[]>([]);
let heartSeq = 0;
const reduceMotion = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
function spawnHeart() {
  if (reduceMotion || document.visibilityState !== 'visible') return;
  const heat = toys.intensity;
  const chance = heat >= 25 ? Math.min(0.9, heat / 100 + 0.15) : speaking.value ? 0.18 : 0;
  if (Math.random() > chance || hearts.value.length >= 14) return;
  const h = { id: (heartSeq += 1), x: 30 + Math.random() * 40, size: 10 + Math.random() * (8 + heat / 8), dur: 2600 + Math.random() * 1800, drift: (Math.random() - 0.5) * 70 };
  hearts.value.push(h);
  setTimeout(() => (hearts.value = hearts.value.filter((x) => x.id !== h.id)), h.dur + 100);
}
let beatTimer: ReturnType<typeof setTimeout> | undefined;
function beatLoop() {
  spawnHeart();
  beatTimer = setTimeout(beatLoop, beatMs.value);
}
let clockTimer: ReturnType<typeof setInterval> | undefined;
function stepClock() {
  now.value = Date.now();
  const target = targetBpm.value;
  const next = bpm.value + Math.sign(target - bpm.value) * Math.max(1, Math.round(Math.abs(target - bpm.value) * 0.2));
  bpm.value = Math.abs(target - bpm.value) <= 1 ? target : next;
  if (toys.intensity > 0) peak = Math.max(peak, bpm.value);
}

const pulseStatus = computed(() => {
  const doing = Object.values(toys.levels.doing)[0];
  if (toys.held) return '按了停 · 点 ▶ 再让她接着来';
  if (toys.notice) return toys.notice;
  if (toys.status === 'connecting') return '正在连 Intiface Central…';
  if (toys.ready) return `${toys.devices.map((d) => d.name).join('、')} · ${doing ?? (toys.settings.source === 'off' ? '指令关着' : `等${her.value.pronoun}的指令`)}`;
  if (toys.status === 'connected') return '连上了 Intiface，还没有玩具 · 点这里找';
  if (toys.settings.simulate) return `只在界面上试 · ${doing ?? `等${her.value.pronoun}的指令`}`;
  return toys.error ? '没连上玩具 · 点这里看为什么' : '没连玩具 · 点这里连';
});

// —— 写一行的提示：没接通、没画出来、指令没写出来…… ——
const notices = computed(() => {
  const out: { key: string; icon: string; text: string; action?: { label: string; run(): void } }[] = [];
  if (notConnected.value) out.push({ key: 'main', icon: 'i-lucide-plug-zap', text: notConnected.value, action: { label: '去设置', run: () => void router.push('/me/api?feature=main') } });
  const li = inputMode.value === 'voice' ? link.state.llmIssue || link.state.micIssue || link.state.sttIssue : '';
  if (li) out.push({ key: 'link', icon: 'i-lucide-mic-off', text: li, action: /接通/.test(li) ? { label: '去设置', run: () => void router.push(`/me/api?feature=${/语音识别/.test(li) ? 'stt' : 'companion'}`) } : undefined });
  if (herIssue.value) out.push({ key: 'her', icon: 'i-lucide-message-circle-warning', text: herIssue.value });
  if (deviceIssue.value) {
    const d = deviceIssue.value;
    out.push({ key: 'device', icon: 'i-lucide-activity', text: d.text, action: d.settings ? { label: '去设置', run: () => void router.push('/me/api?feature=device') } : undefined });
  }
  if (artIssue.value) {
    const a = artIssue.value;
    out.push({ key: 'art', icon: 'i-lucide-image-off', text: a.text, action: a.settings ? { label: '去设置', run: () => void router.push('/me/api?feature=image') } : { label: '重试', run: () => void drawMoment('now', 'user') } });
  }
  return out.slice(0, 3);
});

// —— 设置：玩具 / 画面 / 预设 ——
type Tab = 'toys' | 'art' | 'presets';
const TABS: { value: Tab; label: string; icon: string }[] = [
  { value: 'toys', label: '玩具', icon: 'i-lucide-activity' },
  { value: 'art', label: '画面', icon: 'i-lucide-image' },
  { value: 'presets', label: '预设', icon: 'i-lucide-scroll-text' },
];
type PresetTab = 'text' | 'voice' | 'device';
const PRESET_TABS: { value: PresetTab; label: string }[] = [
  { value: 'text', label: '打字' },
  { value: 'voice', label: '连麦' },
  { value: 'device', label: '控制指令' },
];
const PRESET_HINT: Record<PresetTab, string> = {
  text: '打字聊天时她怎么说（主对话的模型）。自带"心跳 · 文字"；也可以跟随这个角色自己的对话预设。',
  voice: '连麦时她怎么说（「陪伴 · 快速」的模型，边写边念）。自带"心跳 · 语音"：短句、口语、不写动作。',
  device: '玩具的指令怎么写（"单独生成"时用，「控制指令」的模型）：轻重怎么对应剧情、变速怎么写。',
};
const settingsOpen = ref(false);
const tab = ref<Tab>(toys.status === 'connected' ? 'art' : 'toys');
const presetTab = ref<PresetTab>('text');
function openSettings(t?: Tab) {
  if (t) tab.value = t;
  settingsOpen.value = true;
}
const imageFollowLabel = computed(() => `用"配图"选的那个（${lib.presetForUse('image')?.name ?? '没有生图预设'}）`);
/** 预设列表里先列心跳的（名字里带"心跳"的，包括复制出来的） */
const heartFirst = (p: { name: string }) => p.name.includes('心跳');
function pickImagePreset(id: string | null) {
  lib.setUse('image:heart', id);
  showToast('换好了：点右上角的魔杖按新的画一张');
}

// —— 进来、离开 ——
function summary(): string | undefined {
  const said = transcript.value.length;
  if (!said) return undefined;
  const min = Math.max(1, Math.round((Date.now() - startedAt) / 60_000));
  return `心跳 ${min} 分钟${peak >= 90 ? ` · 最快 ${peak}` : ''}`;
}
function onVisibility() {
  if (document.visibilityState === 'hidden' && toys.settings.stopOnHide && toys.live) toys.stopAll(false, toys.intensity > 0 ? '切到后台了，先停下了' : '');
}

onMounted(() => {
  document.addEventListener('visibilitychange', onVisibility);
  chat.setLeaveSummary(her.value.id, summary);
  ensureArt();
  if (toys.settings.autoConnect && toys.status === 'idle') void toys.connect();
  if (inputMode.value === 'type') void herTurn('heart-open');
  clockTimer = setInterval(stepClock, 400);
  beatLoop();
});
onBeforeUnmount(() => {
  // 离开时那一段的总结已经在离开前取走了（ScenePage 的 onBeforeRouteLeave）
  chat.setLeaveSummary(her.value.id, null);
  document.removeEventListener('visibilitychange', onVisibility);
  clearInterval(clockTimer);
  clearTimeout(beatTimer);
  timeline?.dispose();
  directCtrl?.abort();
  link.dispose();
  speech?.stop();
  if (chat.streams[chatId.value]) chat.stop(chatId.value);
  toys.stopAll(false);
});

/** 没画好图时立绘坐在心跳上面 */
const figureLayout = { left: 50, bottom: 16, height: 70 };
</script>

<template>
  <SceneShell scene-id="heart" bare pose="sit" :layout="figureLayout" :hide-figure="!!art" :drawing="drawingText">
    <template #actions>
      <button type="button" class="pill-btn" :disabled="drawingNow?.priority === 'user'" aria-label="画这一刻" data-testid="heart-draw" @click="drawNow">
        <span :class="drawingNow?.priority === 'user' ? 'i-lucide-loader-circle spin' : 'i-lucide-wand-sparkles'" />
      </button>
      <button type="button" class="pill-btn" aria-label="心跳的设置：玩具、画面、预设" data-testid="heart-settings" @click="openSettings()">
        <span class="i-lucide-sliders-horizontal" />
        <span v-if="toys.status === 'connected'" class="online" aria-hidden="true" />
      </button>
    </template>

    <template #overlay>
      <div class="heart" :class="{ hot: toys.intensity >= 60, warm: glow > 0 }" :style="{ '--beat': `${beatMs}ms`, '--glow': glow }" data-testid="heart-scene">
        <!-- 画面层：铺满整屏的竖图，慢慢推近 -->
        <Transition name="art-swap">
          <button v-if="art" :key="art.id" type="button" class="full-art" :aria-label="`看大图：${art.title}`" @click="preview(art)">
            <AssetImg :asset-key="art.assetKey" :url="art.url" :alt="art.title" />
          </button>
        </Transition>
        <div class="vignette" aria-hidden="true" />
        <div class="aura" aria-hidden="true" />
        <div class="shade top" aria-hidden="true" />
        <div class="shade bottom" aria-hidden="true" />
        <div class="floaters" aria-hidden="true">
          <svg v-for="h in hearts" :key="h.id" class="floater" viewBox="0 0 24 24" :style="{ left: `${h.x}%`, '--size': `${h.size}px`, '--dur': `${h.dur}ms`, '--drift': `${h.drift}px` }">
            <path :d="HEART_PATH" />
          </svg>
        </div>

        <!-- 左上：她是谁、在哪，和没接通之类的提示（话放在下面，不挡脸） -->
        <div class="her-col">
          <div class="her-card">
            <Avatar :character="her" :size="26" live />
            <span class="flex-1 min-w-0">
              <span class="block text-[13px] font-600 truncate">{{ her.name }}</span>
              <span class="block text-[11.5px] text-ink-2 truncate">{{ togetherText }}</span>
            </span>
          </div>
          <div v-for="n in notices" :key="n.key" class="mini-notice" :data-testid="`heart-notice-${n.key}`">
            <span :class="n.icon" class="shrink-0" />
            <span class="flex-1 min-w-0">{{ n.text }}</span>
            <button v-if="n.action" type="button" class="text-accent-ink shrink-0" @click="n.action.run()">{{ n.action.label }}</button>
          </div>
        </div>

        <!-- 这一次说过的话 -->
        <Transition name="fade">
          <div v-if="logOpen" ref="logEl" class="log" role="log" aria-label="这一次说过的话">
            <div class="log-head">
              <span>这一次说过的话</span>
              <button type="button" class="text-ink-3" aria-label="收起" @click="logOpen = false"><span class="i-lucide-x" /></button>
            </div>
            <p v-if="!transcript.length" class="text-[12.5px] text-ink-3 m-0">还没有说话</p>
            <div v-for="m in transcript" :key="m.id" class="log-row" :class="m.role === 'user' ? 'me' : 'her'">
              <span class="who">{{ m.role === 'user' ? userName : her.name }}<template v-if="m.meta.cue"> · {{ m.meta.cue }}</template></span>
              <span class="what">{{ m.text }}</span>
            </div>
          </div>
        </Transition>

        <!-- 下面三分之一：你刚说的、她的话（像字幕，点她的话看这一次说过的） -->
        <div v-if="!logOpen" class="talk">
          <StudyBubble v-if="shownMine" side="me" :text="shownMine" label="你刚说的" />
          <StudyBubble
            v-if="shownLine || herTyping"
            side="her"
            :text="shownLine"
            :typing="herTyping"
            label="看这一次说过的话"
            data-testid="heart-her-line"
            @click="logOpen = true"
          />
        </div>

        <!-- 心跳 -->
        <div class="dock">
          <HeartPulse
            :bpm="bpm"
            :intensity="toys.intensity"
            :levels="toys.levels"
            :kinds="toys.kinds"
            :status="pulseStatus"
            :live="toys.live"
            :held="toys.held"
            @stop="stopToys"
            @resume="toys.resume()"
            @open="openSettings('toys')"
          />
        </div>

        <!-- 最下面：打字 / 连麦 -->
        <nav class="bottom-bar" aria-label="和她说话" data-testid="heart-bar">
          <button type="button" class="pill icon" :aria-label="inputMode === 'type' ? '换成连麦' : '换成打字'" data-testid="heart-input-mode" @click="switchInput">
            <span :class="inputMode === 'type' ? 'i-lucide-audio-lines' : 'i-lucide-keyboard'" />
          </button>
          <form v-if="inputMode === 'type'" class="chat-form" @submit.prevent="sendText">
            <input v-model="text" class="chat-input" :placeholder="`和${her.pronoun}说点什么`" aria-label="打字和她说" enterkeyhint="send" />
            <button v-if="stream" type="button" class="pill icon" aria-label="让她停下" @click="chat.stop(chatId)"><span class="i-lucide-square" /></button>
            <button v-else type="submit" class="pill icon send" :disabled="!text.trim()" aria-label="发送"><span class="i-lucide-send" /></button>
          </form>
          <template v-else>
            <button v-if="!link.state.on" type="button" class="link-start" data-testid="heart-link" @click="link.connect()">
              <span class="i-lucide-mic" />和{{ her.pronoun }}连麦
            </button>
            <form v-else-if="link.state.input === 'type'" class="chat-form" @submit.prevent="sendTyped">
              <input v-model="typed" class="chat-input" :placeholder="`打字，${her.pronoun}用声音回你`" aria-label="连麦时打字" enterkeyhint="send" />
              <button type="submit" class="pill icon send" :disabled="!typed.trim()" aria-label="发送"><span class="i-lucide-send" /></button>
              <button type="button" class="pill icon hang" aria-label="挂断" @click="link.hangUp()"><span class="i-lucide-phone-off" /></button>
            </form>
            <div v-else class="link-bar">
              <button v-if="link.state.needTap" type="button" class="tap" @click="link.tapToListen()">点一下开始听</button>
              <template v-else>
                <Waveform :level="link.state.her === 'speaking' ? level : link.state.youLevel" :bars="9" tone="var(--heart)" class="wave" />
                <span class="flex-1 min-w-0 truncate text-[13px]">{{ linkStatus }}</span>
              </template>
              <button type="button" class="pill icon" :class="{ on: link.state.muted }" :aria-pressed="link.state.muted" :aria-label="link.state.muted ? '打开麦克风' : '闭麦'" @click="link.setMuted(!link.state.muted)">
                <span :class="link.state.muted ? 'i-lucide-mic-off' : 'i-lucide-mic'" />
              </button>
              <button type="button" class="pill icon hang" aria-label="挂断" @click="link.hangUp()"><span class="i-lucide-phone-off" /></button>
            </div>
          </template>
        </nav>

        <!-- 设置 -->
        <van-popup v-model:show="settingsOpen" position="bottom" round :style="{ maxHeight: '84vh' }">
          <div class="sheet" data-testid="heart-sheet">
            <Segmented v-model="tab" :options="TABS" />
            <div class="sheet-body">
              <ToyPanel v-if="tab === 'toys'" />

              <template v-else-if="tab === 'art'">
                <div class="flex items-center gap-3">
                  <van-button size="small" round type="primary" :loading="drawingNow?.priority === 'user'" :loading-text="drawingText ?? ''" @click="drawNow">画这一刻</van-button>
                  <span class="text-[12px] text-ink-3 min-w-0">{{ drawingText ?? (art ? `现在是：${art.title}` : '还没有画') }}</span>
                </div>
                <div class="label">自动换图</div>
                <div class="flex gap-1.5 flex-wrap">
                  <button v-for="o in ART_EVERY" :key="o.v" type="button" class="chip" :class="{ on: artEvery === o.v }" @click="artEvery = o.v">{{ o.label }}</button>
                </div>
                <label class="row">
                  <span class="flex-1 min-w-0">
                    <span class="block text-[13.5px]">自动画图</span>
                    <span class="block text-[12px] text-ink-3">进来时没有今天的图就画一张，之后按上面的句数换；关了只在点魔杖时画（一起做事的场景共用这个开关）</span>
                  </span>
                  <van-switch v-model="gallery.autoDraw" size="20px" />
                </label>
                <div class="label">生图预设</div>
                <PresetPicker :model-value="lib.useChoice('image:heart')" category="image" follow follow-title="跟随配图" :follow-label="imageFollowLabel" :first="heartFirst" @update:model-value="pickImagePreset" />
                <template v-if="sessionArt.length">
                  <div class="label">这一次画的</div>
                  <div class="shots">
                    <button v-for="(i, n) in sessionArt" :key="i.id" type="button" class="shot" :aria-label="`看大图：${i.title}`" @click="previewSession(n)">
                      <AssetImg :asset-key="i.assetKey" :url="i.url" :alt="i.title" />
                    </button>
                  </div>
                </template>
              </template>

              <template v-else>
                <Segmented v-model="presetTab" :options="PRESET_TABS" />
                <p class="hint">{{ PRESET_HINT[presetTab] }}</p>
                <PresetPicker
                  v-if="presetTab === 'text'"
                  :model-value="lib.useChoice('scene:heart')"
                  category="feature"
                  follow
                  :first="heartFirst"
                  @update:model-value="(id) => lib.setUse('scene:heart', id)"
                />
                <PresetPicker
                  v-else-if="presetTab === 'voice'"
                  :model-value="lib.useChoice('heart-voice')"
                  category="feature"
                  :first="heartFirst"
                  @update:model-value="(id) => id && lib.setUse('heart-voice', id)"
                />
                <PresetPicker v-else :model-value="lib.useChoice('device')" category="device" @update:model-value="(id) => id && lib.setUse('device', id)" />
              </template>
            </div>
          </div>
        </van-popup>
      </div>
    </template>
  </SceneShell>
</template>

<style scoped>
.heart {
  --heart: #ff7a93;
  position: absolute;
  inset: 0;
  z-index: 6;
  pointer-events: none;
}
.heart > * {
  pointer-events: auto;
}
.heart > .shade,
.heart > .vignette,
.heart > .aura,
.heart > .floaters {
  pointer-events: none;
}
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.35s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

/* —— 画面层：铺满整屏，慢慢推近；换图时淡入 —— */
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
  object-position: 50% 24%;
  transform-origin: 50% 30%;
  animation: drift 38s ease-in-out infinite alternate;
}
.heart.hot .full-art {
  animation: thump var(--beat) ease-out infinite;
}
.art-swap-enter-active {
  transition:
    opacity 1.1s ease,
    transform 1.6s var(--ease);
}
.art-swap-leave-active {
  transition: opacity 1.1s ease;
}
.art-swap-enter-from {
  opacity: 0;
  transform: scale(1.04);
}
.art-swap-leave-to {
  opacity: 0;
}
.shade {
  position: absolute;
  left: 0;
  right: 0;
}
.shade.top {
  top: 0;
  height: 160px;
  background: linear-gradient(to bottom, rgba(0, 0, 0, 0.32), transparent);
}
.shade.bottom {
  bottom: 0;
  height: 250px;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.42), transparent);
}
/* 玩具动起来时：屏幕边缘跟着心跳泛红 */
.vignette {
  position: absolute;
  inset: 0;
  opacity: var(--glow);
  transition: opacity 0.8s ease;
}
.vignette::before {
  content: '';
  position: absolute;
  inset: 0;
  box-shadow: inset 0 0 120px 26px color-mix(in srgb, var(--heart) 62%, transparent);
  animation: flush var(--beat) ease-out infinite;
}
/* 心跳那条后面的光晕 */
.aura {
  position: absolute;
  left: 50%;
  bottom: calc(var(--safe-bottom) + 20px);
  width: 150%;
  height: 46%;
  transform: translateX(-50%);
  opacity: calc(0.15 + var(--glow) * 0.85);
  transition: opacity 0.8s ease;
}
.aura::before {
  content: '';
  position: absolute;
  inset: 0;
  background: radial-gradient(closest-side, color-mix(in srgb, var(--heart) 42%, transparent), transparent);
  animation: swell var(--beat) ease-out infinite;
}
.floaters {
  position: absolute;
  inset: 0;
  overflow: hidden;
}
.floater {
  position: absolute;
  bottom: calc(var(--safe-bottom) + 112px);
  width: var(--size);
  height: var(--size);
  fill: var(--heart);
  opacity: 0;
  filter: drop-shadow(0 0 6px color-mix(in srgb, var(--heart) 60%, transparent));
  animation: float-heart var(--dur) ease-out forwards;
}

/* —— 左上她是谁；下面三分之一是你们说的话 —— */
.her-col {
  position: absolute;
  top: calc(var(--safe-top) + 58px);
  left: 12px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  width: min(72%, 300px);
}
.talk {
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: calc(var(--safe-bottom) + 128px);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.talk :deep(.bubble.me) {
  max-width: 78%;
  max-height: 3.3em;
}
.talk :deep(.bubble.her) {
  align-self: flex-start;
  max-width: 90%;
  max-height: min(8em, 24vh);
  cursor: pointer;
}
.her-card {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 100%;
  padding: 6px 12px 6px 6px;
  border-radius: 99px;
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
  line-height: 1.4;
}

/* —— 这一次说过的话 —— */
.log {
  position: absolute;
  z-index: 3;
  left: 12px;
  right: 12px;
  top: calc(var(--safe-top) + 58px);
  bottom: calc(var(--safe-bottom) + 132px);
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 10px 12px 12px;
  border-radius: 18px;
  background: var(--glass-strong);
  border: 1px solid var(--glass-line);
  backdrop-filter: blur(22px);
  -webkit-backdrop-filter: blur(22px);
  box-shadow: var(--shadow);
}
.log-head {
  position: sticky;
  top: -10px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: -10px -12px 6px;
  padding: 10px 12px 6px;
  background: var(--glass-strong);
  font-size: 12.5px;
  color: var(--ink-3);
}
.log-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 10px;
}
.log-row.me {
  align-items: flex-end;
  text-align: right;
}
.log-row .who {
  font-size: 11.5px;
  color: var(--ink-3);
}
.log-row .what {
  max-width: 88%;
  font-size: 14px;
  line-height: 1.6;
  white-space: pre-wrap;
}

/* —— 心跳那条和最下面一排 —— */
.dock {
  position: absolute;
  left: 10px;
  right: 10px;
  bottom: calc(var(--safe-bottom) + 58px);
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
.pill.icon {
  padding: 0;
}
.pill.on {
  color: var(--accent-ink);
  border-color: var(--accent-line);
}
.pill.send:not(:disabled) {
  color: var(--heart);
}
.pill.hang {
  color: var(--bad);
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
.link-start {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 38px;
  border-radius: 99px;
  background: color-mix(in srgb, var(--heart) 82%, transparent);
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  box-shadow: 0 6px 18px color-mix(in srgb, var(--heart) 35%, transparent);
}
.link-bar {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 38px;
  padding-left: 6px;
  border-radius: 99px;
  background: var(--glass);
  border: 1px solid var(--glass-line);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
}
.link-bar .pill {
  height: 32px;
  min-width: 32px;
  border: 0;
  background: transparent;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}
.wave {
  flex-shrink: 0;
  width: 70px;
  height: 26px;
}
.wave :deep(span) {
  width: 3px;
}
.tap {
  flex: 1;
  height: 32px;
  font-size: 13px;
  color: var(--accent-ink);
}

/* —— 顶栏右边 —— */
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
.pill-btn:disabled {
  opacity: 0.7;
}
.online {
  position: absolute;
  top: 7px;
  right: 7px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--good);
}
.spin {
  animation: spin 1s linear infinite;
}

/* —— 设置弹层 —— */
.sheet-body {
  max-height: calc(84vh - 90px);
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 12px 2px 4px;
}
.label {
  margin: 16px 0 7px;
  font-size: 12.5px;
  color: var(--ink-3);
}
.hint {
  margin: 8px 2px 10px;
  font-size: 12px;
  line-height: 1.55;
  color: var(--ink-3);
}
.chip {
  display: inline-flex;
  align-items: center;
  height: 30px;
  padding: 0 12px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 13px;
}
.chip.on {
  background: var(--accent-soft);
  color: var(--accent-ink);
  outline: 1px solid var(--accent-line);
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
}
.shots {
  display: flex;
  gap: 8px;
  overflow-x: auto;
}
.shot {
  flex-shrink: 0;
  width: 64px;
  height: 92px;
  border-radius: 12px;
  overflow: hidden;
  background: var(--panel);
}

@keyframes drift {
  from {
    transform: scale(1.02) translate(0, 0);
  }
  to {
    transform: scale(1.1) translate(-1.4%, -1.2%);
  }
}
@keyframes thump {
  0%,
  100% {
    transform: scale(1);
  }
  14% {
    transform: scale(1.008);
  }
}
@keyframes flush {
  0% {
    opacity: 0.55;
  }
  14% {
    opacity: 1;
  }
  100% {
    opacity: 0.5;
  }
}
@keyframes swell {
  0% {
    transform: scale(0.94);
    opacity: 0.75;
  }
  16% {
    transform: scale(1.05);
    opacity: 1;
  }
  100% {
    transform: scale(0.94);
    opacity: 0.75;
  }
}
@keyframes float-heart {
  0% {
    opacity: 0;
    transform: translate(0, 0) scale(0.6);
  }
  15% {
    opacity: 0.95;
  }
  100% {
    opacity: 0;
    transform: translate(var(--drift), -46vh) scale(1.15) rotate(12deg);
  }
}
</style>
