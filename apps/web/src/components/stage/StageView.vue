<script setup lang="ts">
import type { Character, PokeHotspot, TimeOfDay } from '@app/shared';
import { computed, ref } from 'vue';
import CharacterFigure from '@/components/figure/CharacterFigure.vue';
import SceneBackdrop from '@/components/figure/SceneBackdrop.vue';
import { FIGURE } from '@/mock/characters';
import { pokeHotspots } from '@/mock/library';

/**
 * 舞台：背景 + 立绘（表情交叉淡化）+ 戳戳乐热区 + 覆盖层插槽（对话框、顶部按钮）。
 * 热区坐标相对立绘框（0-1），立绘框按 600:1000 的比例摆放，换了真立绘也一样。
 */
const props = withDefaults(
  defineProps<{
    character: Character;
    expression: string;
    outfit?: string;
    pose?: string;
    backdrop?: string;
    tod?: TimeOfDay;
    rain?: boolean;
    dim?: number;
    pokeable?: boolean;
    showHotspots?: boolean;
    /** 立绘框位置：水平中心 %、距底部 %、高度 % */
    layout?: { left: number; bottom: number; height: number };
  }>(),
  {
    outfit: 'daily',
    pose: 'stand',
    backdrop: 'bedroom',
    rain: false,
    dim: 0,
    pokeable: false,
    showHotspots: false,
    layout: () => ({ left: 50, bottom: 14, height: 76 }),
  },
);
const emit = defineEmits<{ (e: 'poke', hotspot: PokeHotspot, kind: 'tap' | 'long'): void }>();

const root = ref<HTMLElement | null>(null);
const figure = computed(() => FIGURE[props.character.id] ?? { hairStyle: 'long' as const, eye: '#3b2531' });
const boxStyle = computed(() => ({
  left: `${props.layout.left}%`,
  bottom: `${props.layout.bottom}%`,
  height: `${props.layout.height}%`,
}));

function shapeStyle(h: PokeHotspot) {
  if (h.shape.kind === 'rect') {
    return { left: `${h.shape.x * 100}%`, top: `${h.shape.y * 100}%`, width: `${h.shape.w * 100}%`, height: `${h.shape.h * 100}%` };
  }
  const xs = h.shape.points.map((p) => p[0]);
  const ys = h.shape.points.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    left: `${x * 100}%`,
    top: `${y * 100}%`,
    width: `${(Math.max(...xs) - x) * 100}%`,
    height: `${(Math.max(...ys) - y) * 100}%`,
    clipPath: `polygon(${h.shape.points.map((p) => `${((p[0] - x) / (Math.max(...xs) - x)) * 100}% ${((p[1] - y) / (Math.max(...ys) - y)) * 100}%`).join(',')})`,
  };
}

const effects = ref<{ id: number; x: number; y: number; kind: 'tap' | 'long' }[]>([]);
let pressTimer: ReturnType<typeof setTimeout> | undefined;
let pressed: { h: PokeHotspot; x: number; y: number; long: boolean } | null = null;

function local(e: PointerEvent) {
  const r = root.value?.getBoundingClientRect();
  return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
}

function spawn(x: number, y: number, kind: 'tap' | 'long') {
  const id = Date.now() + Math.random();
  effects.value.push({ id, x, y, kind });
  setTimeout(() => (effects.value = effects.value.filter((f) => f.id !== id)), 1100);
}

function down(h: PokeHotspot, e: PointerEvent) {
  const { x, y } = local(e);
  pressed = { h, x, y, long: false };
  clearTimeout(pressTimer);
  pressTimer = setTimeout(() => {
    if (!pressed) return;
    pressed.long = true;
    spawn(pressed.x, pressed.y, 'long');
    emit('poke', pressed.h, 'long');
  }, 480);
}

function up() {
  clearTimeout(pressTimer);
  if (pressed && !pressed.long) {
    spawn(pressed.x, pressed.y, 'tap');
    emit('poke', pressed.h, 'tap');
  }
  pressed = null;
}

function cancel() {
  clearTimeout(pressTimer);
  pressed = null;
}
</script>

<template>
  <div ref="root" class="stage">
    <SceneBackdrop :kind="backdrop" :tod="tod" :rain="rain" :dim="dim" />
    <div class="figure-box" :style="boxStyle">
      <div class="breathe">
        <Transition name="xfade">
          <div :key="`${expression}-${outfit}-${pose}`" class="figure-layer">
            <CharacterFigure
              :accent="character.accent"
              :hair="character.hairColor"
              :eye="figure.eye"
              :hair-style="figure.hairStyle"
              :expression="expression"
              :outfit="outfit"
              :pose="pose"
              :title="`${character.name}的立绘（占位）`"
            />
          </div>
        </Transition>
      </div>
      <template v-if="pokeable">
        <button
          v-for="h in pokeHotspots"
          :key="h.id"
          class="hotspot"
          :class="{ visible: showHotspots }"
          :style="shapeStyle(h)"
          :aria-label="`戳${h.label}`"
          :data-zone="h.id"
          @pointerdown="down(h, $event)"
          @pointerup="up"
          @pointerleave="cancel"
          @pointercancel="cancel"
          @contextmenu.prevent
        >
          <span v-if="showHotspots" class="hotspot-label">{{ h.label }}</span>
        </button>
      </template>
    </div>
    <template v-for="f in effects" :key="f.id">
      <span class="ripple" :style="{ left: `${f.x}px`, top: `${f.y}px` }" />
      <span class="heart" :class="f.kind === 'long' ? 'i-lucide-hand-heart' : 'i-lucide-heart'" :style="{ left: `${f.x}px`, top: `${f.y}px` }" />
    </template>
    <slot />
  </div>
</template>

<style scoped>
.stage {
  position: absolute;
  inset: 0;
  overflow: hidden;
  user-select: none;
  -webkit-user-select: none;
}
.figure-box {
  position: absolute;
  aspect-ratio: 600 / 1000;
  transform: translateX(-50%);
  max-width: 96%;
}
.breathe {
  position: absolute;
  inset: 0;
  animation: breathe 5s ease-in-out infinite;
  transform-origin: 50% 100%;
  filter: drop-shadow(0 18px 30px rgba(0, 0, 0, 0.35));
}
.figure-layer {
  position: absolute;
  inset: 0;
}
.xfade-enter-active,
.xfade-leave-active {
  transition: opacity 0.26s ease;
}
.xfade-enter-from,
.xfade-leave-to {
  opacity: 0;
}
.hotspot {
  position: absolute;
  border-radius: 40%;
  touch-action: manipulation;
  -webkit-touch-callout: none;
}
.hotspot.visible {
  outline: 2px dashed var(--accent);
  outline-offset: -2px;
  background: var(--accent-soft);
}
.hotspot-label {
  position: absolute;
  top: -22px;
  left: 50%;
  transform: translateX(-50%);
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 8px;
  background: var(--accent);
  color: var(--on-accent);
  white-space: nowrap;
}
.ripple {
  position: absolute;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  border: 2px solid var(--accent);
  pointer-events: none;
  animation: ripple 0.6s ease-out forwards;
}
.heart {
  position: absolute;
  color: var(--accent);
  font-size: 22px;
  pointer-events: none;
  animation: float-up 1.1s ease-out forwards;
}
</style>
