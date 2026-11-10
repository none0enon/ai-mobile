<script setup lang="ts">
import PageHeader from '@/layouts/PageHeader.vue';
import { useLibraryStore } from '@/stores/library';
import { useCharacterStore } from '@/stores/characters';

const chars = useCharacterStore();
const lib = useLibraryStore();
function boundTo(id: string) {
  return chars.list.filter((c) => c.lorebookIds.includes(id)).map((c) => c.name);
}
</script>

<template>
  <div class="page" data-page="lorebooks">
    <PageHeader title="世界书" subtitle="关键词触发的设定，兼容 SillyTavern World Info" fallback="/me">
      <template #right>
        <RouterLink to="/import" class="icon-btn" aria-label="导入世界书"><span class="i-lucide-file-down text-[20px]" /></RouterLink>
      </template>
    </PageHeader>
    <div class="page-scroll px-4 py-3 grid gap-3 content-start">
      <RouterLink v-for="b in lib.lorebooks" :key="b.id" :to="`/me/lorebooks/${b.id}`" class="book press">
        <span class="book-icon"><span class="i-lucide-library-big" /></span>
        <div class="flex-1 min-w-0">
          <div class="text-[16px] font-600">{{ b.name }}</div>
          <div class="text-[12.5px] text-ink-2">{{ b.description }}</div>
          <div class="flex flex-wrap gap-1.5 mt-2">
            <span class="tag">{{ b.entries.length }} 条</span>
            <span class="tag">常驻 {{ b.entries.filter((e) => e.constant).length }}</span>
            <span class="tag">扫描深度 {{ b.scanDepth }}</span>
            <span v-for="n in boundTo(b.id)" :key="n" class="tag accent">{{ n }}</span>
          </div>
        </div>
        <span class="i-lucide-chevron-right text-ink-3" />
      </RouterLink>
      <button class="add"><span class="i-lucide-plus" />新建世界书</button>
    </div>
  </div>
</template>

<style scoped>
.book {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 14px;
  border-radius: 18px;
  background: var(--surface);
  border: 1px solid var(--border);
  color: inherit;
  text-decoration: none;
}
.book-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 42px;
  border-radius: 14px;
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: 20px;
  flex-shrink: 0;
}
.add {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 48px;
  border-radius: 16px;
  border: 1.5px dashed var(--border);
  color: var(--ink-2);
}
</style>
