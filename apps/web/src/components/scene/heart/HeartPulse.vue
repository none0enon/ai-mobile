<script setup lang="ts">
import { TOY_KIND_LABEL, type ToyKind } from '@app/shared';
import { computed } from 'vue';
import type { ToyLevels } from '@/services/toyPlayer';

/**
 * 心跳画面最下面的那条（压在图上，不挡脸）：
 * 左边一颗按心率跳的心和心率；中间一段心电图，一拍走一格，越激烈波形越高；右边每一种玩具现在的强度（震动的每个马达一根）；
 * 有东西在动时最右边是"停"（一下全部停下，之后她的指令先不执行），按过停是"继续"。点中间去连玩具、看设置。
 */
const props = defineProps<{
  bpm: number;
  /** 0–100 */
  intensity: number;
  levels: ToyLevels;
  kinds: ToyKind[];
  /** 上面一行小字：连着哪个玩具、在做什么，或者为什么没连 */
  status: string;
  /** 指令会执行（连着玩具，或者在界面上试） */
  live: boolean;
  held: boolean;
}>();
defineEmits<{ (e: 'stop'): void; (e: 'resume'): void; (e: 'open'): void }>();

const SHORT: Record<ToyKind, string> = { vibrate: '震', oscillate: '摆', rotate: '转', constrict: '缩', inflate: '气', linear: '伸' };

const beatMs = computed(() => Math.round(60_000 / Math.max(40, props.bpm)));

/** 一拍的波形（宽 60，基线 y = 24）：P 波、QRS、T 波；amp 越大越高 */
const CYCLE = 60;
function cycle(x0: number, amp: number): string {
  const y = (v: number) => (24 - (24 - v) * amp).toFixed(1);
  const x = (v: number) => (x0 + v).toFixed(1);
  return [
    `L${x(14)},24`,
    `Q${x(16)},${y(20.5)} ${x(18)},24`,
    `L${x(22)},24`,
    `L${x(24)},${y(27)}`,
    `L${x(26)},${y(5)}`,
    `L${x(28.5)},${y(33)}`,
    `L${x(30.5)},24`,
    `L${x(36)},24`,
    `Q${x(40)},${y(17)} ${x(44)},24`,
    `L${x(60)},24`,
  ].join(' ');
}
const ecg = computed(() => {
  // 强度按 10 一档算，免得每次都重画；最高时尖峰刚好碰到上下边
  const amp = 0.5 + Math.round(props.intensity / 10) * 0.065;
  let d = 'M0,24';
  for (let i = 0; i < 8; i += 1) d += ` ${cycle(i * CYCLE, amp)}`;
  return d;
});

/** 每一种一根（震动每个马达一根） */
const bars = computed(() => {
  const out: { key: string; label: string; value: number; title: string }[] = [];
  for (const k of props.kinds) {
    if (k === 'vibrate') {
      const motors = props.levels.vibrate.length ? props.levels.vibrate : [0];
      motors.forEach((v, i) => out.push({ key: `v${i}`, label: motors.length > 1 ? `震${i + 1}` : SHORT.vibrate, value: v, title: `${TOY_KIND_LABEL.vibrate}${motors.length > 1 ? ` ${i + 1}` : ''} ${v}%` }));
    } else if (k === 'linear') out.push({ key: 'l', label: SHORT.linear, value: props.levels.pace, title: `${TOY_KIND_LABEL.linear} 速度 ${props.levels.pace}` });
    else out.push({ key: k, label: SHORT[k], value: props.levels[k], title: `${TOY_KIND_LABEL[k]} ${props.levels[k]}%` });
  }
  return out.slice(0, 6);
});
const moving = computed(() => props.intensity > 0);
</script>

