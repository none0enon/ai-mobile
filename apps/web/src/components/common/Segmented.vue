<script setup lang="ts" generic="T extends string">
/** 分段选择器（标签页切换、主题选择等） */
defineProps<{ options: { value: T; label: string; icon?: string }[]; sticky?: boolean }>();
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
        @click="model = o.value"
      >
        <span v-if="o.icon" :class="o.icon" />{{ o.label }}
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
.seg-item.on {
  background: var(--surface);
  color: var(--ink);
  font-weight: 600;
  box-shadow: var(--shadow-sm);
}
</style>
