<script setup lang="ts">
import { errorText } from '@app/ai';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { pdfOf } from '@/services/books';

/**
 * PDF 的一页，原样显示（一起看书的原版页面；扫描页、公式页还没转成文字时也先这样显示）。
 * 按容器宽度 × 缩放画在 canvas 上，清晰度跟屏幕走（devicePixelRatio，最多 2.5 倍）。
 * 先画在离屏 canvas 上再贴过来：换页时不闪白，正在画的那次可以直接取消（pdf.js 不许同一个 canvas 同时画两次）
 */
const props = withDefaults(defineProps<{ bookId: string; page: number; zoom?: number }>(), { zoom: 1 });
const emit = defineEmits<{ (e: 'pages', n: number): void }>();

const box = ref<HTMLDivElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);
/** 高 / 宽：画出来之前按 Letter 纸占位 */
const ratio = ref(792 / 612);
const state = ref<'loading' | 'ok' | 'error'>('loading');
const error = ref('');
let task: { cancel(): void } | null = null;
let seq = 0;
let drawnWidth = 0;

async function draw() {
  const el = box.value;
  const cv = canvas.value;
  if (!el || !cv) return;
  const width = Math.round(el.clientWidth * props.zoom);
  if (!width) return;
  const my = ++seq;
  task?.cancel();
  if (!drawnWidth) state.value = 'loading';
  try {
    const pdf = await pdfOf(props.bookId);
    if (my !== seq) return;
    emit('pages', pdf.numPages);
    const page = await pdf.getPage(Math.min(Math.max(1, props.page), pdf.numPages));
    if (my !== seq) return;
    const base = page.getViewport({ scale: 1 });
    ratio.value = base.height / base.width;
    let scale = (width / base.width) * Math.min(window.devicePixelRatio || 1, 2.5);
    // 手机上太大的 canvas 画不出来：最多 600 万像素
    const maxPixels = 6e6;
    if (base.width * base.height * scale * scale > maxPixels) scale = Math.sqrt(maxPixels / (base.width * base.height));
    const vp = page.getViewport({ scale });
    const off = document.createElement('canvas');
    off.width = Math.round(vp.width);
    off.height = Math.round(vp.height);
    const render = page.render({ canvasContext: off.getContext('2d')!, viewport: vp });
    task = render;
    await render.promise;
    if (my !== seq) return;
    cv.width = off.width;
    cv.height = off.height;
    cv.getContext('2d')!.drawImage(off, 0, 0);
    off.width = 0;
    off.height = 0;
    drawnWidth = width;
    state.value = 'ok';
  } catch (e) {
    if (my !== seq || (e as { name?: string } | null)?.name === 'RenderingCancelledException') return;
    error.value = errorText(e);
    state.value = 'error';
  }
}

let resizeTimer = 0;
const observer = new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    const w = Math.round((box.value?.clientWidth ?? 0) * props.zoom);
    if (w && Math.abs(w - drawnWidth) > 8) void draw();
  }, 150);
});

onMounted(() => {
  if (box.value) observer.observe(box.value);
  void draw();
});
watch(
  () => [props.bookId, props.page, props.zoom],
  () => {
    drawnWidth = 0;
    void draw();
  },
);
onBeforeUnmount(() => {
  seq += 1;
  task?.cancel();
  observer.disconnect();
  clearTimeout(resizeTimer);
});
</script>

<template>
  <div ref="box" class="pdf-page">
    <div class="pdf-sheet" :style="{ width: `${zoom * 100}%`, aspectRatio: `1 / ${ratio}` }">
      <canvas ref="canvas" class="pdf-canvas" :class="{ ready: state === 'ok' }" :aria-label="`第 ${page} 页原样`" role="img" />
      <div v-if="state === 'loading'" class="pdf-ph"><van-loading size="18px" /></div>
      <div v-else-if="state === 'error'" class="pdf-ph pdf-err">第 {{ page }} 页画不出来：{{ error }}</div>
    </div>
  </div>
</template>

<style scoped>
.pdf-page {
  width: 100%;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}
.pdf-sheet {
  position: relative;
  background: #fff;
  border-radius: 4px;
  box-shadow: 0 1px 6px rgba(0, 0, 0, 0.18);
  overflow: hidden;
}
.pdf-canvas {
  display: block;
  width: 100%;
  height: 100%;
  opacity: 0;
  transition: opacity 0.2s;
}
.pdf-canvas.ready {
  opacity: 1;
}
.pdf-ph {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  color: #777;
  font-size: 13px;
  text-align: center;
}
.pdf-ph.pdf-err {
  color: #b5482f;
}
</style>
