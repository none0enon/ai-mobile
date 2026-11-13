<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import Waveform from '@/components/call/Waveform.vue';
import SceneShell from '@/components/scene/SceneShell.vue';
import PlaylistMusic from '@/components/scene/PlaylistMusic.vue';
import { useMicLink } from '@/composables/useMicLink';
import { ttsLiveFor } from '@/services/ai';
import { personaOf } from '@/services/prompt';
import { ambience, NOISE_KINDS, NOISE_LABEL, type NoiseMix } from '@/services/ambience';
import { sleepMusic, type PlaylistSearch } from '@/services/musicPlayer';
import { SentenceStream, SpeechQueue } from '@/services/speech';
import { useAiStore } from '@/stores/ai';
import { useAppStore } from '@/stores/app';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';
import { useEnvironmentStore } from '@/stores/environment';
import { sleep } from '@/utils/id';
import { clock, hhmm } from '@/utils/time';

/**
 * 哄睡（设计文档 §9.4）：暗色卧室。连麦 / 睡前故事 / 白噪音 / 音乐；
 * 定时器到点她说最后一句晚安、挂断连麦、白噪音和音乐慢慢变小、她也睡着；第二天早上她来电叫醒你（主动消息的"叫醒来电"）。
 * - 连麦（composables/useMicLink.ts）：躺着说话她就听得到、小声回你；连上以后换到别的标签也不断；
 * - 白噪音在本机合成（services/ambience.ts），不需要 API；音乐挑一个歌单放（components/scene/PlaylistMusic.vue，网易云）；
 * - 她说的话（连麦、低语、故事、晚安）都由「陪伴 · 快速」按"哄睡"功能预设写，用"语音合成"的 API 读出来，同一时间只有一段；
 *   她说话时白噪音和音乐压低一点。没接通时写明原因，不出演示台词；语音合成没接通时字幕照常、不出声。
 */
type Mode = 'mic' | 'story' | 'noise' | 'music';
/** 助眠的歌单：按这些词去网易云搜 */
const SLEEP_SEARCHES: PlaylistSearch[] = [
  { name: '睡前钢琴', keyword: '助眠 钢琴曲', icon: 'i-lucide-piano' },
  { name: '纯音乐', keyword: '睡前 纯音乐', icon: 'i-lucide-feather' },
  { name: '摇篮曲', keyword: '摇篮曲 八音盒', icon: 'i-lucide-moon-star' },
  { name: '冥想', keyword: '冥想 助眠', icon: 'i-lucide-leaf' },
  { name: '安静的民谣', keyword: '安静 民谣', icon: 'i-lucide-guitar' },
];
const MODES: { id: Mode; label: string; icon: string }[] = [
  { id: 'mic', label: '连麦', icon: 'i-lucide-headphones' },
  { id: 'story', label: '故事', icon: 'i-lucide-book-heart' },
  { id: 'noise', label: '白噪音', icon: 'i-lucide-waves' },
  { id: 'music', label: '音乐', icon: 'i-lucide-music' },
];

const app = useAppStore();
const chars = useCharacterStore();
const chat = useChatStore();
const ai = useAiStore();
const env = useEnvironmentStore();
const router = useRouter();
const her = computed(() => chars.byId(app.activeCharacterId) ?? chars.list[0]!);
const chatId = computed(() => chat.chatOfCharacter(her.value.id)?.id ?? '');
/** 场景任务里的输入不替换宏：直接写你的名字 */
const userName = computed(() => personaOf(chat.chatById(chatId.value)).name);

// —— 记住上次的标签、混音、定时、低语开关（只是这台设备的方便） ——
const SAVE_KEY = 'ai-mobile:sleep';
interface Saved {
  mode?: Mode;
  mix?: NoiseMix;
  timerMin?: number | null;
  whispers?: boolean;
}
function loadSaved(): Saved {
  try {
    return JSON.parse(localStorage.getItem(SAVE_KEY) ?? '{}') as Saved;
  } catch {
    return {};
  }
}
const saved = loadSaved();
const mode = ref<Mode>(MODES.some((m) => m.id === saved.mode) ? saved.mode! : 'mic');
const lightsOff = ref(false);
const asleep = ref(false);
const timerMin = ref<number | null>(saved.timerMin === undefined ? 30 : saved.timerMin);
const mix = reactive<NoiseMix>({ rain: 60, fire: 20, waves: 0, fan: 10, ...(saved.mix ?? {}) });
/** 连麦时你安静久了，她偶尔低语一句 */
const whispers = ref(saved.whispers ?? true);
watch([mode, mix, timerMin, whispers], () => {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({ mode: mode.value, mix, timerMin: timerMin.value, whispers: whispers.value }));
  } catch {
    // 无痕模式
  }
});

