<script setup lang="ts">
import PageHeader from '@/layouts/PageHeader.vue';
import { useLibraryStore } from '@/stores/library';

const lib = useLibraryStore();
</script>

<template>
  <div class="page" data-page="presets">
    <PageHeader title="预设" subtitle="提示词顺序 + 采样参数，兼容 ST Chat Completion 预设" fallback="/me">
      <template #right>
        <RouterLink to="/import" class="icon-btn" aria-label="导入预设"><span class="i-lucide-file-down text-[20px]" /></RouterLink>
      </template>
    </PageHeader>
    <div class="page-scroll px-4 py-3 grid gap-3 content-start">
      <RouterLink v-for="p in lib.presets" :key="p.id" :to="`/me/presets/${p.id}`" class="preset press">
        <div class="flex items-center gap-2">
          <span class="text-[16px] font-600">{{ p.name }}</span>
          <span class="ml-auto i-lucide-chevron-right text-ink-3" />
        </div>
        <p class="text-[12.5px] text-ink-2 mt-1 mb-0 leading-relaxed">{{ p.description }}</p>
        <div class="flex flex-wrap gap-1.5 mt-2">
          <span class="tag">{{ p.blocks.length }} 块</span>
          <span class="tag num">温度 {{ p.sampler.temperature }}</span>
          <span class="tag num">最长 {{ p.sampler.maxTokens }}</span>
          <span class="tag num">上下文 {{ (p.sampler.contextTokens / 1000).toFixed(0) }}k</span>
        </div>
      </RouterLink>
    </div>
  </div>
</template>

<style scoped>
.preset {
  display: block;
  padding: 14px;
  border-radius: 18px;
  background: var(--surface);
  border: 1px solid var(--border);
  color: inherit;
  text-decoration: none;
}
</style>
