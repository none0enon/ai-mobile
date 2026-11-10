<script setup lang="ts">
import { worldOf } from '@app/shared';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import HerSide from '@/components/scene/HerSide.vue';
import SceneShell from '@/components/scene/SceneShell.vue';
import TimerRing from '@/components/scene/TimerRing.vue';
import { mockToday } from '@/mock/activity';
import { services } from '@/services';
import { useAppStore } from '@/stores/app';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';
import { useRealWorldStore } from '@/stores/realworld';

/**
 * 陪伴学习（默认"连线自习"）：你在你那儿学，她在她世界的图书馆学，共用一个番茄钟。
 * 她也有自己的任务和进度，每个番茄结束各报一下——互相监督，不只是她看着你。
 * 专注时她安静地陪着（不说话），休息时才聊；专注中离开 App 再回来，她会轻轻提醒一句。
 */
const FOCUS = 25 * 60;
const BREAK = 5 * 60;
const today = mockToday();

const phase = ref<'focus' | 'break'>('focus');
const running = ref(false);
const remain = ref(FOCUS);
const done = ref(today.pomodoros);
const distractions = ref(0);
const noise = ref<string | null>('rain');
const tasks = ref([
  { text: '高数第三章习题', done: true },
  { text: '背单词 50 个', done: false },
  { text: '论文相关工作 2 页', done: false },
]);
const newTask = ref('');
const line = ref('今天要学什么？我陪你。');

const total = computed(() => (phase.value === 'focus' ? FOCUS : BREAK));

// —— 她那边：她自己在学什么、学了多少 ——
const app = useAppStore();
const chars = useCharacterStore();
const chat = useChatStore();
const real = useRealWorldStore();
const her = computed(() => chars.byId(app.activeCharacterId) ?? chars.list[0]!);
const herTask = computed(() => worldOf(her.value.id).life.studyTask);
const herDone = ref(today.pomodoros);
const herSays = computed(() => `${herDone.value} 个番茄 · 和你一样`);
const mode = computed(() => chat.chatOfCharacter(her.value.id)?.togetherMode ?? 'remote');
const yourPlace = computed(() => (mode.value === 'bring' ? '' : (real.places.find((p) => p.id === real.hereId)?.name ?? '家')));
let timer: ReturnType<typeof setInterval> | undefined;

function tick() {
  remain.value -= 1;
  if (remain.value > 0) return;
  if (phase.value === 'focus') {
    done.value += 1;
    herDone.value += 1;
    phase.value = 'break';
    remain.value = BREAK;
    line.value = '一个番茄完成！我这边又写了一页。你呢？休息五分钟，跟我聊聊天？';
    services.native.vibrate([20, 60, 20]);
  } else {
    phase.value = 'focus';
    remain.value = FOCUS;
    line.value = '休息结束～继续加油，我也在看书。';
  }
}

function toggle() {
  running.value = !running.value;
  clearInterval(timer);
  if (running.value) {
    timer = setInterval(tick, 1000);
    void services.native.keepAwake(true);
    if (phase.value === 'focus') line.value = '';
  } else {
    void services.native.keepAwake(false);
    line.value = '暂停一下也好，喝口水吧。';
  }
}
function giveUp() {
  running.value = false;
  clearInterval(timer);
  phase.value = 'focus';
  remain.value = FOCUS;
  line.value = '没关系，状态不好就换个方式。要不要先休息？';
}
function addFive() {
  remain.value += 5 * 60;
}
function addTask() {
  const t = newTask.value.trim();
  if (!t) return;
  tasks.value.push({ text: t, done: false });
  newTask.value = '';
}

/** 专注中切走 App：回来时她轻轻说一句 */
function onVisibility() {
  if (document.visibilityState === 'visible' && running.value && phase.value === 'focus') {
    distractions.value += 1;
    line.value = '刚才去哪儿啦？专心一点哦～我在等你。';
  }
}
onMounted(() => document.addEventListener('visibilitychange', onVisibility));
onBeforeUnmount(() => {
  clearInterval(timer);
  document.removeEventListener('visibilitychange', onVisibility);
  void services.native.keepAwake(false);
});

const quiet = computed(() => running.value && phase.value === 'focus');
const NOISES = [
  { id: 'rain', label: '雨声', icon: 'i-lucide-cloud-rain' },
  { id: 'pages', label: '翻书', icon: 'i-lucide-book-open' },
  { id: 'cafe', label: '咖啡馆', icon: 'i-lucide-coffee' },
];
</script>

<template>
  <SceneShell
    scene-id="study"
    :line="quiet ? '' : line"
    :expression="quiet ? 'neutral' : 'smile'"
    pose="study"
    :rain="noise === 'rain'"
    :layout="{ left: 80, bottom: 58, height: 28 }"
  >
    <template #overlay>
      <div v-if="quiet" class="quiet"><span class="i-lucide-moon" />她在安静地陪你看书 · 专注时不打扰</div>
    </template>

    <HerSide label="在学：" :content="herTask" :extra="herSays" />

    <TimerRing class="mt-3" :remain-sec="remain" :total-sec="total" :size="168" :label="phase === 'focus' ? `一起专注 · 第 ${done + 1} 个番茄` : '一起休息'" :tone="phase === 'focus' ? '#8fb3f0' : 'var(--good)'" />

    <div class="flex gap-2 mt-3 btns">
      <van-button round block @click="giveUp">放弃</van-button>
      <van-button type="primary" round block @click="toggle">{{ running ? '暂停' : '开始' }}</van-button>
      <van-button round block @click="addFive">+5 分钟</van-button>
    </div>

    <div class="flex items-center gap-2 mt-3.5 overflow-x-auto hide-scrollbar">
      <span class="text-[12.5px] text-ink-3 whitespace-nowrap shrink-0">白噪音</span>
      <button v-for="n in NOISES" :key="n.id" class="noise" :class="{ on: noise === n.id }" @click="noise = noise === n.id ? null : n.id">
        <span :class="n.icon" />{{ n.label }}
      </button>
    </div>

    <div class="mt-3.5">
      <div class="text-[12.5px] text-ink-3 mb-1.5">你这边{{ yourPlace ? ` · ${yourPlace}` : '' }} · 这次要完成</div>
      <label v-for="(t, i) in tasks" :key="i" class="task">
        <van-checkbox v-model="t.done" icon-size="18px" />
        <span :class="{ 'line-through text-ink-3': t.done }">{{ t.text }}</span>
      </label>
      <div class="flex gap-2 mt-1.5">
        <input v-model="newTask" class="field" placeholder="加一个任务" aria-label="新任务" @keydown.enter="addTask" />
        <van-button size="small" round @click="addTask">添加</van-button>
      </div>
    </div>

    <div class="stats num">
      今天 {{ done }} 个番茄 · {{ done * 25 }} 分钟 · 连续 6 天
      <span v-if="distractions"> · 走神 {{ distractions }} 次</span>
    </div>
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
.btns :deep(.van-button) {
  padding: 0 8px;
  white-space: nowrap;
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
.stats {
  margin-top: 14px;
  font-size: 12.5px;
  color: var(--ink-3);
  text-align: center;
}
</style>
