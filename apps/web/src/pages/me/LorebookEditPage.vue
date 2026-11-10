<script setup lang="ts">
import type { LoreEntry, LorePosition } from '@app/shared';
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import PageHeader from '@/layouts/PageHeader.vue';
import { useLibraryStore } from '@/stores/library';

const route = useRoute();
const lib = useLibraryStore();
const book = computed(() => lib.lorebookById(route.params.id as string) ?? lib.lorebooks[0]!);
const POSITION: Record<LorePosition, string> = {
  before_char: '角色定义前',
  after_char: '角色定义后',
  an_top: '作者注顶部',
  an_bottom: '作者注底部',
  at_depth: '按深度插入',
  em_top: '示例对话前',
  em_bottom: '示例对话后',
};
const LOGIC = { and_any: '含任一', not_all: '不全含', not_any: '都不含', and_all: '全都含' } as const;
const editing = ref<LoreEntry | null>(null);
const open = computed({ get: () => !!editing.value, set: (v) => !v && (editing.value = null) });
const keyDraft = ref('');
function addKey() {
  const k = keyDraft.value.trim();
  if (k && editing.value) editing.value.keys.push(k);
  keyDraft.value = '';
}
</script>

<template>
  <div class="page" data-page="lorebook-edit">
    <PageHeader :title="book.name" :subtitle="book.description" fallback="/me/lorebooks" />
    <div class="page-scroll pb-10">
      <van-cell-group inset class="!mt-3">
        <van-cell title="扫描深度" label="检查最近几条消息里的关键词" center>
          <template #right-icon><van-stepper v-model="book.scanDepth" min="1" max="20" /></template>
        </van-cell>
        <van-cell title="Token 预算" label="世界书最多占多少 token" center>
          <template #right-icon><van-stepper v-model="book.tokenBudget" min="100" max="8000" step="100" /></template>
        </van-cell>
        <van-cell title="递归扫描" label="条目内容里的关键词也能触发别的条目" center>
          <template #right-icon><van-switch v-model="book.recursive" size="22px" /></template>
        </van-cell>
      </van-cell-group>

      <div class="group-title">条目（{{ book.entries.length }}）<button class="action"><span class="i-lucide-plus" />添加</button></div>
      <div class="px-4 grid gap-2">
        <button v-for="e in book.entries" :key="e.uid" class="entry press" :class="{ off: !e.enabled }" @click="editing = e">
          <div class="flex items-center gap-2">
            <span class="text-[14.5px] font-600 truncate">{{ e.comment }}</span>
            <span v-if="e.constant" class="tag accent">常驻</span>
            <span v-else class="tag">关键词</span>
            <span class="ml-auto text-[11.5px] text-ink-3 num">#{{ e.order }}</span>
          </div>
          <div class="flex flex-wrap gap-1 mt-1.5">
            <span v-for="k in e.keys" :key="k" class="key">{{ k }}</span>
            <span v-for="k in e.secondaryKeys" :key="`s-${k}`" class="key second">{{ k }}</span>
          </div>
          <div class="text-[12.5px] text-ink-2 mt-1.5 line-clamp-2 text-left">{{ e.content }}</div>
          <div class="text-[11.5px] text-ink-3 mt-1 text-left">
            {{ POSITION[e.position] }}<template v-if="e.position === 'at_depth'"> · 深度 {{ e.depth }}</template> · 概率 {{ e.probability }}%
          </div>
        </button>
      </div>
    </div>

    <van-popup v-model:show="open" position="bottom" round :style="{ maxHeight: '90%' }">
      <div v-if="editing" class="sheet">
        <div class="flex items-center">
          <div class="sheet-title flex-1">{{ editing.comment }}</div>
          <van-switch v-model="editing.enabled" size="20px" />
        </div>
        <label class="field-label">主关键词（任一出现就触发）</label>
        <div class="flex flex-wrap gap-1.5">
          <span v-for="(k, i) in editing.keys" :key="k" class="key">{{ k }}<button class="ml-1" :aria-label="`删除 ${k}`" @click="editing.keys.splice(i, 1)">×</button></span>
          <input v-model="keyDraft" class="key-input" placeholder="+ 关键词" aria-label="新关键词" @keydown.enter="addKey" />
        </div>
        <label class="field-label">次关键词与逻辑</label>
        <div class="flex flex-wrap gap-1.5">
          <button v-for="(label, k) in LOGIC" :key="k" class="opt" :class="{ on: editing.logic === k }" @click="editing.logic = k">{{ label }}</button>
        </div>
        <label class="field-label" for="le-content">内容</label>
        <textarea id="le-content" v-model="editing.content" class="textarea" rows="4" />
        <div class="flex items-center justify-between mt-3">
          <span class="text-[14px]">常驻（不需要关键词）</span>
          <van-switch v-model="editing.constant" size="22px" />
        </div>
        <label class="field-label">插入位置</label>
        <div class="flex flex-wrap gap-1.5">
          <button v-for="(label, k) in POSITION" :key="k" class="opt" :class="{ on: editing.position === k }" @click="editing.position = k">{{ label }}</button>
        </div>
        <div class="grid grid-cols-2 gap-3 mt-3">
          <div><label class="field-label !mt-0">顺序</label><van-stepper v-model="editing.order" min="0" max="999" /></div>
          <div><label class="field-label !mt-0">深度</label><van-stepper v-model="editing.depth" min="0" max="20" :disabled="editing.position !== 'at_depth'" /></div>
        </div>
        <label class="field-label">触发概率 {{ editing.probability }}%</label>
        <van-slider v-model="editing.probability" bar-height="4px" button-size="18px" />
        <p class="text-[12px] text-ink-3 mt-3 mb-0">粘性 / 冷却 / 延迟、分组、递归开关在"高级"里（M1）。中文关键词不按整词匹配。</p>
      </div>
    </van-popup>
  </div>
</template>

<style scoped>
.entry {
  display: block;
  width: 100%;
  padding: 12px 14px;
  border-radius: 16px;
  background: var(--surface);
  border: 1px solid var(--border);
}
.entry.off {
  opacity: 0.5;
}
.key {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 8px;
  border-radius: 6px;
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: 12px;
}
.key.second {
  background: var(--panel);
  color: var(--ink-2);
}
.key-input {
  width: 90px;
  height: 24px;
  padding: 0 8px;
  border-radius: 6px;
  border: 1px dashed var(--border);
  background: transparent;
  outline: none;
  font-size: 13px;
}
.opt {
  height: 30px;
  padding: 0 11px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 12.5px;
}
.opt.on {
  background: var(--accent);
  color: var(--on-accent);
  font-weight: 600;
}
</style>
