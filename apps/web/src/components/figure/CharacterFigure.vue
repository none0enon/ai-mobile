<script setup lang="ts">
import { computed } from 'vue';
import { mix } from '@/utils/color';

/**
 * 占位立绘：用 SVG 画一个简笔半身像，表情 / 服装 / 姿势都能变，用来演示换表情和戳戳乐。
 * 导入真立绘后，StageView 会改用图片（按 {服装}_{姿势}_{表情}.webp 查找），这个组件只做兜底。
 * 画布 600×1000；crop="head" 时只取头部，用作头像。
 */
const props = withDefaults(
  defineProps<{
    accent: string;
    hair: string;
    eye?: string;
    hairStyle?: 'long' | 'short';
    expression?: string;
    outfit?: string;
    pose?: string;
    crop?: 'full' | 'head';
    title?: string;
  }>(),
  { eye: '#3b2531', hairStyle: 'long', expression: 'neutral', outfit: 'daily', pose: 'stand', crop: 'full', title: '' },
);

const SKIN = '#f8dfd2';
const SKIN_SHADE = '#efc5b4';
const LINE = '#2c1a24';
const MOUTH = '#b9475e';

const viewBox = computed(() => (props.crop === 'head' ? '150 170 300 300' : '0 0 600 1000'));
const hairHi = computed(() => mix(props.hair, '#ffffff', 0.22));
const hairDark = computed(() => mix(props.hair, '#000000', 0.25));

const outfitColors = computed(() => {
  const a = props.accent;
  switch (props.outfit) {
    case 'sport':
      return { main: mix(a, '#3d6fb8', 0.6), trim: '#ffffff' };
    case 'pajama':
      return { main: mix(a, '#c9c0f0', 0.7), trim: '#ffffff' };
    case 'date':
      return { main: mix(a, '#b84a67', 0.45), trim: '#f6d77a' };
    case 'apron':
      return { main: mix(a, '#ffffff', 0.45), trim: '#fffaf5' };
    default:
      return { main: mix(a, '#ffffff', 0.4), trim: '#fbf7f4' };
  }
});

const e = computed(() => props.expression);
const closedHappy = computed(() => e.value === 'smile' || e.value === 'laugh');
const BLUSH: Record<string, number> = { blush: 0.6, shy: 0.5, laugh: 0.38, pout: 0.34, smile: 0.24 };
const blushOpacity = computed(() => BLUSH[e.value] ?? 0.12);

/** 两只眼睛的中心 */
const eyes = [252, 348];

function irisShape() {
  switch (e.value) {
    case 'surprised':
      return { rx: 17, ry: 23, dx: 0, dy: 0 };
    case 'shy':
      return { rx: 14, ry: 17, dx: 6, dy: 2 };
    case 'angry':
      return { rx: 14, ry: 14, dx: 0, dy: 2 };
    case 'sad':
      return { rx: 14, ry: 18, dx: 0, dy: 3 };
    case 'pout':
      return { rx: 14, ry: 17, dx: -3, dy: 0 };
    default:
      return { rx: 15, ry: 20, dx: 0, dy: 0 };
  }
}
const iris = computed(irisShape);

function lash(cx: number, side: -1 | 1): string {
  // side：左眼 -1，右眼 1；内眼角在靠近鼻子的一侧
  const inner = cx - side * 19;
  const outer = cx + side * 19;
  switch (e.value) {
    case 'angry':
      return `M${outer} 404 Q${cx} 404 ${inner} 414`;
    case 'sad':
      return `M${outer} 410 Q${cx} 400 ${inner} 403`;
    case 'surprised':
      return `M${outer} 398 Q${cx} 386 ${inner} 398`;
    default:
      return `M${outer} 406 Q${cx} 394 ${inner} 405`;
  }
}

function brow(cx: number, side: -1 | 1): string {
  const inner = cx - side * 18;
  const outer = cx + side * 18;
  switch (e.value) {
    case 'sad':
      return `M${outer} 376 Q${cx} 366 ${inner} 360`;
    case 'angry':
      return `M${outer} 362 Q${cx} 366 ${inner} 377`;
    case 'surprised':
      return `M${outer} 360 Q${cx} 350 ${inner} 358`;
    default:
      return `M${outer} 372 Q${cx} 364 ${inner} 370`;
  }
}

