<script setup lang="ts">
import { goBack as navBack } from '@/router';

/** 二级页面的顶栏：返回 + 标题（可带副标题）+ 右侧按钮插槽 */
const props = withDefaults(
  defineProps<{ title?: string; subtitle?: string; back?: boolean; fallback?: string; transparent?: boolean }>(),
  { back: true, fallback: '/chats', transparent: false },
);

function goBack() {
  navBack(props.fallback);
}
</script>

<template>
  <header class="page-header" :class="{ 'is-transparent': transparent }">
    <div class="flex items-center gap-1 h-12 px-1.5">
      <button v-if="back" class="icon-btn" aria-label="返回" @click="goBack">
        <span class="i-lucide-chevron-left text-[22px]" />
      </button>
      <div class="flex-1 min-w-0" :class="{ 'pl-3': !back }">
        <slot name="title">
          <div class="text-[16px] font-600 truncate leading-tight">{{ title }}</div>
          <div v-if="subtitle" class="text-[12px] text-ink-3 truncate leading-tight mt-0.5">{{ subtitle }}</div>
        </slot>
      </div>
      <div class="flex items-center">
        <slot name="right" />
      </div>
    </div>
  </header>
</template>

<style scoped>
.page-header {
  position: relative;
  z-index: 20;
  flex-shrink: 0;
  padding-top: var(--safe-top);
  background: var(--glass);
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
  border-bottom: 1px solid var(--glass-line);
}
.page-header.is-transparent {
  background: transparent;
  border-bottom-color: transparent;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}
</style>
