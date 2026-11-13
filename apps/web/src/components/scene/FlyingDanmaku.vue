<script setup lang="ts">
import type { Character } from '@app/shared';
import { onBeforeUnmount, onMounted, ref } from 'vue';
import Avatar from '@/components/common/Avatar.vue';

/**
 * 飘过的弹幕（一起观影的放映厅里用）：从右边进、匀速飘到左边出去。
 * - 一行一行地排（行高 34px，从 top 开始，占画面上面大约六成，不挡下面播放器的进度条）；
 * - 所有弹幕同样的速度（每秒走画面宽度的七分之一），后面的追不上前面的；
 *   新的一条放进最早空出来的那一行（上一条整个进了画面、还隔开一点），都没空出来就放最快空出来的那行；
 * - 她的带头像、底色是她的颜色；你的带一个框（像 B 站里自己发的弹幕）；
 * - 系统设置了"减少动态效果"时不飘，在原地淡入淡出。
 * 用 push(who, text) 发一条。
 */
const props = withDefaults(defineProps<{ character: Character; top?: number }>(), { top: 10 });

const LANE = 34;
const GAP = 28;
const FONT = 17;

interface Fly {
  id: number;
  who: 'her' | 'you';
  text: string;
  lane: number;
  dur: number;
}

const root = ref<HTMLElement | null>(null);
const width = ref(0);
const height = ref(0);
const flies = ref<Fly[]>([]);
let seq = 0;
let laneFree: number[] = [];
const timers = new Set<ReturnType<typeof setTimeout>>();

let ro: ResizeObserver | null = null;
function measureBox() {
  const el = root.value;
  if (!el) return;
  width.value = el.clientWidth;
  height.value = el.clientHeight;
}
onMounted(() => {
  measureBox();
  if (typeof ResizeObserver !== 'undefined' && root.value) {
    ro = new ResizeObserver(measureBox);
    ro.observe(root.value);
  }
});
onBeforeUnmount(() => {
  ro?.disconnect();
  for (const t of timers) clearTimeout(t);
  timers.clear();
});

let ctx: CanvasRenderingContext2D | null = null;
/** 这一条大概多宽（px）：用和弹幕一样的字体量 */
function textWidth(text: string): number {
  try {
    ctx ??= document.createElement('canvas').getContext('2d');
    if (ctx && root.value) {
      ctx.font = `600 ${FONT}px ${getComputedStyle(root.value).fontFamily}`;
      return ctx.measureText(text).width;
    }
  } catch {
    // 量不了就估
  }
  return [...text].reduce((w, ch) => w + (/[\u0000-ÿ]/.test(ch) ? FONT * 0.56 : FONT), 0);
}

function push(who: Fly['who'], text: string) {
  const t = text.trim();
  if (!t) return;
  const W = width.value || window.innerWidth;
  const H = height.value || window.innerHeight;
  const w = textWidth(t) + (who === 'her' ? 24 + 6 + 12 : 18);
  const speed = Math.max(90, W / 7);
  const lanes = Math.max(1, Math.floor((H * 0.62 - props.top) / LANE));
  if (laneFree.length !== lanes) laneFree = Array.from({ length: lanes }, (_, i) => laneFree[i] ?? 0);
  const now = performance.now();
  let lane = laneFree.findIndex((at) => at <= now);
  if (lane < 0) lane = laneFree.indexOf(Math.min(...laneFree));
  laneFree[lane] = now + ((w + GAP) / speed) * 1000;
  const dur = (W + w) / speed;
  const id = (seq += 1);
  flies.value = [...flies.value, { id, who, text: t, lane, dur }];
  const timer = setTimeout(() => {
    timers.delete(timer);
    flies.value = flies.value.filter((f) => f.id !== id);
  }, dur * 1000 + 300);
  timers.add(timer);
}

defineExpose({ push });
</script>

<template>
  <div ref="root" class="fly-layer" :style="{ '--dm-w': `${width}px` }" aria-live="polite" data-testid="flying-danmaku">
    <div v-for="f in flies" :key="f.id" class="fly" :class="f.who" :style="{ top: `${top + f.lane * LANE}px`, animationDuration: `${f.dur}s` }">
      <Avatar v-if="f.who === 'her'" :character="character" :size="24" />
      <span>{{ f.text }}</span>
    </div>
  </div>
</template>

<style scoped>
.fly-layer {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
}
.fly {
  position: absolute;
  left: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  white-space: nowrap;
  font-size: 17px;
  font-weight: 600;
  line-height: 1;
  color: #fff;
  text-shadow:
    0 0 2px rgba(0, 0, 0, 0.9),
    0 1px 3px rgba(0, 0, 0, 0.7);
  animation-name: dm-fly;
  animation-timing-function: linear;
  animation-fill-mode: forwards;
  will-change: transform;
}
.fly.her {
  padding: 0 12px 0 3px;
  border-radius: 99px;
  background: rgba(0, 0, 0, 0.32);
  box-shadow: inset 0 0 0 1.5px var(--accent);
}
@supports (background: color-mix(in srgb, red 10%, transparent)) {
  .fly.her {
    background: color-mix(in srgb, var(--accent) 34%, rgba(0, 0, 0, 0.38));
  }
}
.fly.you {
  padding: 0 8px;
  border: 1.5px solid rgba(255, 255, 255, 0.85);
  border-radius: 6px;
}
@keyframes dm-fly {
  from {
    transform: translateX(var(--dm-w));
  }
  to {
    transform: translateX(-100%);
  }
}
@media (prefers-reduced-motion: reduce) {
  .fly {
    left: 12px;
    animation-name: dm-fade;
    will-change: opacity;
  }
  @keyframes dm-fade {
    0%,
    100% {
      opacity: 0;
    }
    8%,
    85% {
      opacity: 1;
    }
  }
}
</style>
