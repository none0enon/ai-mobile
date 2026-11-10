<script setup lang="ts">
import { computed } from 'vue';
import { clock } from '@/utils/time';

/** 番茄钟圆环 */
const props = withDefaults(defineProps<{ remainSec: number; totalSec: number; label?: string; size?: number; tone?: string }>(), {
  label: '',
  size: 200,
  tone: 'var(--accent)',
});
const R = 88;
const C = 2 * Math.PI * R;
const offset = computed(() => C * (1 - Math.max(0, Math.min(1, props.remainSec / props.totalSec))));
</script>

<template>
  <div class="timer-ring" :style="{ width: `${size}px`, height: `${size}px` }">
    <svg viewBox="0 0 200 200" class="absolute inset-0">
      <circle cx="100" cy="100" :r="R" fill="none" stroke="var(--panel-2)" stroke-width="10" />
      <circle
        cx="100"
        cy="100"
        :r="R"
        fill="none"
        :stroke="tone"
        stroke-width="10"
        stroke-linecap="round"
        :stroke-dasharray="C"
        :stroke-dashoffset="offset"
        transform="rotate(-90 100 100)"
        style="transition: stroke-dashoffset 0.9s linear"
      />
    </svg>
    <div class="relative flex flex-col items-center">
      <span class="num text-[44px] font-700 leading-none tracking-tight">{{ clock(remainSec) }}</span>
      <span v-if="label" class="text-[13px] text-ink-2 mt-1.5">{{ label }}</span>
      <slot />
    </div>
  </div>
</template>

<style scoped>
.timer-ring {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0 auto;
}
</style>
