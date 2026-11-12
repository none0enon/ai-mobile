<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import Waveform from '@/components/call/Waveform.vue';
import SceneShell from '@/components/scene/SceneShell.vue';
import { ttsLiveFor } from '@/services/ai';
import { personaOf } from '@/services/prompt';
import { ambience, NOISE_KINDS, NOISE_LABEL, type NoiseMix } from '@/services/ambience';
import { SentenceStream, SpeechQueue } from '@/services/speech';
import { useAiStore } from '@/stores/ai';
import { useAppStore } from '@/stores/app';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';
import { useEnvironmentStore } from '@/stores/environment';
import { hhmm } from '@/utils/time';

/**
 * 哄睡（设计文档 §9.4）：暗色卧室。睡前聊天（低语）/ 睡前故事 / 白噪音 / 呼吸引导；
 * 定时器到点她说最后一句晚安、声音渐弱、她也睡着；第二天早上她来电叫醒你（主动消息的"叫醒来电"）。
 * - 白噪音在本机合成（services/ambience.ts），不需要 API；
 * - 她说的话（低语、聊天、故事、晚安）都由「陪伴 · 快速」按"哄睡"功能预设写，用"语音合成"的 API 读出来；
 *   没接通时写明原因，不出演示台词；语音合成没接通时字幕照常、不出声。
 */
type Mode = 'chat' | 'story' | 'noise' | 'breath';
const MODES: { id: Mode; label: string; icon: string }[] = [
  { id: 'chat', label: '聊天', icon: 'i-lucide-message-circle' },
  { id: 'story', label: '故事', icon: 'i-lucide-book-heart' },
  { id: 'noise', label: '白噪音', icon: 'i-lucide-waves' },
  { id: 'breath', label: '呼吸', icon: 'i-lucide-wind' },
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

// —— 记住上次的混音和定时（只是这台设备的方便） ——
const SAVE_KEY = 'ai-mobile:sleep';
function loadSaved(): { mix?: NoiseMix; timerMin?: number | null } {
  try {
    return JSON.parse(localStorage.getItem(SAVE_KEY) ?? '{}') as { mix?: NoiseMix; timerMin?: number | null };
  } catch {
    return {};
  }
}
const saved = loadSaved();
const mode = ref<Mode>('chat');
const lightsOff = ref(false);
const asleep = ref(false);
const timerMin = ref<number | null>(saved.timerMin === undefined ? 30 : saved.timerMin);
const mix = reactive<NoiseMix>({ rain: 60, fire: 20, waves: 0, fan: 10, ...(saved.mix ?? {}) });
watch([mix, timerMin], () => {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({ mix, timerMin: timerMin.value }));
  } catch {
    // 无痕模式
  }
});

// —— 接没接通 ——
const companionStatus = computed(() => ai.status('companion'));
const notConnected = ref('');
const voiceLive = computed(() => ttsLiveFor(her.value));
const voiceError = ref('');

// —— 她说话：同一时间只有一段（低语、故事、口令、晚安） ——
const level = ref(0);
const line = ref('');
const writing = ref(false);
let speech: SpeechQueue | null = null;
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
  void q.drained().then(() => {
    if (speech === q) ambience.duck(false);
  });
  return q;
}
function stopSpeech() {
  speech?.stop();
  speech = null;
  ambience.duck(false);
}
const speaking = computed(() => level.value > 0.02);

/** 让她按"哄睡"功能预设说一段（流式）：onText 每次拿到目前为止的正文。没接通、失败时写明原因 */
async function askHer(task: string, input: string, opts: { userText?: string; cue?: string; onText(full: string): void }): Promise<string | null> {
  if (!chatId.value) return null;
  notConnected.value = '';
  voiceError.value = '';
  asleep.value = false;
  armTimer();
  writing.value = true;
  const r = await chat.sceneReply(chatId.value, { task, input, userText: opts.userText, cue: opts.cue, allowedTags: ['expr'], onText: opts.onText });
  writing.value = false;
  if (r.ok) return r.message.text;
  if (r.notConnected) notConnected.value = r.reason;
  else line.value = `（${r.reason}）`;
  return null;
}

/** 她说一小段（低语、聊天、晚安）：边生成边分句读 */
async function herSays(task: string, input: string, opts: { userText?: string; cue?: string; speedFactor?: number } = {}): Promise<void> {
  const q = newSpeech({ speedFactor: opts.speedFactor });
  const stream = new SentenceStream();
  const text = await askHer(task, input, {
    ...opts,
    onText: (full) => {
      line.value = full;
      if (!q.stopped) q.pushAll(stream.feed(full));
    },
  });
  if (text === null) {
    q.stop();
    return;
  }
  line.value = text;
  if (!q.stopped) q.pushAll(stream.flush(text));
  q.end();
  await q.drained();
}

