<script setup lang="ts">
/**
 * 计时器上的小按钮（一起专注放在圆环里，各自专注放在你那块长方形计时器右边）：
 * - 专注：暂停 / 继续；番茄钟和倒计时 +5 分钟，正计时"休息"；结束；
 * - 番茄钟的休息：跳过；倒计时到点、正计时自己休息时（不限时）：继续专注；都能结束。
 */
defineProps<{ phase: 'focus' | 'break'; paused: boolean; kind: 'pomodoro' | 'countdown' | 'countup'; timedBreak: boolean }>();
defineEmits<{ (e: 'toggle' | 'add' | 'rest' | 'resume' | 'finish'): void }>();
</script>

<template>
  <div class="ctrls">
    <template v-if="phase === 'focus'">
      <button type="button" class="mini" :aria-label="paused ? '继续计时' : '暂停'" :title="paused ? '继续' : '暂停'" @click="$emit('toggle')">
        <span :class="paused ? 'i-lucide-play' : 'i-lucide-pause'" />
      </button>
      <button v-if="kind === 'countup'" type="button" class="mini wide" aria-label="休息一下" @click="$emit('rest')"><span class="i-lucide-coffee" />休息</button>
      <button v-else type="button" class="mini wide" aria-label="加 5 分钟" @click="$emit('add')">+5</button>
    </template>
    <button v-else type="button" class="mini wide" :aria-label="timedBreak ? '跳过休息' : '继续专注'" @click="$emit('resume')">
      <span :class="timedBreak ? 'i-lucide-skip-forward' : 'i-lucide-play'" />{{ timedBreak ? '跳过' : '继续' }}
    </button>
    <button type="button" class="mini wide" @click="$emit('finish')">结束</button>
  </div>
</template>

<style scoped>
.ctrls {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}
.mini {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  min-width: 30px;
  height: 30px;
  padding: 0 8px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 12.5px;
  font-weight: 600;
}
.mini.wide {
  padding: 0 10px;
}
.mini:active {
  transform: scale(0.95);
}
</style>