// —— 接没接通 ——
const companionStatus = computed(() => ai.status('companion'));
const voiceLive = computed(() => ttsLiveFor(her.value));
const voiceError = ref('');

// —— 她说话：同一时间只有一段（连麦里回你、低语、故事、晚安） ——
const level = ref(0);
const line = ref('');
const writing = ref(false);
let speech: SpeechQueue | null = null;
/** 新开一段她的声音，停掉正在说的那段；她说话时白噪音和音乐压低，说完回来 */
function newSpeech(opts: { speedFactor?: number; onSentence?(text: string, i: number): void } = {}): SpeechQueue {
  speech?.stop();
  const q = new SpeechQueue({
    characterId: her.value.id,
    // 低语：映射成"很轻、像在耳边小声说话"的情绪
    expression: () => 'sleep',
    speedFactor: opts.speedFactor ?? 0.88,
    onLevel: (l) => (level.value = l),
    onSentence: opts.onSentence,
    onError: (msg) => (voiceError.value = msg),
  });
  speech = q;
  ambience.duck(true);
  sleepMusic.duck(true);
  void q.drained().then(() => {
    if (speech !== q) return;
    ambience.duck(false);
    sleepMusic.duck(false);
  });
  return q;
}
function stopSpeech() {
  speech?.stop();
  speech = null;
  ambience.duck(false);
  sleepMusic.duck(false);
}
const speaking = computed(() => level.value > 0.02);

/** 让她按"哄睡"功能预设说一段（流式）：onText 每次拿到目前为止的正文。没接通、失败时写明原因 */
async function askHer(
  task: string,
  input: string,
  opts: { userText?: string; cue?: string; minTokens?: number; onText(full: string): void },
): Promise<{ text: string; interrupted: boolean } | null> {
  if (!chatId.value) return null;
  voiceError.value = '';
  asleep.value = false;
  armTimer();
  writing.value = true;
  const r = await chat.sceneReply(chatId.value, { task, input, userText: opts.userText, cue: opts.cue, allowedTags: ['expr'], onText: opts.onText, minTokens: opts.minTokens, quick: true });
  writing.value = false;
  if (r.ok) return { text: r.message.text, interrupted: !!r.message.meta.interrupted };
  // 没接通的原因在上面的提示条里
  if (!r.notConnected) line.value = `（${r.reason}）`;
  return null;
}

/** 她说一小段（晚安）：边生成边分句读 */
async function herSays(task: string, input: string, opts: { cue?: string; speedFactor?: number } = {}): Promise<void> {
  const q = newSpeech({ speedFactor: opts.speedFactor });
  const stream = new SentenceStream();
  const r = await askHer(task, input, {
    ...opts,
    onText: (full) => {
      line.value = full;
      if (!q.stopped) q.pushAll(stream.feed(full));
    },
  });
  if (r === null) {
    q.stop();
    return;
  }
  line.value = r.text;
  if (!q.stopped) q.pushAll(stream.flush(r.text));
  q.end();
  await q.drained();
}

/** 现在的情况：写进她这一次的场景任务 */
function nowLine() {
  const parts = [`现在 ${hhmm(Date.now())}`, lightsOff.value ? '已经熄灯了' : '灯还开着'];
  if (ambience.state.playing) parts.push('开着白噪音');
  const s = sleepMusic.current();
  if (s && sleepMusic.state.playing) parts.push(`在放《${s.title}》- ${s.artist}${sleepMusic.state.demo ? '（示例歌曲）' : ''}`);
  return `${parts.join('，')}。`;
}

// —— 故事：她现编，边写边读；可以暂停（继续时从停下的那句读）、换一个 ——
const story = reactive({ title: '', sentences: [] as string[], index: -1, playing: false, done: false });
const toldTitles: string[] = [];
/** 正在读故事的队列（暂停时停掉，继续时新开一个） */
let storyQueue: SpeechQueue | null = null;
/** 每次新故事一个，旧故事的流式回调作废 */
let storyRun = 0;