// —— 聊天：点一下听她低语一句；也可以小声跟她说 ——
const input = ref('');
const replying = computed(() => !!chat.streams[chatId.value]);
function nowLine() {
  return `现在 ${hhmm(Date.now())}，${lightsOff.value ? '已经熄灯了' : '灯还开着'}${ambience.state.playing ? '，开着白噪音' : ''}。`;
}
async function whisper() {
  if (replying.value) return;
  await herSays('sleep-whisper', `${nowLine()}${userName.value}没说话，只是躺着听你说。`, { cue: '低语' });
}
async function sendWords() {
  const text = input.value.trim();
  if (!text || replying.value) return;
  input.value = '';
  await herSays('sleep-chat', `${nowLine()}睡前聊天：${userName.value}躺在床上小声跟你说话，回 1–2 个短句。`, { userText: text, cue: '睡前聊天' });
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
  const q = newSpeech({ speedFactor: 0.9, onSentence: (_t, i) => (story.index = start + i) });
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
  if (replying.value) return;
  const run = (storyRun += 1);
  Object.assign(story, { title: '', sentences: [], index: -1, playing: true, done: false });
  const stream = new SentenceStream();
  const input = [nowLine(), '讲一个新的睡前故事。', toldTitles.length ? `今晚已经讲过：${toldTitles.map((t) => `《${t}》`).join('、')}，不要重复。` : ''].filter(Boolean).join('\n');
  readFrom(0);
  const text = await askHer('sleep-story', input, {
    cue: '睡前故事',
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
  if (text === null) {
    story.playing = false;
    storyQueue?.stop();
    return;
  }
  const parts = splitTitle(text) ?? { title: story.title, body: text };
  story.title = parts.title;
  const rest = stream.flush(parts.body);
  story.sentences.push(...rest);
  story.done = true;
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

// —— 呼吸引导：4-7-8，她小声念口令 ——
const PHASES = [
  { label: '吸气', say: '吸气……', sec: 4, scale: 1.25 },
  { label: '屏住', say: '屏住……', sec: 7, scale: 1.25 },
  { label: '呼气', say: '慢慢呼气……', sec: 8, scale: 0.8 },
];
const breathIndex = ref(0);
const breathCues = ref(true);
let breathTimer: ReturnType<typeof setTimeout> | undefined;
const breath = computed(() => PHASES[breathIndex.value] ?? PHASES[0]!);
function runBreath() {
  clearTimeout(breathTimer);
  const p = PHASES[breathIndex.value] ?? PHASES[0]!;
  if (breathCues.value && mode.value === 'breath') {
    const q = newSpeech({ speedFactor: 0.8 });
    q.push(p.say);
    q.end();
  }
  breathTimer = setTimeout(() => {
    breathIndex.value = (breathIndex.value + 1) % PHASES.length;
    runBreath();
  }, p.sec * 1000);
}

function selectMode(m: Mode) {
  if (m === mode.value) return;
  const was = mode.value;
  mode.value = m;
  if (was === 'breath') clearTimeout(breathTimer);
  // 换到别的模式时，正在读的故事、口令停下（白噪音照常）
  if (was === 'story' && story.playing) toggleStory();
  if (was === 'breath') stopSpeech();
  if (m === 'breath') {
    breathIndex.value = 0;
    armTimer();
    runBreath();
  }
}

// —— 定时：到点她说最后一句晚安，声音渐弱，她也睡着 ——
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
  if (sleepAt.value !== null || ambience.state.playing || story.playing) sleepAt.value = m ? Date.now() + m * 60_000 : null;
});
const remaining = computed(() => {
  if (sleepAt.value === null) return '';
  const s = Math.max(0, Math.round((sleepAt.value - now.value) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
});
async function timeUp() {
  sleepAt.value = null;
  clearTimeout(breathTimer);
  story.playing = false;
  if (chat.streams[chatId.value]) chat.stop(chatId.value);
  stopSpeech();
  lightsOff.value = true;
  if (companionStatus.value.live) await herSays('sleep-end', `${nowLine()}定时到了。`, { cue: '晚安', speedFactor: 0.8 });
  // 说完晚安以后不再重新开始计时
  sleepAt.value = null;
  asleep.value = true;
  await ambience.fadeOut(45);
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
  clearTimeout(breathTimer);
  clearInterval(clockTimer);
  if (chat.streams[chatId.value]) chat.stop(chatId.value);
  stopSpeech();
  ambience.stop();
});

const shownLine = computed(() => {
  if (asleep.value) return '（呼吸声）……';
  if (writing.value && !line.value && mode.value !== 'story') return '';
  if (mode.value === 'story') return story.playing ? `（轻声地读）${story.title ? `《${story.title}》` : '……'}` : line.value || '要不要听我讲个故事？';
  if (mode.value === 'breath') return `跟着我，${breath.value.label}……`;
  if (mode.value === 'noise' && !line.value) return ambience.state.playing ? '听着这个声音，慢慢就困了。' : '';
  return line.value;
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
    :typing="writing && mode !== 'story'"
    :layout="{ left: 50, bottom: 40, height: 50 }"
  >
    <template #actions>
      <button class="lamp" :class="{ off: lightsOff }" :aria-label="lightsOff ? '开灯' : '熄灯'" @click="lightsOff = !lightsOff">
        <span :class="lightsOff ? 'i-lucide-lamp' : 'i-lucide-lamp-desk'" />{{ lightsOff ? '开灯' : '熄灯' }}
      </button>
    </template>

    <div v-if="notConnected" class="notice">
      <span class="i-lucide-plug-zap shrink-0" />
      <span class="flex-1 min-w-0">{{ notConnected }}</span>
      <button class="text-accent-ink shrink-0" @click="router.push('/me/api?feature=companion')">去设置</button>
    </div>
    <div v-else-if="mode !== 'noise' && (!voiceLive || voiceError)" class="notice">
      <span class="i-lucide-volume-x shrink-0" />
      <span class="flex-1 min-w-0">{{ voiceError || `没有声音：语音合成还没接通，或者还没给${her.name}选音色（字幕照常）` }}</span>
      <button class="text-accent-ink shrink-0" @click="router.push('/me/voice')">去设置</button>
    </div>

    <div class="modes">
      <button v-for="m in MODES" :key="m.id" class="mode" :class="{ on: mode === m.id }" :data-mode="m.id" @click="selectMode(m.id)">
        <span :class="m.icon" class="text-[18px]" />{{ m.label }}
      </button>
    </div>

    <!-- 聊天 -->
    <div v-if="mode === 'chat'" class="mt-3 grid gap-2.5">
      <button class="whisper press" :disabled="replying" data-testid="whisper" @click="whisper">
        <span :class="speaking ? 'i-lucide-audio-lines' : 'i-lucide-volume-1'" class="text-[18px] shrink-0" />
        <span class="flex-1 min-w-0">{{ replying ? `${her.pronoun}在想说什么……` : `低语：点一下听${her.pronoun}说一句（语速放慢、只说短句）` }}</span>
      </button>
      <Waveform v-if="speaking" :level="level" />
      <div class="flex gap-2">
        <input v-model="input" class="field" :placeholder="`小声跟${her.pronoun}说……`" aria-label="跟她说" @keydown.enter="sendWords" />
        <van-button size="small" round :disabled="replying || !input.trim()" @click="sendWords">说</van-button>
      </div>
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

    <!-- 呼吸 -->
    <div v-else>
      <div class="breath-wrap">
        <div class="breath" :style="{ transform: `scale(${breath.scale})`, transitionDuration: `${breath.sec}s` }" />
        <div class="absolute text-center">
          <div class="text-[18px] font-600">{{ breath.label }}</div>
          <div class="text-[12px] text-ink-3 num">{{ breath.sec }} 秒</div>
        </div>
      </div>
      <label class="flex items-center gap-2 text-[13px] text-ink-2">
        <van-switch v-model="breathCues" size="18px" />{{ her.pronoun }}小声念口令
      </label>
    </div>

    <div class="mt-4">
      <div class="text-[12.5px] text-ink-3 mb-1.5">
        定时（到点{{ her.pronoun }}说晚安、声音渐弱，{{ her.pronoun }}也会睡着）<span v-if="remaining" class="num text-accent-ink"> · 还剩 {{ remaining }}</span>
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
.modes {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}
.mode {
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
.whisper {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 12px;
  border-radius: 14px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 13px;
  text-align: left;
}
.whisper:disabled {
  opacity: 0.75;
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
.breath-wrap {
  position: relative;
  height: 150px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.breath {
  width: 96px;
  height: 96px;
  border-radius: 50%;
  background: radial-gradient(circle, var(--accent-soft), transparent 70%), var(--accent-soft);
  border: 2px solid var(--accent-line);
  transition-property: transform;
  transition-timing-function: ease-in-out;
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
