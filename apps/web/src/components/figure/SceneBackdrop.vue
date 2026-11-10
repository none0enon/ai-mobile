<script setup lang="ts">
import { timeOfDay, type TimeOfDay } from '@app/shared';
import { computed } from 'vue';

/**
 * 占位场景背景：按"场景 key + 时段"画一张简单的插画。
 * 真背景图以后按同样的 key 放进素材库（{key}_{时段}.webp），这里只做兜底。
 * 背景跟随时段而不是界面主题：夜里的卧室在浅色主题下也是夜里。
 */
const props = withDefaults(defineProps<{ kind: string; tod?: TimeOfDay; rain?: boolean; dim?: number }>(), {
  rain: false,
  dim: 0,
});

const t = computed<TimeOfDay>(() => props.tod ?? timeOfDay(new Date().getHours()));
const night = computed(() => t.value === 'night' || t.value === 'late');
const dusk = computed(() => t.value === 'dusk');

const sky = computed(() => {
  switch (t.value) {
    case 'dawn':
      return ['#ffd6b8', '#fdebdc'];
    case 'morning':
    case 'noon':
      return ['#bfe3f6', '#eaf6f4'];
    case 'afternoon':
      return ['#cfe4f4', '#f6efe2'];
    case 'dusk':
      return ['#f4a07c', '#6f5b9e'];
    default:
      return ['#141d3a', '#0a0f22'];
  }
});

/** 每个场景的底色：[顶, 底]，白天 / 夜里两套 */
const BASE: Record<string, { day: [string, string]; night: [string, string] }> = {
  bedroom: { day: ['#f2e6f2', '#dccfe8'], night: ['#1e1438', '#0b0716'] },
  library: { day: ['#e6edf7', '#cbd6ea'], night: ['#131c36', '#0a0f20'] },
  dining: { day: ['#f7e4cf', '#e6caad'], night: ['#3b2519', '#150b07'] },
  music: { day: ['#f2def0', '#e2d0f0'], night: ['#2b1137', '#0d0614'] },
  cafe: { day: ['#f1e3d3', '#e0c8ae'], night: ['#3a2a20', '#18100b'] },
  aquarium: { day: ['#0e4a70', '#05182b'], night: ['#0b3a5a', '#03101d'] },
  amusement: { day: ['#f5c3d6', '#9d86c9'], night: ['#3a1f50', '#110a1f'] },
  cinema: { day: ['#22121a', '#070406'], night: ['#1c0d13', '#050305'] },
  'night-market': { day: ['#4a2338', '#1a0c16'], night: ['#2c1631', '#0d0612'] },
  gallery: { day: ['#f0ebe5', '#ddd3c8'], night: ['#201c19', '#0f0d0b'] },
  room: { day: ['#f5e9f3', '#e5d8ef'], night: ['#2a1d3a', '#120b1c'] },
};

const outdoor = computed(() => ['park', 'seaside'].includes(props.kind));
const base = computed<[string, string]>(() => {
  if (outdoor.value) return sky.value as [string, string];
  const b = BASE[props.kind] ?? BASE.room!;
  return night.value ? b.night : b.day;
});
const gid = `bd-${Math.random().toString(36).slice(2, 8)}`;

const stars = [
  [40, 60, 1.6],
  [90, 120, 1.2],
  [150, 40, 1.8],
  [220, 90, 1.1],
  [300, 50, 1.5],
  [350, 130, 1.2],
  [270, 160, 1],
  [120, 190, 1.3],
] as const;

const books = Array.from({ length: 3 }, (_, row) =>
  Array.from({ length: 11 }, (_, i) => ({
    x: 22 + i * 33 + (row % 2) * 6,
    y: 90 + row * 110,
    w: 22 + ((i * 7 + row * 3) % 9),
    h: 70 + ((i * 13 + row * 5) % 26),
    hue: (i * 47 + row * 90) % 360,
  })),
).flat();
</script>

