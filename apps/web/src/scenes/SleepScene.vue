<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import SceneShell from '@/components/scene/SceneShell.vue';
import { envSettings } from '@/mock/settings';

/**
 * 哄睡：暗色卧室。睡前聊天（低语）/ 睡前故事 / 白噪音 / 呼吸引导；
 * 定时器到点声音渐弱、她也睡着；第二天早上她来电叫醒你。
 */
type Mode = 'chat' | 'story' | 'noise' | 'breath';
const mode = ref<Mode>('chat');
const MODES: { id: Mode; label: string; icon: string }[] = [
  { id: 'chat', label: '聊天', icon: 'i-lucide-message-circle' },
  { id: 'story', label: '故事', icon: 'i-lucide-book-heart' },
  { id: 'noise', label: '白噪音', icon: 'i-lucide-waves' },
  { id: 'breath', label: '呼吸', icon: 'i-lucide-wind' },
];

const WHISPERS = ['今天辛苦了……', '把手机放远一点，好不好？', '我在这儿，你闭上眼睛就好。', '明天的事，明天再想。', '晚安……做个好梦。'];
const whisperIndex = ref(0);
const lightsOff = ref(false);
const timerMin = ref<number | null>(30);
const wakeCall = ref(true);
const playing = ref(false);
const mix = ref({ rain: 60, fire: 20, waves: 0, fan: 10 });

const story = {
  title: '月亮邮差',
  paragraphs: [
    '很久很久以前，月亮上住着一个邮差。他的工作，是把人们睡前没说出口的话，装进银色的信封里。',
    '每天晚上，他骑着一辆会发光的自行车，沿着屋顶慢慢地走，把信一封一封地放到窗台上。',
    '今晚，他在你的窗台上停了很久。信封上只写了一行字：别熬夜了，笨蛋。',
  ],
};

// 呼吸引导：4-7-8
const PHASES = [
  { label: '吸气', sec: 4, scale: 1.25 },
  { label: '屏住', sec: 7, scale: 1.25 },
  { label: '呼气', sec: 8, scale: 0.8 },
];
const breathIndex = ref(0);
let breathTimer: ReturnType<typeof setTimeout> | undefined;
function runBreath() {
  clearTimeout(breathTimer);
  const p = PHASES[breathIndex.value] ?? PHASES[0]!;
  breathTimer = setTimeout(() => {
    breathIndex.value = (breathIndex.value + 1) % PHASES.length;
    runBreath();
  }, p.sec * 1000);
}
const breath = computed(() => PHASES[breathIndex.value] ?? PHASES[0]!);

function selectMode(m: Mode) {
  mode.value = m;
  if (m === 'breath') {
    breathIndex.value = 0;
    runBreath();
  } else {
    clearTimeout(breathTimer);
  }
}
onBeforeUnmount(() => clearTimeout(breathTimer));

const line = computed(() => {
  if (lightsOff.value) return '（小声）……晚安。';
  if (mode.value === 'story') return playing.value ? '（轻声地读）……' : '今晚给你讲《月亮邮差》，好不好？';
  if (mode.value === 'breath') return `跟着我，${breath.value.label}……`;
  if (mode.value === 'noise') return '下雨的声音，最好睡了。';
  return WHISPERS[whisperIndex.value] ?? '';
});
</script>

<template>
  <SceneShell
    scene-id="sleep"
    tod="late"
    :dim="lightsOff ? 0.55 : 0.15"
    :rain="mix.rain > 0"
    :expression="lightsOff ? 'sleep' : 'sleepy'"
    :line="line"
    :layout="{ left: 50, bottom: 40, height: 50 }"
  >
    <template #actions>
      <button class="lamp" :class="{ off: lightsOff }" :aria-label="lightsOff ? '开灯' : '熄灯'" @click="lightsOff = !lightsOff">
        <span :class="lightsOff ? 'i-lucide-lamp' : 'i-lucide-lamp-desk'" />{{ lightsOff ? '开灯' : '熄灯' }}
      </button>
    </template>

    <div class="modes">
      <button v-for="m in MODES" :key="m.id" class="mode" :class="{ on: mode === m.id }" @click="selectMode(m.id)">
        <span :class="m.icon" class="text-[18px]" />{{ m.label }}
      </button>
    </div>

    <div v-if="mode === 'chat'" class="mt-3">
      <button class="whisper press" @click="whisperIndex = (whisperIndex + 1) % WHISPERS.length">
        <span class="i-lucide-volume-1" />低语模式：语速放慢、只说短句（点一下听下一句）
      </button>
    </div>
    <div v-else-if="mode === 'story'" class="mt-3">
      <div class="flex items-center gap-2">
        <span class="text-[15px] font-600 serif">《{{ story.title }}》</span>
        <span class="text-[12px] text-ink-3">她现编的睡前故事</span>
        <button class="ml-auto play" :aria-label="playing ? '暂停' : '播放'" @click="playing = !playing"><span :class="playing ? 'i-lucide-pause' : 'i-lucide-play'" /></button>
      </div>
      <p class="story serif">{{ story.paragraphs.join('') }}</p>
    </div>
    <div v-else-if="mode === 'noise'" class="mt-3 grid gap-3">
      <div v-for="(label, key) in { rain: '雨声', fire: '炉火', waves: '海浪', fan: '风扇' }" :key="key" class="flex items-center gap-3">
        <span class="w-10 text-[13px] text-ink-2">{{ label }}</span>
        <van-slider v-model="mix[key]" class="flex-1" bar-height="4px" button-size="16px" />
        <span class="w-8 text-right text-[12px] text-ink-3 num">{{ mix[key] }}</span>
      </div>
    </div>
    <div v-else class="breath-wrap">
      <div class="breath" :style="{ transform: `scale(${breath.scale})`, transitionDuration: `${breath.sec}s` }" />
      <div class="absolute text-center">
        <div class="text-[18px] font-600">{{ breath.label }}</div>
        <div class="text-[12px] text-ink-3 num">{{ breath.sec }} 秒</div>
      </div>
    </div>

    <div class="mt-4">
      <div class="text-[12.5px] text-ink-3 mb-1.5">定时（到点声音渐弱，她也会睡着）</div>
      <div class="flex gap-2">
        <button v-for="t in [15, 30, 60]" :key="t" class="chip-opt num" :class="{ on: timerMin === t }" @click="timerMin = t">{{ t }} 分钟</button>
        <button class="chip-opt" :class="{ on: timerMin === null }" @click="timerMin = null">不定时</button>
      </div>
    </div>
    <div class="flex items-center justify-between mt-3.5">
      <div>
        <div class="text-[14px]">明早 {{ envSettings.wakeTime }} 她打电话叫醒你</div>
        <div class="text-[12px] text-ink-3">安卓：精确闹钟 + 全屏来电；iPhone：推送点开接听</div>
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
.story {
  margin: 8px 0 0;
  font-size: 14.5px;
  line-height: 1.85;
  color: var(--ink-2);
  max-height: 104px;
  overflow-y: auto;
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
}
.chip-opt.on {
  background: var(--accent);
  color: var(--on-accent);
  font-weight: 600;
}
</style>
