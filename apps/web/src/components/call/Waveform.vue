<script setup lang="ts">
/** 声波：level 0-1，由 TTS（她说话）或麦克风（你说话）驱动 */
const props = withDefaults(defineProps<{ level: number; bars?: number; tone?: string }>(), { bars: 21, tone: 'var(--accent)' });
function h(i: number) {
  const center = (props.bars - 1) / 2;
  const shape = 1 - Math.abs(i - center) / (center + 1);
  return 12 + props.level * shape * 88 * (0.6 + 0.4 * Math.abs(Math.sin(i * 1.7 + props.level * 9)));
}
</script>

<template>
  <div class="wave" aria-hidden="true">
    <span v-for="i in bars" :key="i" :style="{ height: `${h(i - 1)}%`, background: tone }" />
  </div>
</template>

<style scoped>
.wave {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 46px;
}
.wave span {
  width: 4px;
  border-radius: 2px;
  transition: height 0.09s linear;
  opacity: 0.9;
}
</style>
