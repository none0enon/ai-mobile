<script lang="ts">
/** 正在滚页面（滚轮从这一排外面开始）：指针划过这一排时别把滚动截走。所有横向栏共用 */
let lastPageWheel = 0;
let tracking = false;
function trackPageWheel() {
  if (tracking || typeof window === 'undefined') return;
  tracking = true;
  window.addEventListener(
    'wheel',
    (e) => {
      if (!(e.target instanceof Element && e.target.closest('.hs-track'))) lastPageWheel = Date.now();
    },
    { passive: true, capture: true },
  );
}
</script>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

/**
 * 横着放不下时左右滑的一排（分类、人物、配色、筛选……），手机和电脑都能用：
 * - 手机：手指横划；
 * - 电脑：鼠标滚轮上下滚就是左右走（滚到头再交给页面），触控板横划，按住鼠标左右拖；
 * - 两头还有没露出来的内容时，那一头淡出并显示箭头，点一下滚过去大半屏；
 * - active 变了（选中了别的），把选中的那个（aria-selected / aria-pressed / aria-current）滚到看得见的地方。
 * 外面这层只负责摆箭头；传进来的 class、role、aria-* 都落在里面真正滚动的那一层。
 */
defineOptions({ inheritAttrs: false });
const props = defineProps<{ active?: string | number | boolean | null }>();

const track = ref<HTMLElement | null>(null);
const canLeft = ref(false);
const canRight = ref(false);
const dragging = ref(false);

function update() {
  const t = track.value;
  if (!t) return;
  const max = t.scrollWidth - t.clientWidth;
  canLeft.value = max > 1 && t.scrollLeft > 1;
  canRight.value = max > 1 && t.scrollLeft < max - 1;
}

/** 点箭头：往那边滚大半屏 */
function page(dir: -1 | 1) {
  const t = track.value;
  if (t) t.scrollBy({ left: dir * Math.max(96, t.clientWidth * 0.7), behavior: 'smooth' });
}

/** 选中的那个滚到看得见的地方（两边让出箭头的位置） */
function reveal(smooth: boolean) {
  const t = track.value;
  const on = t?.querySelector<HTMLElement>('[aria-selected="true"], [aria-pressed="true"], [aria-current="true"], [aria-current="page"]');
  if (!t || !on) return;
  const box = t.getBoundingClientRect();
  const item = on.getBoundingClientRect();
  const room = 44;
  let d = 0;
  if (item.left < box.left + room) d = item.left - box.left - room;
  else if (item.right > box.right - room) d = item.right - box.right + room;
  if (d) t.scrollBy({ left: d, behavior: smooth ? 'smooth' : 'auto' });
}
watch(
  () => props.active,
  () => void nextTick(() => reveal(true)),
);

// —— 鼠标滚轮：上下滚 → 左右走 ——
function onWheel(e: WheelEvent) {
  const t = track.value;
  if (!t || e.ctrlKey) return;
  const max = t.scrollWidth - t.clientWidth;
  if (max <= 1) return;
  // 横向滚轮、触控板横划：浏览器自己会横着滚
  if (Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
  // 这一下是在接着滚页面：让它继续滚页面
  const now = Date.now();
  if (now - lastPageWheel < 300) {
    lastPageWheel = now;
    return;
  }
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? t.clientWidth : 1;
  const next = Math.min(max, Math.max(0, t.scrollLeft + e.deltaY * unit));
  // 已经滚到头：交给页面上下滚
  if (Math.abs(next - t.scrollLeft) < 0.5) return;
  e.preventDefault();
  t.scrollLeft = next;
}

// —— 按住鼠标左右拖 ——
let drag: { id: number; x: number; left: number } | null = null;
let swallowClick = false;
function onPointerDown(e: PointerEvent) {
  const t = track.value;
  if (!t || e.pointerType !== 'mouse' || e.button !== 0 || t.scrollWidth - t.clientWidth <= 1) return;
  drag = { id: e.pointerId, x: e.clientX, left: t.scrollLeft };
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
}
function onPointerMove(e: PointerEvent) {
  const t = track.value;
  if (!t || !drag || e.pointerId !== drag.id) return;
  const dx = e.clientX - drag.x;
  if (!dragging.value) {
    if (Math.abs(dx) < 5) return;
    dragging.value = true;
  }
  t.scrollLeft = drag.left - dx;
}
function onPointerUp(e: PointerEvent) {
  if (!drag || e.pointerId !== drag.id) return;
  drag = null;
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);
  window.removeEventListener('pointercancel', onPointerUp);
  if (!dragging.value) return;
  dragging.value = false;
  // 拖完松手时手底下的按钮不算被点了
  swallowClick = true;
  setTimeout(() => (swallowClick = false), 0);
}
function onClickCapture(e: MouseEvent) {
  if (!swallowClick) return;
  swallowClick = false;
  e.preventDefault();
  e.stopPropagation();
}

