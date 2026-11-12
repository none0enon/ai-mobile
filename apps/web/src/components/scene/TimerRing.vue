<script setup lang="ts">
import { computed } from 'vue';
import { clock } from '@/utils/time';

/**
 * 计时圆环：倒计时（番茄钟、倒计时）显示剩下多少、圈慢慢变短；
 * 正计时传 countUp：remainSec 当作已经过去多少，圈每 totalSec 走满一圈（正计时按一小时一圈）。
 * 默认插槽放在时间和标签下面（暂停、结束之类的小按钮）
 */
const props = withDefaults(defineProps<{ remainSec: number; totalSec: number; label?: string; size?: number; tone?: string; countUp?: boolean }>(), {
  label: '',
  size: 200,
  tone: 'var(--accent)',
  countUp: false,
});
const R = 88;
const C = 2 * Math.PI * R;
const lit = computed(() => {
  const total = Math.max(1, props.totalSec);
  if (props.countUp) return (props.remainSec % total) / total;
  return Math.max(0, Math.min(1, props.remainSec / total));
});
const offset = computed(() => C * (1 - lit.value));
/** 大圈的数字跟着圈的大小缩放 */
const digits = computed(() => Math.round(props.size * (clock(props.remainSec).length > 5 ? 0.17 : 0.22)));
</script>

<template>
  <div class="timer-ring" :style="{ width: `${size}px`, height: `${size}px` }">
    <svg viewBox="0 0 200 200" class="absolute inset-0" aria-hidden="true">
      <circle cx="100" cy="100" :r="R" fill="none" stroke="var(--ring-track, var(--panel-2))" stroke-width="10" />
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
      <span class="num font-700 leading-none tracking-tight" :style="{ fontSize: `${digits}px` }">{{ clock(remainSec) }}</span>
      <span v-if="label" class="ring-label" :style="{ maxWidth: `${Math.round(size * 0.8)}px` }">{{ label }}</span>
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
.ring-label {
  margin-top: 6px;
  font-size: 12px;
  line-height: 1.3;
  color: var(--ink-2);
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