<template>
  <div class="pulse" :class="{ hot: intensity >= 60, warm: intensity > 0 && intensity < 60 }" :style="{ '--beat': `${beatMs}ms` }" data-testid="heart-pulse">
    <div class="beat" role="img" :aria-label="`心跳 ${bpm}`">
      <span class="i-lucide-heart heart" />
      <span class="bpm num">{{ bpm }}</span>
    </div>
    <button type="button" class="mid" aria-label="玩具和画面的设置" @click="$emit('open')">
      <span class="status">{{ status }}</span>
      <svg class="ecg" viewBox="0 0 240 36" preserveAspectRatio="none" aria-hidden="true">
        <g class="trace">
          <path :d="ecg" />
        </g>
      </svg>
    </button>
    <div v-if="live && bars.length" class="bars" aria-label="玩具现在的强度">
      <span v-for="b in bars" :key="b.key" class="bar" :title="b.title">
        <span class="track"><span class="fill" :style="{ height: `${b.value}%` }" /></span>
        <span class="lab">{{ b.label }}</span>
      </span>
    </div>
    <button v-if="held" type="button" class="ctl resume" aria-label="继续：她的指令接着执行" data-testid="toy-resume" @click="$emit('resume')">
      <span class="i-lucide-play" />
    </button>
    <button v-else-if="live" type="button" class="ctl stop" :class="{ idle: !moving }" aria-label="全部停下" data-testid="toy-stop" @click="$emit('stop')">
      <span class="i-lucide-square" />
    </button>
  </div>
</template>

<style scoped>
.pulse {
  --tone: #ff7a93;
  display: flex;
  align-items: center;
  gap: 10px;
  height: 58px;
  padding: 0 8px 0 12px;
  border-radius: 20px;
  background: var(--veil);
  border: 1px solid var(--glass-line);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  box-shadow: var(--shadow-sm);
  transition: border-color 0.6s ease, box-shadow 0.6s ease;
}
.pulse.warm {
  border-color: color-mix(in srgb, var(--tone) 35%, transparent);
}
.pulse.hot {
  border-color: color-mix(in srgb, var(--tone) 60%, transparent);
  box-shadow:
    var(--shadow-sm),
    0 0 22px color-mix(in srgb, var(--tone) 35%, transparent);
}
.beat {
  display: flex;
  flex-direction: column;
  align-items: center;
  flex-shrink: 0;
  width: 38px;
}
.heart {
  font-size: 22px;
  color: var(--tone);
  animation: lubdub var(--beat) infinite;
  filter: drop-shadow(0 0 6px color-mix(in srgb, var(--tone) 55%, transparent));
}
.bpm {
  margin-top: 1px;
  font-size: 12px;
  line-height: 1;
  color: var(--ink-2);
}
.mid {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
  height: 100%;
  padding: 0;
  text-align: left;
}
.status {
  overflow: hidden;
  font-size: 11.5px;
  line-height: 1.3;
  color: var(--ink-2);
  white-space: nowrap;
  text-overflow: ellipsis;
}
.ecg {
  display: block;
  width: 100%;
  height: 26px;
  overflow: hidden;
  -webkit-mask-image: linear-gradient(to right, transparent, #000 14%, #000 82%, transparent);
  mask-image: linear-gradient(to right, transparent, #000 14%, #000 82%, transparent);
}
.trace {
  animation: sweep var(--beat) linear infinite;
}
.trace path {
  fill: none;
  stroke: var(--tone);
  stroke-width: 1.6;
  stroke-linejoin: round;
  stroke-linecap: round;
  vector-effect: non-scaling-stroke;
}
.bars {
  display: flex;
  align-items: flex-end;
  gap: 5px;
  flex-shrink: 0;
}
.bar {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}
.track {
  position: relative;
  display: block;
  width: 6px;
  height: 26px;
  border-radius: 3px;
  background: var(--glass-line);
  overflow: hidden;
}
.fill {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  border-radius: 3px;
  background: linear-gradient(to top, color-mix(in srgb, var(--tone) 70%, #fff 0%), var(--tone));
  transition: height 0.18s ease-out;
}
.lab {
  font-size: 9.5px;
  line-height: 1;
  color: var(--ink-3);
}
.ctl {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 38px;
  height: 38px;
  border-radius: 50%;
  font-size: 15px;
}
.ctl.stop {
  color: #fff;
  background: color-mix(in srgb, var(--bad) 88%, transparent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--bad) 25%, transparent);
}
.ctl.stop.idle {
  color: var(--bad);
  background: transparent;
  box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--bad) 70%, transparent);
}
.ctl.resume {
  color: var(--on-accent);
  background: var(--accent);
}
@keyframes lubdub {
  0% {
    transform: scale(1);
  }
  12% {
    transform: scale(1.24);
  }
  24% {
    transform: scale(0.98);
  }
  36% {
    transform: scale(1.14);
  }
  60%,
  100% {
    transform: scale(1);
  }
}
@keyframes sweep {
  from {
    transform: translateX(0);
  }
  to {
    transform: translateX(-60px);
  }
}
</style>
