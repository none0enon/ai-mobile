<script setup lang="ts" generic="T extends string">
/** 分段选择器（标签页切换、主题选择等）；disabled 的一项点不了（一起吃饭：她不在吃饭时不能"共同吃饭"） */
defineProps<{ options: { value: T; label: string; icon?: string; disabled?: boolean }[]; sticky?: boolean }>();
const model = defineModel<T>({ required: true });
</script>

<template>
  <div class="seg-wrap" :class="{ sticky }">
    <div class="seg" role="tablist">
      <button
        v-for="o in options"
        :key="o.value"
        role="tab"
        :aria-selected="model === o.value"
        class="seg-item"
        :class="{ on: model === o.value }"
        :disabled="o.disabled"
        :aria-disabled="o.disabled || undefined"
        @click="model = o.value"
      >
        <span v-if="o.icon" :class="o.icon" class="seg-icon" /><span class="seg-label">{{ o.label }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.seg-wrap.sticky {
  position: sticky;
  top: 0;
  z-index: 5;
  background: var(--bg);
  padding: 8px 16px;
}
.seg {
  display: flex;
  gap: 4px;
  padding: 4px;
  border-radius: 14px;
  background: var(--panel);
}
.seg-item {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 34px;
  border-radius: 10px;
  font-size: 14px;
  color: var(--ink-2);
  transition:
    background 0.2s,
    color 0.2s;
}
.seg-item {
  min-width: 0;
  padding: 0 4px;
  white-space: nowrap;
}
.seg-label {
  overflow: hidden;
  text-overflow: ellipsis;
}
.seg-icon {
  flex-shrink: 0;
}
/* 窄屏 + 系统大字体：图标让位给文字，不折成两行 */
@media (max-width: 360px) {
  .seg-icon {
    display: none;
  }
}
.seg-item:disabled {
  opacity: 0.45;
}
.seg-item.on {
  background: var(--surface);
  color: var(--ink);
  font-weight: 600;
  box-shadow: var(--shadow-sm);
}
</style>
