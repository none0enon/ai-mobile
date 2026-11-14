<script setup lang="ts">
import type { Character } from '@app/shared';
import { computed } from 'vue';
import PortraitFigure from './PortraitFigure.vue';
import SceneBackdrop from './SceneBackdrop.vue';
import { portraitAspect } from '@/services/portraits';

/** 占位"CG"：场景背景 + 她的立绘（没有立绘时是占位立绘）。真实版本是 NovelAI 生成的图片 */
const props = withDefaults(
  defineProps<{ character: Character; scene?: string; expression?: string; outfit?: string; ratio?: string; pending?: boolean }>(),
  { scene: 'library', expression: 'smile', outfit: 'daily', ratio: '3 / 4', pending: false },
);
const aspect = computed(() => String(portraitAspect(props.character)));
const tod = computed(() => (['aquarium', 'cinema', 'night-market', 'amusement', 'bedroom'].includes(props.scene) ? 'night' : 'afternoon'));
</script>

<template>
  <div class="cg" :style="{ aspectRatio: ratio }">
    <SceneBackdrop :kind="scene" :tod="tod" />
    <div class="cg-figure" :style="{ aspectRatio: aspect }">
      <PortraitFigure :character="character" :expression="expression" :outfit="outfit" :seed="0" />
    </div>
    <div v-if="pending" class="cg-pending">
      <span class="i-lucide-wand-sparkles text-[20px]" />
      <span>正在画…</span>
    </div>
  </div>
</template>

<style scoped>
.cg {
  position: relative;
  width: 100%;
  overflow: hidden;
  border-radius: inherit;
  background: var(--panel);
}
.cg-figure {
  position: absolute;
  left: 50%;
  bottom: -8%;
  height: 92%;
  max-width: 96%;
  transform: translateX(-50%);
}
.cg-pending {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: #fff;
  font-size: 13px;
  background: linear-gradient(110deg, rgba(10, 6, 20, 0.7) 30%, rgba(60, 40, 90, 0.55) 50%, rgba(10, 6, 20, 0.7) 70%);
  background-size: 220% 100%;
  animation: shimmer 1.4s linear infinite;
}
@keyframes shimmer {
  from {
    background-position: 120% 0;
  }
  to {
    background-position: -120% 0;
  }
}
</style>