/** 正文第一行是《故事名》：标题齐了才开始读；还没写完标题时返回 null */
function splitTitle(full: string): { title: string; body: string } | null {
  const t = full.trimStart();
  if (!t) return null;
  if (!t.startsWith('《')) return { title: '', body: t };
  const m = /^《([^》\n]{1,40})》[ \t]*\n?/.exec(t);
  if (m) return m[0].endsWith('\n') || t.length > m[0].length ? { title: m[1]!, body: t.slice(m[0].length) } : null;
  return t.length > 48 ? { title: '', body: t } : null;
}

/** 从第 index 句读起；故事还在写时，后面写出来的句子接着排进这个队列 */
function readFrom(index: number) {
  const start = Math.max(0, index);
  const q = newSpeech({
    speedFactor: 0.9,
    onSentence: (t, i) => {
      story.index = start + i;
      // 连着麦时记下来：麦克风听到的是她自己在念，不当成你在说话
      link.noteHerLine(t);
    },
  });
  storyQueue = q;
  story.playing = true;
  q.pushAll(story.sentences.slice(start));
  if (story.done) q.end();
  void q.drained().then(() => {
    if (storyQueue === q && story.done && !q.stopped) {
      story.playing = false;
      story.index = -1;
    }
  });
}
const storyLive = () => !!storyQueue && storyQueue === speech && !storyQueue.stopped;

async function newStory() {
  // 连麦里她正回着你：你点了讲故事，先停下来（只留说出口的）
  await link.interrupt();
  if (replying.value) return;
  const run = (storyRun += 1);
  Object.assign(story, { title: '', sentences: [], index: -1, playing: true, done: false });
  const stream = new SentenceStream();
  const input = [nowLine(), '讲一个新的睡前故事。', toldTitles.length ? `今晚已经讲过：${toldTitles.map((t) => `《${t}》`).join('、')}，不要重复。` : ''].filter(Boolean).join('\n');
  readFrom(0);
  const r = await askHer('sleep-story', input, {
    cue: '睡前故事',
    // 300–500 字的故事：预设里给低语的上限（300）不够
    minTokens: 1600,
    onText: (full) => {
      const parts = run === storyRun ? splitTitle(full) : null;
      if (!parts) return;
      story.title = parts.title;
      const fresh = stream.feed(parts.body);
      story.sentences.push(...fresh);
      // 暂停时只攒着，继续时从停下的那句读
      if (storyLive()) storyQueue!.pushAll(fresh);
    },
  });
  if (run !== storyRun) return;
  if (r === null) {
    story.playing = false;
    storyQueue?.stop();
    return;
  }
  const parts = splitTitle(r.text) ?? { title: story.title, body: r.text };
  story.title = parts.title;
  const rest = stream.flush(parts.body);
  story.sentences.push(...rest);
  story.done = true;
  if (!story.sentences.length) {
    story.playing = false;
    storyQueue?.stop();
    // 只写出了标题：回复被截断了（以前会安安静静只显示一个标题）。连麦时你开口打断的不算
    if (!r.interrupted) line.value = '（故事只写出了标题就停了：回复被截断了。可以在"我的 → 预设 → 功能 → 哄睡"里调大"最长回复"再试）';
    return;
  }
  if (story.title) toldTitles.push(story.title);
  if (storyLive()) {
    storyQueue!.pushAll(rest);
    storyQueue!.end();
  }
}

function toggleStory() {
  if (story.playing) {
    story.playing = false;
    stopSpeech();
    return;
  }
  if (!story.sentences.length || (story.done && story.index < 0)) {
    void newStory();
    return;
  }
  asleep.value = false;
  armTimer();
  readFrom(story.index < 0 ? 0 : story.index);
}
const storyEl = ref<HTMLElement | null>(null);
watch(
  () => story.index,
  (i) => {
    const el = storyEl.value?.querySelector<HTMLElement>(`[data-s="${i}"]`);
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  },
);