const mouth = computed(() => {
  switch (e.value) {
    case 'smile':
      return { d: 'M284 484 Q300 500 316 484', fill: false };
    case 'laugh':
      return { d: 'M282 480 Q300 514 318 480 Z', fill: true, tongue: true };
    case 'blush':
      return { d: 'M288 486 Q300 496 312 486', fill: false };
    case 'shy':
      return { d: 'M288 490 Q294 485 300 490 Q306 495 312 490', fill: false };
    case 'pout':
      return { d: 'M293 490 Q300 481 307 490 Q300 497 293 490 Z', fill: true };
    case 'surprised':
      return { ellipse: { rx: 8, ry: 10 }, fill: true };
    case 'sad':
      return { d: 'M286 495 Q300 483 314 495', fill: false };
    case 'angry':
      return { d: 'M286 494 Q300 484 314 494', fill: false };
    case 'sleepy':
      return { ellipse: { rx: 6, ry: 7 }, fill: true };
    case 'sleep':
      return { d: 'M294 490 Q300 493 306 490', fill: false };
    default:
      return { d: 'M290 488 Q300 492 310 488', fill: false };
  }
});

const isLong = computed(() => props.hairStyle === 'long');
</script>

<template>
  <svg :viewBox="viewBox" class="figure" role="img" :aria-label="title || '占位立绘'" preserveAspectRatio="xMidYMax meet">
    <!-- 躺着：枕头在最后面 -->
    <ellipse v-if="pose === 'lie'" cx="300" cy="520" rx="270" ry="160" fill="#ece6f8" />

    <!-- 后发 -->
    <path
      v-if="isLong"
      :fill="hair"
      d="M300 166 C176 166 120 262 124 392 C128 520 110 642 130 774 C210 806 390 806 470 774 C490 642 472 520 476 392 C480 262 424 166 300 166 Z"
    />
    <path
      v-else
      :fill="hair"
      d="M300 174 C188 174 144 258 148 362 C150 420 158 466 174 502 L426 502 C442 466 450 420 452 362 C456 258 412 174 300 174 Z"
    />

    <!-- 身体 -->
    <path :fill="outfitColors.main" d="M86 1000 C90 846 150 740 246 706 C268 698 332 698 354 706 C450 740 510 846 514 1000 Z" />
    <!-- 衣服细节 -->
    <g v-if="outfit === 'daily' || outfit === 'apron'">
      <path :fill="outfitColors.trim" d="M246 706 L300 806 L354 706 Z" />
      <path :stroke="mix(outfitColors.main, '#000', 0.18)" stroke-width="5" fill="none" d="M246 706 L284 1000 M354 706 L316 1000" />
      <circle cx="292" cy="880" r="6" :fill="mix(outfitColors.main, '#000', 0.2)" />
      <circle cx="292" cy="940" r="6" :fill="mix(outfitColors.main, '#000', 0.2)" />
      <path :fill="mix(accent, '#b84a67', 0.4)" d="M300 724 l-22 -12 l0 26 Z M300 724 l22 -12 l0 26 Z" />
      <circle cx="300" cy="724" r="7" :fill="mix(accent, '#b84a67', 0.55)" />
    </g>
    <g v-else-if="outfit === 'sport'">
      <path d="M250 706 Q300 740 350 706" stroke="#fff" stroke-width="7" fill="none" opacity="0.85" />
      <path d="M300 732 L300 1000" stroke="#fff" stroke-width="4" opacity="0.7" />
      <path d="M150 820 L210 760 M450 820 L390 760" stroke="#fff" stroke-width="10" opacity="0.8" stroke-linecap="round" />
    </g>
    <g v-else-if="outfit === 'pajama'">
      <path fill="#fff" opacity="0.85" d="M246 706 L300 766 L270 796 Z M354 706 L300 766 L330 796 Z" />
      <g :fill="mix(outfitColors.main, '#ffffff', 0.55)">
        <circle cx="180" cy="900" r="10" />
        <circle cx="240" cy="960" r="8" />
        <circle cx="420" cy="890" r="9" />
        <circle cx="360" cy="950" r="10" />
        <circle cx="300" cy="860" r="7" />
      </g>
    </g>
    <g v-else-if="outfit === 'date'">
      <path :fill="SKIN" d="M246 706 Q300 800 354 706 Z" />
      <path d="M262 724 Q300 778 338 724" :stroke="outfitColors.trim" stroke-width="3" fill="none" />
      <circle cx="300" cy="776" r="8" :fill="outfitColors.trim" />
    </g>
    <path v-if="outfit === 'apron'" fill="#fffaf5" d="M232 800 L368 800 L384 1000 L216 1000 Z" />

    <!-- 道具：学习时的书、吃饭时的碗、躺着时的被子 -->
    <g v-if="pose === 'study'">
      <rect x="196" y="842" width="208" height="150" rx="10" fill="#f4ecd8" />
      <path d="M300 842 L300 992" stroke="#d9c9a6" stroke-width="5" />
      <path d="M222 880 H282 M222 906 H276 M318 880 H378 M318 906 H370" stroke="#c9b48a" stroke-width="5" stroke-linecap="round" />
    </g>
    <g v-if="pose === 'eat'">
      <path d="M176 914 Q300 1050 424 914 Z" fill="#efe1d2" />
      <ellipse cx="300" cy="914" rx="124" ry="26" fill="#f8efe6" />
      <ellipse cx="300" cy="914" rx="104" ry="18" fill="#f0c48f" />
      <path d="M352 800 L420 900 M372 796 L430 892" stroke="#9a6b4a" stroke-width="7" stroke-linecap="round" />
    </g>
    <path
      v-if="pose === 'lie'"
      :fill="mix(accent, '#ffffff', 0.62)"
      d="M40 1000 L40 820 Q300 744 560 820 L560 1000 Z"
    />
    <path v-if="pose === 'lie'" d="M60 850 Q300 790 540 850" :stroke="mix(accent, '#ffffff', 0.35)" stroke-width="8" fill="none" />

    <!-- 脖子 -->
    <path :fill="SKIN" d="M266 536 L266 660 C266 690 334 690 334 660 L334 536 Z" />
    <ellipse cx="300" cy="548" rx="42" ry="15" :fill="SKIN_SHADE" opacity="0.8" />

    <!-- 耳朵 + 脸 -->
    <ellipse cx="176" cy="410" rx="16" ry="27" :fill="SKIN" />
    <ellipse cx="424" cy="410" rx="16" ry="27" :fill="SKIN" />
    <ellipse cx="300" cy="392" rx="126" ry="146" :fill="SKIN" />

    <!-- 腮红 -->
    <g fill="#ff8fa3" :opacity="blushOpacity">
      <ellipse cx="222" cy="458" rx="25" ry="11" />
      <ellipse cx="378" cy="458" rx="25" ry="11" />
    </g>
    <g v-if="e === 'blush' || e === 'shy'" stroke="#ff7f96" stroke-width="3" stroke-linecap="round" opacity="0.7">
      <path d="M206 452 l8 -8 M220 452 l8 -8 M234 452 l8 -8" />
      <path d="M362 452 l8 -8 M376 452 l8 -8 M390 452 l8 -8" />
    </g>

    <!-- 眉毛 -->
    <g :stroke="hairDark" stroke-width="4.5" stroke-linecap="round" fill="none">
      <path :d="brow(eyes[0] ?? 252, -1)" />
      <path :d="brow(eyes[1] ?? 348, 1)" />
    </g>

    <!-- 眼睛 -->
    <g v-if="closedHappy" :stroke="LINE" stroke-width="5.5" stroke-linecap="round" fill="none">
      <path d="M235 424 Q252 404 269 424" />
      <path d="M331 424 Q348 404 365 424" />
    </g>
    <g v-else-if="e === 'sleep'" :stroke="LINE" stroke-width="4.5" stroke-linecap="round" fill="none">
      <path d="M236 416 Q252 430 268 416" />
      <path d="M332 416 Q348 430 364 416" />
    </g>
    <g v-else-if="e === 'sleepy'">
      <g v-for="(cx, i) in eyes" :key="i">
        <ellipse :cx="cx" cy="424" rx="14" ry="11" :fill="eye" />
        <path :d="`M${cx - 19} 416 Q${cx} 410 ${cx + 19} 416`" :stroke="LINE" stroke-width="5" stroke-linecap="round" fill="none" />
      </g>
    </g>
    <g v-else>
      <g v-for="(cx, i) in eyes" :key="i">
        <ellipse :cx="cx + iris.dx" :cy="418 + iris.dy" :rx="iris.rx" :ry="iris.ry" :fill="eye" />
        <ellipse :cx="cx + iris.dx" :cy="421 + iris.dy" :rx="iris.rx * 0.5" :ry="iris.ry * 0.55" :fill="mix(eye, '#000', 0.45)" />
        <circle :cx="cx + iris.dx + 5" :cy="410 + iris.dy" r="5" fill="#fff" />
        <circle :cx="cx + iris.dx - 5" :cy="426 + iris.dy" r="2.5" fill="#fff" opacity="0.8" />
        <path :d="lash(cx, i === 0 ? -1 : 1)" :stroke="LINE" stroke-width="5" stroke-linecap="round" fill="none" />
      </g>
    </g>

    <!-- 嘴 -->
    <ellipse v-if="mouth.ellipse" cx="300" cy="492" :rx="mouth.ellipse.rx" :ry="mouth.ellipse.ry" :fill="MOUTH" />
    <path
      v-else
      :d="mouth.d"
      :fill="mouth.fill ? MOUTH : 'none'"
      :stroke="mouth.fill ? 'none' : MOUTH"
      stroke-width="4.5"
      stroke-linecap="round"
    />
    <path v-if="mouth.tongue" d="M291 499 Q300 492 309 499 Q300 507 291 499 Z" fill="#f2909f" />

    <!-- 刘海 -->
    <path
      v-if="isLong"
      :fill="hair"
      d="M174 372 C168 252 232 196 300 196 C370 196 434 252 428 372 C416 334 396 310 374 298 C368 330 348 350 326 354 C334 330 332 308 324 294 C298 320 262 338 228 340 C242 324 250 306 252 290 C218 310 192 338 174 372 Z"
    />
    <path
      v-else
      :fill="hair"
      d="M170 384 C162 250 232 190 300 190 C372 190 440 250 432 374 C420 330 400 300 368 284 C360 318 330 336 300 338 C312 318 314 298 310 284 C276 316 236 332 196 334 C210 320 218 304 220 290 C196 312 180 344 170 384 Z"
    />
    <template v-if="isLong">
      <path :fill="hair" d="M176 360 C162 450 168 560 198 640 C196 560 200 470 216 392 Z" />
      <path :fill="hair" d="M424 360 C438 450 432 560 402 640 C404 560 400 470 384 392 Z" />
    </template>
    <path d="M232 236 Q300 210 368 236" :stroke="hairHi" stroke-width="7" stroke-linecap="round" fill="none" opacity="0.55" />

    <!-- 发夹 -->
    <g v-if="isLong" :transform="'translate(386 290)'">
      <path :fill="accent" d="M0 -18 L5 -5 L19 -5 L8 3 L12 17 L0 9 L-12 17 L-8 3 L-19 -5 L-5 -5 Z" />
    </g>

    <!-- 情绪符号 -->
    <g v-if="e === 'angry'" stroke="#e5485f" stroke-width="6" stroke-linecap="round" fill="none" transform="translate(432 250)">
      <path d="M-14 -4 Q-4 -4 -4 -14 M4 -14 Q4 -4 14 -4 M14 4 Q4 4 4 14 M-4 14 Q-4 4 -14 4" />
    </g>
    <path v-if="e === 'shy' || e === 'surprised'" d="M418 318 q10 16 0 24 q-10 -8 0 -24 Z" fill="#a8d8ff" />
    <g v-if="e === 'sleep' || e === 'sleepy'" :fill="hairHi" font-family="var(--font-num)" font-weight="700">
      <text x="430" y="260" font-size="44">Z</text>
      <text x="470" y="220" font-size="30">z</text>
    </g>
  </svg>
</template>

<style scoped>
.figure {
  display: block;
  width: 100%;
  height: 100%;
}
</style>
