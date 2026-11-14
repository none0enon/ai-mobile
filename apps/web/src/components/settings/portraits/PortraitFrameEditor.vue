<script setup lang="ts">
import { availableExpressions, pickPortrait, type Character, type HotspotShape, type PokeHotspot } from '@app/shared';
import { computed, ref } from 'vue';
import Segmented from '@/components/common/Segmented.vue';
import PortraitFigure from '@/components/figure/PortraitFigure.vue';
import { hotspotsOf } from '@/services/portraits';

/**
 * 在立绘上拖：头像框（头像、表情缩略图按它裁）和戳戳乐热区（拖框移动，拖右下角改大小）。
 * 坐标都存成相对立绘框的比例，换图、换分辨率不用重画。没动过热区时按头像框自动摆。
 */
const props = defineProps<{ character: Character }>();
const set = computed(() => props.character.portraits!);
const mode = ref<'face' | 'hotspots'>('face');
const box = ref<HTMLElement | null>(null);
/** 用来对位的那张：默认的样子 */
const base = computed(() => pickPortrait(set.value, { seed: 0 }));
const faces = computed(() => availableExpressions(set.value).slice(0, 5));

function touch() {
  props.character.updatedAt = Date.now();
}
const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

/** 按住拖：回调拿到相对立绘框的位移（占宽、占高） */
function drag(e: PointerEvent, onMove: (dx: number, dy: number) => void) {
  const r = box.value?.getBoundingClientRect();
  if (!r) return;
  e.preventDefault();
  e.stopPropagation();
  const sx = e.clientX;
  const sy = e.clientY;
  const move = (ev: PointerEvent) => onMove((ev.clientX - sx) / r.width, (ev.clientY - sy) / r.height);
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    touch();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

// —— 头像框 ——
const faceStyle = computed(() => {
  const { x, y, size } = set.value.face;
  const h = size * set.value.aspect;
  return { left: `${(x - size / 2) * 100}%`, top: `${(y - h / 2) * 100}%`, width: `${size * 100}%`, height: `${h * 100}%` };
});
function moveFace(e: PointerEvent) {
  const { x, y } = set.value.face;
  drag(e, (dx, dy) => Object.assign(set.value.face, { x: clamp(x + dx), y: clamp(y + dy) }));
}
function resizeFace(e: PointerEvent) {
  const { size } = set.value.face;
  drag(e, (dx, dy) => (set.value.face.size = clamp(size + dx + dy * set.value.aspect, 0.06, 1)));
}
const faceSize = computed({
  get: () => Math.round(set.value.face.size * 100),
  set: (v: number) => {
    set.value.face.size = v / 100;
    touch();
  },
});

// —— 热区 ——
const hotspots = computed(() => hotspotsOf(props.character));
const custom = computed(() => !!set.value.hotspots?.length);
/** 第一次拖时把自动摆的那套存下来，之后改的是自己的 */
function own(h: PokeHotspot): PokeHotspot | undefined {
  if (!set.value.hotspots?.length) set.value.hotspots = JSON.parse(JSON.stringify(hotspots.value)) as PokeHotspot[];
  return set.value.hotspots.find((x) => x.id === h.id);
}
function rectOf(s: HotspotShape) {
  if (s.kind === 'rect') return s;
  const xs = s.points.map((p) => p[0]);
  const ys = s.points.map((p) => p[1]);
  return { kind: 'rect' as const, x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}
function spotStyle(h: PokeHotspot) {
  const r = rectOf(h.shape);
  return { left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` };
}
function moveSpot(e: PointerEvent, h: PokeHotspot) {
  const t = own(h);
  if (!t) return;
  const r = rectOf(t.shape);
  drag(e, (dx, dy) => (t.shape = { ...r, x: clamp(r.x + dx, 0, 1 - r.w), y: clamp(r.y + dy, 0, 1 - r.h) }));
}
function resizeSpot(e: PointerEvent, h: PokeHotspot) {
  const t = own(h);
  if (!t) return;
  const r = rectOf(t.shape);
  drag(e, (dx, dy) => (t.shape = { ...r, w: clamp(r.w + dx, 0.04, 1 - r.x), h: clamp(r.h + dy, 0.03, 1 - r.y) }));
}
function resetSpots() {
  delete set.value.hotspots;
  touch();
}
</script>

<template>
  <div class="frame-editor">
    <Segmented
      v-model="mode"
      :options="[
        { value: 'face', label: '头像框' },
        { value: 'hotspots', label: '戳戳乐热区' },
      ]"
    />
    <div class="fe-stage">
      <div ref="box" class="fe-box" :style="{ aspectRatio: String(set.aspect) }">
        <PortraitFigure :character="character" :portrait-id="base?.id" />
        <template v-if="mode === 'face'">
          <div class="fe-face" :style="faceStyle" role="slider" aria-label="头像框：拖动移动，拖右下角改大小" @pointerdown="moveFace">
            <span class="fe-handle" @pointerdown="resizeFace" />
          </div>
        </template>
        <template v-else>
          <div v-for="h in hotspots" :key="h.id" class="fe-spot" :style="spotStyle(h)" role="slider" :aria-label="`热区：${h.label}`" @pointerdown="moveSpot($event, h)">
            <span class="fe-spot-label">{{ h.label }}</span>
            <span class="fe-handle" @pointerdown="resizeSpot($event, h)" />
          </div>
        </template>
      </div>
    </div>
    <template v-if="mode === 'face'">
      <div class="fe-row">
        <span class="text-[12.5px] text-ink-2 shrink-0">大小</span>
        <van-slider v-model="faceSize" :min="6" :max="100" bar-height="4px" button-size="16px" />
      </div>
      <div class="fe-row">
        <span class="text-[12.5px] text-ink-2 shrink-0">头像预览</span>
        <span v-for="f in faces" :key="f.id" class="fe-ava" :title="f.label"><PortraitFigure :character="character" :expression="f.id" crop="head" :seed="0" /></span>
      </div>
      <p class="text-[12px] text-ink-3 m-0">把方框拖到脸上：聊天列表、地图、通话里的头像都按它裁，跟着表情换。在"外观"里上传过头像的，头像还是用上传的那张。</p>
    </template>
    <template v-else>
      <div class="fe-row">
        <span class="text-[12px] text-ink-3 flex-1">{{ custom ? '用的是你拖过的热区。' : '还没拖过：按头像框自动摆的。' }}拖框移动，拖右下角改大小。</span>
        <button v-if="custom" type="button" class="text-[12.5px] text-accent-ink shrink-0" @click="resetSpots">按头像框重摆</button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.frame-editor {
  display: grid;
  gap: 10px;
}
.fe-stage {
  display: flex;
  justify-content: center;
  height: 340px;
  border-radius: 18px;
  overflow: hidden;
  background:
    repeating-conic-gradient(var(--panel) 0 25%, transparent 0 50%) 0 0 / 16px 16px,
    var(--surface);
}
.fe-box {
  position: relative;
  height: 100%;
  max-width: 100%;
}
.fe-face,
.fe-spot {
  position: absolute;
  touch-action: none;
  cursor: move;
}
.fe-face {
  border: 2px solid var(--accent);
  border-radius: 50%;
  box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.32);
}
.fe-spot {
  border: 2px dashed var(--accent);
  border-radius: 10px;
  background: var(--accent-soft);
}
.fe-spot-label {
  position: absolute;
  top: -20px;
  left: 50%;
  transform: translateX(-50%);
  font-size: 11px;
  padding: 0 6px;
  border-radius: 8px;
  background: var(--accent);
  color: var(--on-accent);
  white-space: nowrap;
  pointer-events: none;
}
.fe-handle {
  position: absolute;
  right: -9px;
  bottom: -9px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--accent);
  border: 2px solid var(--surface);
  touch-action: none;
  cursor: nwse-resize;
}
.fe-face .fe-handle {
  right: 8%;
  bottom: 8%;
}
.fe-row {
  display: flex;
  align-items: center;
  gap: 12px;
}
.fe-row :deep(.van-slider) {
  flex: 1;
}
.fe-ava {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  overflow: hidden;
  background: linear-gradient(160deg, var(--accent-soft), var(--panel));
  flex-shrink: 0;
}
</style>