// —— 连麦：说话她就听得到，小声回你；连上以后换到别的标签也不断 ——
const link = useMicLink({
  chatId,
  character: her,
  userName,
  newSpeech: (o) => newSpeech({ onSentence: o.onSentence }),
  context: nowLine,
  herBusy: () => story.playing,
  // 她在讲故事时你开口：故事先停下来听你说
  onInterrupt: () => {
    if (story.playing) toggleStory();
  },
  autoWhisper: () => whispers.value,
  onActivity: () => {
    asleep.value = false;
    armTimer();
  },
});
const replying = computed(() => !!chat.streams[chatId.value]);
const typed = ref('');
/** 在点击里调用：麦克风权限、恢复音频都要用户点过 */
function connect() {
  link.connect();
}
function sendTyped() {
  const t = typed.value.trim();
  if (!t) return;
  typed.value = '';
  void link.say(t);
}
const linkStatus = computed(() => {
  const s = link.state;
  const p = her.value.pronoun;
  if (s.her === 'speaking') return `${p}在小声说……`;
  if (s.her === 'thinking') return `${p}在想……`;
  if (s.you === 'recognizing') return '在听清你说的话……';
  if (s.you === 'speaking') return '在听你说……';
  if (story.playing) return `${p}在讲故事`;
  if (s.input === 'type') return `打字和${p}说`;
  if (s.muted) return '你闭麦了';
  return `说话${p}就听得到`;
});
/** 连麦里哪一步没接通：写明原因，点了去设置 */
const linkIssues = computed(() => {
  const s = link.state;
  const out: { text: string; to: string; icon: string }[] = [];
  if (s.micIssue) out.push({ text: s.micIssue, to: '/me/voice', icon: 'i-lucide-mic-off' });
  else if (s.sttIssue) out.push({ text: s.sttIssue, to: '/me/api?feature=stt', icon: 'i-lucide-ear-off' });
  return out;
});
const lastHerCaption = computed(() => [...link.state.captions].reverse().find((c) => c.who === 'her')?.text ?? '');

// —— 白噪音 ——
const PRESETS: { label: string; mix: NoiseMix }[] = [
  { label: '雨夜', mix: { rain: 70, fire: 0, waves: 0, fan: 15 } },
  { label: '炉边', mix: { rain: 25, fire: 75, waves: 0, fan: 0 } },
  { label: '海边', mix: { rain: 0, fire: 0, waves: 75, fan: 10 } },
  { label: '风扇', mix: { rain: 0, fire: 0, waves: 0, fan: 70 } },
];
watch(mix, () => ambience.setMix({ ...mix }));
async function toggleNoise() {
  if (ambience.state.playing && !ambience.state.fading) {
    ambience.stop();
    return;
  }
  asleep.value = false;
  armTimer();
  await ambience.start({ ...mix });
}
function applyPreset(p: NoiseMix) {
  Object.assign(mix, p);
  if (!ambience.state.playing) void toggleNoise();
}

// —— 音乐：开始放了就开始计时；渐弱时自动换下一首不算，渐弱时你点了播放（不再变小）算 ——
watch(
  () => sleepMusic.state.playing && !sleepMusic.state.fading,
  (on) => {
    if (!on) return;
    asleep.value = false;
    armTimer();
  },
);

function selectMode(m: Mode) {
  if (m === mode.value) return;
  const was = mode.value;
  mode.value = m;
  // 换到别的标签时，正在读的故事停下（连麦、白噪音、音乐照常）
  if (was === 'story' && story.playing) toggleStory();
}
/** 标签上的小点：这件事正在进行 */
function active(m: Mode): boolean {
  if (m === 'mic') return link.state.on;
  if (m === 'story') return story.playing;
  if (m === 'noise') return ambience.state.playing;
  return sleepMusic.state.playing;
}

