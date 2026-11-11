<script setup lang="ts">
import type { Character } from '@app/shared';
import Avatar from './Avatar.vue';

/**
 * 一排头像 + 名字，选一个角色（主动消息页、"我的 → 试一试"用）。所有角色都在里面，包括导入的。
 * off(c) 为真时这一个显示成灰的（例如没打开主动消息）
 */
defineProps<{ characters: Character[]; label: string; off?: (c: Character) => boolean }>();
const model = defineModel<string>({ required: true });
</script>

<template>
  <div class="tabs hide-scrollbar" role="tablist" :aria-label="label">
    <button
      v-for="c in characters"
      :key="c.id"
      type="button"
      role="tab"
      :aria-selected="c.id === model"
      class="person-tab press"
      :class="{ on: c.id === model, off: off?.(c) }"
      :style="{ '--tone': c.accent }"
      :data-person="c.id"
      @click="model = c.id"
    >
      <Avatar :character="c" :size="26" />{{ c.name }}
    </button>
  </div>
</template>

<style scoped>
.tabs {
  display: flex;
  gap: 8px;
  overflow-x: auto;
}
.person-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 36px;
  padding: 0 12px 0 5px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 14px;
  white-space: nowrap;
  flex-shrink: 0;
}
.person-tab.off {
  opacity: 0.55;
}
.person-tab.on {
  opacity: 1;
  background: var(--accent-soft);
  color: var(--ink);
  font-weight: 600;
  box-shadow: inset 0 0 0 1.5px var(--tone);
}
</style>
