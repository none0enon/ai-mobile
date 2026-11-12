<script setup lang="ts">
/**
 * 各自专注时的长方形计时器：两块一上一下压在中线两边（像足球场的中线），上面是她的，下面是你的。
 * side 决定贴着中线的那一边是直角（her 下边、me 上边），远离中线的那一边是圆角。
 * 默认插槽放你的暂停、结束这些小按钮（她那块没有）。
 */
withDefaults(
  defineProps<{
    side: 'her' | 'me';
    /** 谁 · 在哪 */
    who: string;
    /** 大字：剩多少 / 过了多久 */
    time: string;
    /** 小字：专注中 · 第 2 个番茄 / 休息中 / 暂停 */
    state: string;
    /** 这一段走了多少（0–1），画在底边的细条上；正计时、不限时的休息不画 */
    fraction?: number | null;
    tone?: string;
  }>(),
  { fraction: null, tone: '#8fb3f0' },
);
</script>

<template>
  <div class="duo" :class="side" role="timer" :aria-label="`${who}：${time}，${state}`">
    <div class="min-w-0 flex-1">
      <div class="who truncate">{{ who }}</div>
      <div class="time num">{{ time }}</div>
      <div class="state truncate" :style="{ color: tone }">{{ state }}</div>
    </div>
    <div v-if="$slots.default" class="ctrl"><slot /></div>
    <span v-if="fraction !== null" class="bar" aria-hidden="true"><span :style="{ width: `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`, background: tone }" /></span>
  </div>
</template>

<style scoped>
.duo {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 74px;
  padding: 8px 12px 10px 14px;
  background: var(--glass);
  border: 1px solid var(--glass-line);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  box-shadow: var(--shadow-sm);
  overflow: hidden;
}
.duo.her {
  border-radius: 18px 18px 6px 6px;
}
.duo.me {
  border-radius: 6px 6px 18px 18px;
}
.who {
  font-size: 11.5px;
  color: var(--ink-3);
}
.time {
  font-size: 28px;
  font-weight: 700;
  line-height: 1.1;
  letter-spacing: -0.01em;
}
.state {
  font-size: 11.5px;
  margin-top: 1px;
}
.ctrl {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.bar {
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: 5px;
  height: 3px;
  border-radius: 2px;
  background: var(--glass-line);
  overflow: hidden;
}
.bar > span {
  display: block;
  height: 100%;
  border-radius: 2px;
  transition: width 0.9s linear;
}
</style>