// —— 定时：到点她说最后一句晚安，挂断连麦，白噪音和音乐渐弱，她也睡着 ——
const sleepAt = ref<number | null>(null);
const now = ref(Date.now());
const clockTimer = setInterval(() => {
  now.value = Date.now();
  if (sleepAt.value !== null && now.value >= sleepAt.value) void timeUp();
}, 1000);
function armTimer() {
  if (sleepAt.value === null && timerMin.value) sleepAt.value = Date.now() + timerMin.value * 60_000;
}
watch(timerMin, (m) => {
  if (sleepAt.value !== null || ambience.state.playing || story.playing || link.state.on || sleepMusic.state.playing) sleepAt.value = m ? Date.now() + m * 60_000 : null;
});
const remaining = computed(() => {
  if (sleepAt.value === null) return '';
  const s = Math.max(0, Math.round((sleepAt.value - now.value) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
});
async function timeUp() {
  sleepAt.value = null;
  story.playing = false;
  // 连麦挂断（她说到一半的只留说出口的），麦克风关掉
  await link.hangUp();
  stopSpeech();
  const id = chatId.value;
  if (chat.streams[id]) {
    chat.stop(id);
    for (let i = 0; i < 40 && chat.streams[id]; i += 1) await sleep(50);
  }
  lightsOff.value = true;
  if (companionStatus.value.live) await herSays('sleep-end', `${nowLine()}定时到了。`, { cue: '晚安', speedFactor: 0.8 });
  // 说完晚安以后不再重新开始计时
  sleepAt.value = null;
  asleep.value = true;
  await Promise.all([ambience.fadeOut(45), sleepMusic.fadeOut(45)]);
}

// —— 明早叫醒：主动消息里这个角色的"叫醒来电" ——
const wakeCall = computed({
  get: () => {
    const p = her.value.proactive;
    return p.enabled && p.allowCalls && p.triggers.includes('wake-call');
  },
  set: (on: boolean) => {
    const p = her.value.proactive;
    if (on) {
      p.enabled = true;
      p.allowCalls = true;
      if (!p.triggers.includes('wake-call')) p.triggers.push('wake-call');
    } else {
      p.triggers = p.triggers.filter((t) => t !== 'wake-call');
    }
  },
});

onBeforeUnmount(() => {
  clearInterval(clockTimer);
  link.dispose();
  if (chat.streams[chatId.value]) chat.stop(chatId.value);
  stopSpeech();
  ambience.stop();
  sleepMusic.stop();
});

/** 提示条：「陪伴 · 快速」没接通（连麦、故事要用）；连麦里她没回上 */
const aiIssue = computed(() => {
  if (mode.value !== 'mic' && mode.value !== 'story') return '';
  if (!companionStatus.value.live) return `「陪伴 · 快速」还没接通：${companionStatus.value.reason}`;
  return mode.value === 'mic' ? link.state.llmIssue : '';
});

const shownLine = computed(() => {
  if (asleep.value) return '（呼吸声）……';
  if (mode.value === 'story') return story.playing ? `（轻声地读）${story.title ? `《${story.title}》` : '……'}` : line.value || '要不要听我讲个故事？';
  // 连着麦：她最近说的那句
  if (link.state.on) return lastHerCaption.value;
  if (writing.value && !line.value) return '';
  if (line.value) return line.value;
  if (mode.value === 'noise') return ambience.state.playing ? '听着这个声音，慢慢就困了。' : '';
  if (mode.value === 'music') return sleepMusic.state.playing ? '就听这个，闭上眼睛。' : '';
  return '';
});
</script>

<template>
  <SceneShell
    scene-id="sleep"
    tod="late"
    :dim="lightsOff ? 0.55 : 0.15"
    :rain="ambience.state.playing && mix.rain > 0"
    :expression="asleep || lightsOff ? 'sleep' : 'sleepy'"
    :line="shownLine"
    :typing="(writing && mode !== 'story') || link.state.her === 'thinking'"
    :layout="{ left: 50, bottom: 40, height: 50 }"
  >
    <template #actions>
      <button class="lamp" :class="{ off: lightsOff }" :aria-label="lightsOff ? '开灯' : '熄灯'" @click="lightsOff = !lightsOff">
        <span :class="lightsOff ? 'i-lucide-lamp' : 'i-lucide-lamp-desk'" />{{ lightsOff ? '开灯' : '熄灯' }}
      </button>
    </template>

    <div v-if="aiIssue" class="notice">
      <span class="i-lucide-plug-zap shrink-0" />
      <span class="flex-1 min-w-0">{{ aiIssue }}</span>
      <button class="text-accent-ink shrink-0" @click="router.push('/me/api?feature=companion')">去设置</button>
    </div>
    <div v-else-if="(mode === 'mic' || mode === 'story') && (!voiceLive || voiceError)" class="notice">
      <span class="i-lucide-volume-x shrink-0" />
      <span class="flex-1 min-w-0">{{ voiceError || `没有声音：语音合成还没接通，或者还没给${her.name}选音色（字幕照常）` }}</span>
      <button class="text-accent-ink shrink-0" @click="router.push('/me/voice')">去设置</button>
    </div>

    <!-- 连着麦、在别的标签：一条小的，随时闭麦、挂断 -->
    <div v-if="link.state.on && mode !== 'mic'" class="link-bar" data-testid="mic-bar">
      <span class="live-dot" />
      <button class="flex-1 min-w-0 truncate text-left" @click="selectMode('mic')">连麦中 <span class="num">{{ clock(link.state.seconds) }}</span> · {{ linkStatus }}</button>
      <button class="mini" :class="{ on: link.state.muted }" :disabled="link.state.input === 'type'" :aria-label="link.state.muted ? '开麦' : '闭麦'" @click="link.setMuted(!link.state.muted)">
        <span :class="link.state.muted ? 'i-lucide-mic-off' : 'i-lucide-mic'" />
      </button>
      <button class="mini hang" aria-label="挂断连麦" @click="link.hangUp()"><span class="i-lucide-phone-off" /></button>
    </div>

    <div class="modes">
      <button v-for="m in MODES" :key="m.id" class="mode" :class="{ on: mode === m.id }" :data-mode="m.id" @click="selectMode(m.id)">
        <span :class="m.icon" class="text-[18px]" />{{ m.label }}
        <span v-if="active(m.id)" class="dot" aria-hidden="true" />
      </button>
    </div>

    <!-- 连麦 -->
    <div v-if="mode === 'mic'" class="mt-3">
      <button v-if="!link.state.on" class="connect press" data-testid="mic-connect" @click="connect">
        <span class="i-lucide-headphones text-[22px] shrink-0" />
        <span class="flex-1 min-w-0 text-left">
          <span class="block text-[15px] font-600">和{{ her.name }}连麦</span>
          <span class="block text-[12px] opacity-80">躺着说就行，说完停一下{{ her.pronoun }}就小声回你</span>
        </span>
      </button>
      <template v-else>
        <div class="flex items-center gap-2">
          <span class="live-dot" />
          <span class="flex-1 min-w-0 truncate text-[13px] text-accent-ink" data-testid="mic-status">{{ linkStatus }}</span>
          <span class="num text-[12px] text-ink-3">{{ clock(link.state.seconds) }}</span>
        </div>
        <Waveform
          :level="link.state.her === 'speaking' || story.playing ? level : link.state.muted ? 0 : link.state.youLevel"
          :tone="link.state.her === 'speaking' || story.playing ? 'var(--accent)' : 'var(--ink-2)'"
          :bars="25"
        />
        <div class="captions" aria-live="polite">
          <p v-for="c in link.state.captions.slice(-3)" :key="c.id" :class="[c.who, { pending: c.pending }]">
            <b>{{ c.who === 'her' ? her.name : '我' }}：</b>{{ c.text }}
          </p>
          <p v-if="!link.state.captions.length" class="text-ink-3">{{ her.pronoun }}在听……</p>
        </div>
        <p v-if="link.state.hint" class="text-[12.5px] text-ink-2 mt-1.5 mb-0">{{ link.state.hint }}</p>
        <button v-for="(x, i) in linkIssues" :key="i" type="button" class="issue" @click="router.push(x.to)">
          <span :class="x.icon" class="shrink-0 mt-[2px]" />
          <span class="flex-1 min-w-0 text-left">{{ x.text }}</span>
          <span class="shrink-0 underline">去设置</span>
        </button>
        <button v-if="link.state.needTap && link.state.input !== 'type'" class="tap" @click="link.tapToListen()">
          <span class="i-lucide-mic" />浏览器要先点一下才能听你说话：点这里
        </button>
        <form v-if="link.state.input === 'type'" class="flex gap-2 mt-2" @submit.prevent="sendTyped">
          <input v-model="typed" class="field" :placeholder="`小声跟${her.pronoun}说……`" :aria-label="`跟${her.name}说`" enterkeyhint="send" />
          <van-button size="small" round native-type="submit" :disabled="!typed.trim()">说</van-button>
        </form>
        <div class="link-ctrls">
          <button class="lc" :class="{ on: link.state.muted }" :disabled="link.state.input === 'type'" @click="link.setMuted(!link.state.muted)">
            <span class="circle"><span :class="link.state.muted ? 'i-lucide-mic-off' : 'i-lucide-mic'" /></span>{{ link.state.muted ? '已闭麦' : '闭麦' }}
          </button>
          <button class="lc" data-testid="mic-input" @click="link.setInput(link.state.input === 'type' ? 'auto' : 'type')">
            <span class="circle"><span :class="link.state.input === 'type' ? 'i-lucide-audio-lines' : 'i-lucide-keyboard'" /></span>{{ link.state.input === 'type' ? '改成说话' : '打字' }}
          </button>
          <button class="lc hang" data-testid="mic-hangup" @click="link.hangUp()">
            <span class="circle"><span class="i-lucide-phone-off" /></span>挂断
          </button>
        </div>
      </template>
      <label class="flex items-center gap-2 text-[13px] text-ink-2 mt-3">
        <van-switch v-model="whispers" size="18px" />你安静久了，{{ her.pronoun }}偶尔小声说一句
      </label>
      <p class="text-[12px] text-ink-3 mt-1.5 mb-0">连着麦时屏幕不会自动熄灭（网页熄屏后就听不到你了），定时到点自动挂断。放着音乐时戴上耳机，{{ her.pronoun }}听得更清楚。</p>
    </div>

    <!-- 故事 -->
    <div v-else-if="mode === 'story'" class="mt-3">
      <div class="flex items-center gap-2">
        <span class="text-[15px] font-600 serif truncate">{{ story.title ? `《${story.title}》` : '睡前故事' }}</span>
        <span class="text-[12px] text-ink-3 shrink-0">{{ her.pronoun }}现编的</span>
        <button v-if="story.sentences.length && !replying" class="ml-auto text-[12.5px] text-accent-ink shrink-0" @click="newStory">换一个</button>
        <button class="play shrink-0" :class="{ 'ml-auto': !story.sentences.length || replying }" :aria-label="story.playing ? '暂停' : '播放'" data-testid="story-play" @click="toggleStory">
          <span :class="story.playing ? 'i-lucide-pause' : 'i-lucide-play'" />
        </button>
      </div>
      <div ref="storyEl" class="story serif">
        <template v-if="story.sentences.length">
          <span v-for="(s, i) in story.sentences" :key="i" :data-s="i" :class="{ now: i === story.index }">{{ s }}</span>
        </template>
        <span v-else-if="replying" class="text-ink-3">{{ her.pronoun }}在想今晚讲什么……</span>
        <span v-else class="text-ink-3">点 ▶ 让{{ her.pronoun }}现编一个睡前故事，一边写一边读给你听。</span>
      </div>
      <Waveform v-if="story.playing && speaking" :level="level" class="mt-1" />
    </div>

    <!-- 白噪音 -->
    <div v-else-if="mode === 'noise'" class="mt-3">
      <div class="flex items-center gap-2.5">
        <button class="play big shrink-0" :aria-label="ambience.state.playing && !ambience.state.fading ? '暂停白噪音' : '播放白噪音'" data-testid="noise-play" @click="toggleNoise">
          <span :class="ambience.state.loading ? 'i-lucide-loader-circle spin' : ambience.state.playing && !ambience.state.fading ? 'i-lucide-pause' : 'i-lucide-play'" />
        </button>
        <div class="flex-1 min-w-0">
          <div class="text-[14px] font-600">{{ ambience.state.loading ? '准备中……' : ambience.state.playing ? (ambience.state.fading ? '慢慢变小……' : '正在播放') : '白噪音' }}</div>
          <div class="text-[12px] text-ink-3 truncate">本机合成，不联网、不用 API</div>
        </div>
      </div>
      <p v-if="ambience.state.error" class="text-[12.5px] text-bad mt-2 mb-0">{{ ambience.state.error }}</p>
      <div class="flex gap-2 mt-3 overflow-x-auto no-scrollbar">
        <button v-for="p in PRESETS" :key="p.label" class="chip-opt" @click="applyPreset(p.mix)">{{ p.label }}</button>
      </div>
      <div class="grid gap-2.5 mt-3">
        <div v-for="k in NOISE_KINDS" :key="k" class="flex items-center gap-3">
          <span :class="NOISE_LABEL[k].icon" class="text-ink-3 shrink-0" />
          <span class="w-9 text-[13px] text-ink-2 shrink-0">{{ NOISE_LABEL[k].label }}</span>
          <van-slider v-model="mix[k]" class="flex-1" bar-height="4px" button-size="16px" :aria-label="NOISE_LABEL[k].label" />
          <span class="w-8 text-right text-[12px] text-ink-3 num">{{ mix[k] }}</span>
        </div>
      </div>
    </div>

    <!-- 音乐：挑一个歌单 -->
    <PlaylistMusic v-else :player="sleepMusic" :searches="SLEEP_SEARCHES" test-id="sleep-music" />

    <div class="mt-4">
      <div class="text-[12.5px] text-ink-3 mb-1.5">
        定时（到点{{ her.pronoun }}说晚安、挂断连麦，声音慢慢变小，{{ her.pronoun }}也会睡着）<span v-if="remaining" class="num text-accent-ink"> · 还剩 {{ remaining }}</span>
      </div>
      <div class="flex gap-2">
        <button v-for="t in [15, 30, 60]" :key="t" class="chip-opt num" :class="{ on: timerMin === t }" @click="timerMin = t">{{ t }} 分钟</button>
        <button class="chip-opt" :class="{ on: timerMin === null }" @click="timerMin = null">不定时</button>
      </div>
    </div>
    <div class="flex items-center justify-between mt-3.5">
      <div>
        <div class="text-[14px]">明早 {{ env.settings.wakeTime }} {{ her.pronoun }}打电话叫醒你</div>
        <div class="text-[12px] text-ink-3">主动消息里的"叫醒来电"；安卓：精确闹钟 + 全屏来电，iPhone：推送点开接听</div>
      </div>
      <van-switch v-model="wakeCall" size="22px" />
    </div>
  </SceneShell>
</template>

<style scoped>
.lamp {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 38px;
  padding: 0 12px;
  border-radius: 99px;
  background: var(--glass);
  border: 1px solid var(--glass-line);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  font-size: 13px;
  color: #f2c98a;
}
.lamp.off {
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
.link-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  padding: 6px 6px 6px 12px;
  border-radius: 14px;
  background: var(--accent-soft);
  border: 1px solid var(--accent-line);
  color: var(--accent-ink);
  font-size: 12.5px;
}
.live-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--good);
  flex-shrink: 0;
  animation: live 1.6s ease-in-out infinite;
}
@keyframes live {
  50% {
    opacity: 0.35;
  }
}
.mini {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--panel);
  color: var(--ink);
  font-size: 15px;
  flex-shrink: 0;
}
.mini.on {
  background: var(--ink);
  color: var(--bg);
}
.mini.hang {
  background: #e5484d;
  color: #fff;
}
.mini:disabled {
  opacity: 0.45;
}
.modes {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}
.mode {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 9px 0;
  border-radius: 14px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 12.5px;
}
.mode.on {
  background: var(--accent-soft);
  color: var(--accent-ink);
  outline: 1px solid var(--accent-line);
}
.mode .dot {
  position: absolute;
  top: 7px;
  right: calc(50% - 19px);
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--good);
}
.connect {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 14px;
  border-radius: 16px;
  background: var(--accent);
  color: var(--on-accent);
}
.captions {
  margin-top: 6px;
  padding: 10px 12px;
  border-radius: 14px;
  background: var(--panel);
  min-height: 64px;
  max-height: 120px;
  overflow-y: auto;
}
.captions p {
  margin: 0 0 4px;
  font-size: 13.5px;
  line-height: 1.55;
}
.captions p:last-child {
  margin-bottom: 0;
}
.captions p.you {
  color: var(--ink-2);
}
.captions p.pending {
  opacity: 0.6;
}
.captions b {
  font-weight: 600;
}
.issue {
  display: flex;
  gap: 8px;
  width: 100%;
  margin-top: 8px;
  padding: 8px 12px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--bad) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--bad) 35%, transparent);
  color: var(--ink);
  font-size: 12.5px;
  line-height: 1.5;
}
.tap {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  margin-top: 8px;
  padding: 9px 14px;
  border-radius: 99px;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 13px;
}
.link-ctrls {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  margin-top: 12px;
}
.lc {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--ink-2);
}
.lc:disabled {
  opacity: 0.45;
}
.lc .circle {
  display: inline-flex;
  width: 46px;
  height: 46px;
  border-radius: 50%;
  align-items: center;
  justify-content: center;
  background: var(--panel);
  color: var(--ink);
  font-size: 20px;
}
.lc.on .circle {
  background: var(--ink);
  color: var(--bg);
}
.lc.hang .circle {
  background: #e5484d;
  color: #fff;
}
.field {
  flex: 1;
  min-width: 0;
  height: 34px;
  padding: 0 12px;
  border-radius: 17px;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--ink);
  outline: none;
  font-size: 14px;
}
.play {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: var(--accent);
  color: var(--on-accent);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.play.big {
  width: 46px;
  height: 46px;
  font-size: 20px;
}
.spin {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.story {
  margin: 8px 0 0;
  font-size: 14.5px;
  line-height: 1.85;
  color: var(--ink-2);
  max-height: 120px;
  overflow-y: auto;
}
.story .now {
  color: var(--ink);
  background: var(--accent-soft);
  border-radius: 4px;
}
.chip-opt {
  height: 32px;
  padding: 0 12px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 13px;
  white-space: nowrap;
  flex-shrink: 0;
}
.chip-opt.on {
  background: var(--accent);
  color: var(--on-accent);
  font-weight: 600;
}
</style>