// 内容、宽度变了（换了选项、窗口缩放、头像加载出来）都重新看两头还有没有东西
let resize: ResizeObserver | null = null;
let mutate: MutationObserver | null = null;
function observeChildren() {
  const t = track.value;
  if (!t || !resize) return;
  resize.disconnect();
  resize.observe(t);
  for (const c of Array.from(t.children)) resize.observe(c);
}
onMounted(() => {
  trackPageWheel();
  const t = track.value;
  if (!t) return;
  t.addEventListener('wheel', onWheel, { passive: false });
  if (typeof ResizeObserver !== 'undefined') resize = new ResizeObserver(() => update());
  if (typeof MutationObserver !== 'undefined') {
    mutate = new MutationObserver(() => {
      observeChildren();
      update();
    });
    mutate.observe(t, { childList: true });
  }
  observeChildren();
  update();
  reveal(false);
});
onBeforeUnmount(() => {
  track.value?.removeEventListener('wheel', onWheel);
  resize?.disconnect();
  mutate?.disconnect();
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);
  window.removeEventListener('pointercancel', onPointerUp);
});
</script>

<template>
  <div class="hs" :class="{ 'fade-l': canLeft, 'fade-r': canRight, dragging }">
    <div ref="track" class="hs-track" v-bind="$attrs" @scroll.passive="update" @pointerdown="onPointerDown" @click.capture="onClickCapture" @dragstart.prevent>
      <slot />
    </div>
    <button v-if="canLeft" type="button" class="hs-arrow left" tabindex="-1" aria-label="往左滚" @click="page(-1)"><span class="i-lucide-chevron-left" /></button>
    <button v-if="canRight" type="button" class="hs-arrow right" tabindex="-1" aria-label="往右滚" @click="page(1)"><span class="i-lucide-chevron-right" /></button>
  </div>
</template>

<style scoped>
.hs {
  position: relative;
  flex-shrink: 0;
  min-width: 0;
}
.hs-track {
  display: flex;
  overflow-x: auto;
  overflow-y: hidden;
  -webkit-overflow-scrolling: touch;
  /* 横划到头不触发浏览器的"返回上一页"手势 */
  overscroll-behavior-x: contain;
  scrollbar-width: none;
  user-select: none;
  -webkit-user-select: none;
}
.hs-track::-webkit-scrollbar {
  display: none;
}
/* 两头淡出：用遮罩，不管这一排放在什么底色上都对 */
.fade-r .hs-track {
  -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 40px), transparent);
  mask-image: linear-gradient(to right, #000 calc(100% - 40px), transparent);
}
.fade-l .hs-track {
  -webkit-mask-image: linear-gradient(to left, #000 calc(100% - 40px), transparent);
  mask-image: linear-gradient(to left, #000 calc(100% - 40px), transparent);
}
.fade-l.fade-r .hs-track {
  -webkit-mask-image: linear-gradient(to right, transparent, #000 40px, #000 calc(100% - 40px), transparent);
  mask-image: linear-gradient(to right, transparent, #000 40px, #000 calc(100% - 40px), transparent);
}
.dragging .hs-track,
.dragging .hs-track * {
  cursor: grabbing !important;
}
.hs-arrow {
  position: absolute;
  top: 50%;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  margin-top: -14px;
  border-radius: 50%;
  background: var(--surface);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-sm);
  color: var(--ink-2);
  font-size: 16px;
}
/* 手指点得到：点击范围比看上去大一圈 */
.hs-arrow::after {
  content: '';
  position: absolute;
  inset: -8px;
}
.hs-arrow.left {
  left: 4px;
}
.hs-arrow.right {
  right: 4px;
}
@media (hover: hover) {
  .hs-arrow:hover {
    color: var(--ink);
    border-color: var(--accent-line);
  }
}
</style>