<template>
  <div class="backdrop" aria-hidden="true">
    <svg viewBox="0 0 400 800" preserveAspectRatio="xMidYMid slice" class="absolute inset-0 w-full h-full">
      <defs>
        <linearGradient :id="`${gid}-bg`" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" :stop-color="base[0]" />
          <stop offset="1" :stop-color="base[1]" />
        </linearGradient>
        <radialGradient :id="`${gid}-glow`">
          <stop offset="0" stop-color="#ffcf8f" stop-opacity="0.55" />
          <stop offset="1" stop-color="#ffcf8f" stop-opacity="0" />
        </radialGradient>
        <radialGradient :id="`${gid}-cool`">
          <stop offset="0" stop-color="#bfe8ff" stop-opacity="0.35" />
          <stop offset="1" stop-color="#bfe8ff" stop-opacity="0" />
        </radialGradient>
      </defs>
      <rect width="400" height="800" :fill="`url(#${gid}-bg)`" />

      <!-- 卧室：窗、月亮 / 太阳、台灯、床头 -->
      <g v-if="kind === 'bedroom'">
        <rect x="36" y="96" width="150" height="196" rx="10" :fill="night ? '#1b2650' : sky[0]" />
        <rect x="36" y="96" width="150" height="196" rx="10" fill="none" :stroke="night ? '#3b3166' : '#cdb7d6'" stroke-width="8" />
        <path d="M111 96 V292 M36 194 H186" :stroke="night ? '#3b3166' : '#cdb7d6'" stroke-width="5" />
        <circle v-if="night" cx="146" cy="138" r="20" fill="#f7efd2" />
        <circle v-else cx="146" cy="140" r="18" fill="#fff3c4" />
        <g v-if="night" fill="#fff">
          <circle v-for="(s, i) in stars.slice(0, 4)" :key="i" :cx="40 + (s[0] % 130)" :cy="110 + (s[1] % 160)" :r="s[2] * 0.8" class="twinkle" :style="{ animationDelay: `${i * 0.6}s` }" />
        </g>
        <path :fill="night ? '#2c2050' : '#e8cfe0'" d="M20 80 Q60 200 30 320 L10 320 L10 80 Z" />
        <circle cx="330" cy="520" r="150" :fill="`url(#${gid}-glow)`" :opacity="night ? 0.9 : 0.35" />
        <path d="M318 470 L342 470 L350 500 L310 500 Z" :fill="night ? '#f2c98a' : '#e9c48f'" />
        <rect x="327" y="500" width="6" height="40" fill="#8a6a55" />
        <rect x="0" y="610" width="400" height="190" :fill="night ? '#1a1230' : '#cbb9dc'" />
        <path d="M0 640 Q200 600 400 640 L400 800 L0 800 Z" :fill="night ? '#2a1f48' : '#e4d6ef'" />
      </g>

      <!-- 图书馆：书架、台灯 -->
      <g v-else-if="kind === 'library'">
        <rect v-for="(b, i) in books" :key="i" :x="b.x" :y="b.y + (90 - b.h)" :width="b.w" :height="b.h" rx="3" :fill="`hsl(${b.hue} ${night ? 30 : 35}% ${night ? 30 : 72}%)`" />
        <path d="M10 180 H390 M10 290 H390 M10 400 H390" :stroke="night ? '#2a3354' : '#b7c3da'" stroke-width="8" />
        <rect x="0" y="560" width="400" height="240" :fill="night ? '#1a1f33' : '#c9b79c'" />
        <circle cx="90" cy="540" r="150" :fill="`url(#${gid}-glow)`" :opacity="night ? 1 : 0.4" />
        <path d="M70 500 L110 500 L100 470 L80 470 Z" fill="#f2c98a" />
      </g>

      <!-- 餐桌：吊灯、桌面、盘子 -->
      <g v-else-if="kind === 'dining'">
        <path d="M200 0 V140" stroke="#5a4232" stroke-width="3" />
        <path d="M160 140 H240 L224 180 H176 Z" :fill="night ? '#f3c27a' : '#e0b075'" />
        <circle cx="200" cy="230" r="220" :fill="`url(#${gid}-glow)`" :opacity="night ? 1 : 0.5" />
        <rect x="0" y="600" width="400" height="200" :fill="night ? '#4a2f20' : '#c99a73'" />
        <ellipse cx="120" cy="650" rx="56" ry="16" fill="#f6efe6" opacity="0.9" />
        <ellipse cx="290" cy="660" rx="56" ry="16" fill="#f6efe6" opacity="0.9" />
      </g>

      <!-- 公园 / 海边：天空、山 / 海、太阳 -->
      <g v-else-if="kind === 'park'">
        <circle v-if="!night" cx="310" cy="150" r="34" :fill="dusk ? '#ffd28a' : '#fff6d6'" />
        <circle v-else cx="310" cy="140" r="22" fill="#f7efd2" />
        <g v-if="night" fill="#fff">
          <circle v-for="(s, i) in stars" :key="i" :cx="s[0]" :cy="s[1]" :r="s[2]" class="twinkle" :style="{ animationDelay: `${i * 0.4}s` }" />
        </g>
        <path d="M0 470 Q120 400 230 450 T400 430 V800 H0 Z" :fill="night ? '#183a32' : dusk ? '#6b8a6a' : '#86c9a0'" />
        <path d="M0 560 Q150 500 400 560 V800 H0 Z" :fill="night ? '#10291f' : dusk ? '#4f6d50' : '#62ad84'" />
        <path d="M150 800 Q190 640 260 560" :stroke="night ? '#2c4a40' : '#e8dcc0'" stroke-width="34" fill="none" stroke-linecap="round" />
        <g :fill="night ? '#0c201a' : '#3f8a63'">
          <circle cx="60" cy="470" r="34" />
          <circle cx="350" cy="480" r="28" />
        </g>
      </g>
      <g v-else-if="kind === 'seaside'">
        <circle cx="200" cy="420" r="46" :fill="night ? '#f7efd2' : '#ffd28a'" />
        <rect x="0" y="420" width="400" height="380" :fill="night ? '#0f2d45' : '#2f78a0'" />
        <path v-for="i in 6" :key="i" :d="`M${-20 + i * 10} ${450 + i * 26} q40 -10 80 0 t80 0 t80 0 t80 0 t80 0`" stroke="#fff" stroke-opacity="0.25" stroke-width="3" fill="none" />
        <path d="M0 660 Q200 620 400 660 V800 H0 Z" :fill="night ? '#3a3326' : '#f1dcb4'" />
      </g>

      <!-- 一起听歌：同心圆 -->
      <g v-else-if="kind === 'music'" fill="none" :stroke="night ? '#ffffff' : '#7a4f86'" stroke-opacity="0.08">
        <circle v-for="i in 9" :key="i" cx="200" cy="300" :r="30 + i * 34" stroke-width="2" />
      </g>

      <!-- 咖啡店：大窗、光斑、吧台 -->
      <g v-else-if="kind === 'cafe'">
        <rect x="30" y="80" width="340" height="300" rx="14" :fill="night ? '#232b45' : '#d9ecf5'" />
        <g :fill="night ? '#ffcf8f' : '#fff6e0'" :opacity="night ? 0.35 : 0.6">
          <circle cx="90" cy="160" r="26" />
          <circle cx="170" cy="230" r="16" />
          <circle cx="290" cy="150" r="30" />
          <circle cx="330" cy="290" r="18" />
          <circle cx="220" cy="320" r="22" />
        </g>
        <rect x="0" y="590" width="400" height="210" :fill="night ? '#3a281d' : '#b88b62'" />
        <path d="M150 560 h50 v36 a14 14 0 0 1 -14 14 h-22 a14 14 0 0 1 -14 -14 Z" fill="#f4ece2" />
        <circle cx="200" cy="300" r="190" :fill="`url(#${gid}-glow)`" opacity="0.5" />
      </g>

      <!-- 水族馆：光束、气泡、鱼 -->
      <g v-else-if="kind === 'aquarium'">
        <path d="M80 0 L160 0 L260 800 L120 800 Z M240 0 L300 0 L380 800 L290 800 Z" fill="#ffffff" opacity="0.05" />
        <g fill="none" stroke="#bfe8ff" stroke-opacity="0.45" stroke-width="2">
          <circle cx="60" cy="520" r="6" />
          <circle cx="76" cy="470" r="4" />
          <circle cx="330" cy="380" r="7" />
          <circle cx="342" cy="330" r="4" />
        </g>
        <g fill="#9fd8ff" opacity="0.5">
          <path d="M120 260 q30 -18 60 0 q-30 18 -60 0 Z M180 260 l16 -12 v24 Z" />
          <path d="M240 420 q24 -14 48 0 q-24 14 -48 0 Z M288 420 l12 -9 v18 Z" />
          <path d="M60 360 q18 -10 36 0 q-18 10 -36 0 Z M96 360 l10 -7 v14 Z" />
        </g>
        <circle cx="200" cy="200" r="240" :fill="`url(#${gid}-cool)`" />
      </g>

      <!-- 游乐园：摩天轮、串灯 -->
      <g v-else-if="kind === 'amusement'">
        <g :stroke="night ? '#f39cc0' : '#ffffff'" stroke-opacity="0.6" fill="none" stroke-width="3">
          <circle cx="250" cy="300" r="130" />
          <path v-for="i in 8" :key="i" :d="`M250 300 L${250 + 130 * Math.cos((i * Math.PI) / 4)} ${300 + 130 * Math.sin((i * Math.PI) / 4)}`" />
          <path d="M250 300 L200 520 M250 300 L300 520" />
        </g>
        <g :fill="night ? '#ffd38a' : '#ffffff'">
          <circle v-for="i in 8" :key="i" :cx="250 + 130 * Math.cos((i * Math.PI) / 4)" :cy="300 + 130 * Math.sin((i * Math.PI) / 4)" r="9" />
        </g>
        <path d="M0 120 Q200 180 400 110" stroke="#fff" stroke-opacity="0.2" fill="none" />
        <g>
          <circle v-for="i in 9" :key="i" :cx="i * 44" :cy="120 + Math.sin(i) * 14 + 20" r="4" :fill="['#ff9fa8', '#ffd38a', '#9fd8ff'][i % 3]" class="twinkle" :style="{ animationDelay: `${i * 0.3}s` }" />
        </g>
        <rect x="0" y="560" width="400" height="240" :fill="night ? '#1b1030' : '#8f78bd'" />
      </g>

      <!-- 电影院：银幕光、座位 -->
      <g v-else-if="kind === 'cinema'">
        <rect x="40" y="70" width="320" height="170" rx="6" fill="#e9e4ff" opacity="0.16" />
        <path d="M40 240 L360 240 L400 560 L0 560 Z" fill="#e9e4ff" opacity="0.04" />
        <g fill="#2a1520">
          <rect v-for="i in 7" :key="`a${i}`" :x="i * 58 - 30" y="600" width="48" height="70" rx="12" />
          <rect v-for="i in 7" :key="`b${i}`" :x="i * 58 - 4" y="690" width="48" height="80" rx="12" />
        </g>
      </g>

      <!-- 夜市：灯笼、摊位 -->
      <g v-else-if="kind === 'night-market'">
        <path d="M0 140 Q200 200 400 130" stroke="#f2a65e" stroke-opacity="0.4" fill="none" />
        <g v-for="i in 6" :key="i">
          <circle :cx="i * 64 - 20" :cy="160 + Math.sin(i * 1.3) * 16 + 20" r="34" fill="#ff7a5c" opacity="0.18" />
          <ellipse :cx="i * 64 - 20" :cy="160 + Math.sin(i * 1.3) * 16 + 20" rx="14" ry="18" fill="#e9573f" />
        </g>
        <path d="M0 520 L80 470 L160 520 Z M150 520 L240 460 L330 520 Z M300 520 L380 470 L460 520 Z" fill="#7a2f3a" />
        <rect x="0" y="520" width="400" height="280" fill="#1c0d17" />
      </g>

      <!-- 美术馆：画框 -->
      <g v-else-if="kind === 'gallery'">
        <g v-for="(f, i) in [[40, 140, 120, 150, 30], [190, 110, 170, 210, 210], [60, 330, 90, 110, 140]]" :key="i">
          <rect :x="f[0]" :y="f[1]" :width="f[2]" :height="f[3]" :fill="night ? '#3a332c' : '#c8b49a'" />
          <rect :x="(f[0] ?? 0) + 10" :y="(f[1] ?? 0) + 10" :width="(f[2] ?? 0) - 20" :height="(f[3] ?? 0) - 20" :fill="`hsl(${f[4]} 40% ${night ? 30 : 70}%)`" />
        </g>
        <rect x="0" y="600" width="400" height="200" :fill="night ? '#171310' : '#cdbfae'" />
      </g>

      <!-- 默认房间：柔和的圆 -->
      <g v-else :fill="night ? '#ffffff' : '#a07ab8'" fill-opacity="0.05">
        <circle cx="80" cy="160" r="120" />
        <circle cx="330" cy="420" r="160" />
        <circle cx="140" cy="640" r="110" />
      </g>
    </svg>
    <div v-if="rain" class="rain" />
    <div class="vignette" :style="{ '--dim': dim }" />
  </div>
</template>

<style scoped>
.backdrop {
  position: absolute;
  inset: 0;
  overflow: hidden;
}
.twinkle {
  animation: twinkle 3.2s ease-in-out infinite;
}
.rain {
  position: absolute;
  inset: -20%;
  background-image: repeating-linear-gradient(
    105deg,
    rgba(255, 255, 255, 0) 0 14px,
    rgba(255, 255, 255, 0.18) 14px 15px,
    rgba(255, 255, 255, 0) 15px 34px
  );
  background-size: 60px 120px;
  animation: rain 0.9s linear infinite;
  opacity: 0.55;
  pointer-events: none;
}
.vignette {
  position: absolute;
  inset: 0;
  background:
    linear-gradient(180deg, rgba(5, 3, 10, 0.35) 0%, rgba(5, 3, 10, 0) 22%, rgba(5, 3, 10, 0) 55%, rgba(5, 3, 10, 0.55) 100%),
    rgba(5, 3, 10, calc(var(--dim) * 1));
  pointer-events: none;
}
</style>
