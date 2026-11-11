<script setup lang="ts">
import { PRESET_CATEGORIES, type PresetCategory } from '@app/shared';
import { computed } from 'vue';
import { useLibraryStore } from '@/stores/library';

/**
 * 选预设：只列这一类的预设；点一行选它，右边"编辑"进预设编辑页。
 * follow：多一个"跟随对话预设"（选它时值是 null），给一起做事、主动消息用。
 * 聊天页的"⋯ → 预设"、角色编辑页的"预设"、预设页里每个用途的选择共用
 */
const props = defineProps<{ modelValue: string | null | undefined; category: PresetCategory; follow?: boolean; followLabel?: string }>();
const emit = defineEmits<{ 'update:modelValue': [id: string | null]; edit: [id: string] }>();
const lib = useLibraryStore();
const list = computed(() => lib.presetsOf(props.category));
</script>

<template>
  <div class="grid gap-2" role="radiogroup" :aria-label="`${PRESET_CATEGORIES[category].label}预设`">
    <div v-if="follow" class="row" :class="{ on: modelValue === null }" data-preset="follow">
      <button type="button" role="radio" :aria-checked="modelValue === null" class="main" @click="emit('update:modelValue', null)">
        <span class="dot"><span v-if="modelValue === null" class="i-lucide-check" /></span>
        <span class="flex-1 min-w-0">
          <span class="block text-[14.5px] font-600">跟随对话预设</span>
          <span class="block text-[12px] text-ink-3 leading-normal mt-0.5">{{ followLabel ?? '用这个角色自己的对话预设（角色设定 → 预设）' }}</span>
        </span>
      </button>
    </div>
    <div v-for="p in list" :key="p.id" class="row" :class="{ on: p.id === modelValue }" :data-preset="p.id">
      <button type="button" role="radio" :aria-checked="p.id === modelValue" class="main" @click="emit('update:modelValue', p.id)">
        <span class="dot"><span v-if="p.id === modelValue" class="i-lucide-check" /></span>
        <span class="flex-1 min-w-0">
          <span class="block text-[14.5px] font-600 truncate">{{ p.name }}</span>
          <span v-if="p.description" class="block text-[12px] text-ink-3 leading-normal mt-0.5 line-clamp-2">{{ p.description }}</span>
          <span class="flex flex-wrap gap-1 mt-1.5">
            <span class="tag">{{ p.blocks.length }} 块</span>
            <span class="tag num">温度 {{ p.sampler.temperature }}</span>
            <span class="tag num">最长 {{ p.sampler.maxTokens }}</span>
          </span>
        </span>
      </button>
      <RouterLink :to="`/me/presets/${p.id}`" class="edit" :aria-label="`编辑预设「${p.name}」`" @click="emit('edit', p.id)">编辑</RouterLink>
    </div>
    <p v-if="!list.length" class="text-[13px] text-ink-3 m-0 leading-relaxed">
      还没有{{ PRESET_CATEGORIES[category].label }}预设：在"我的 → 预设"里导入预设文件，或者把别的预设复制过来。
    </p>
  </div>
</template>

<style scoped>
.row {
  display: flex;
  align-items: stretch;
  border-radius: 14px;
  background: var(--panel);
  border: 1px solid transparent;
}
.row.on {
  background: var(--accent-soft);
  border-color: var(--accent-line);
}
/* 行底色和 .tag 一样是 --panel：标签改成叠一层，选中和没选中时都看得出来 */
.row .tag {
  background: color-mix(in srgb, var(--ink) 7%, transparent);
}
.main {
  display: flex;
  flex: 1;
  align-items: flex-start;
  gap: 10px;
  min-width: 0;
  padding: 10px 0 10px 12px;
  text-align: left;
}
.dot {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  margin-top: 1px;
  border-radius: 50%;
  border: 1.5px solid var(--ink-3);
  font-size: 13px;
}
.row.on .dot {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--on-accent);
}
.edit {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  padding: 0 14px;
  color: var(--accent-ink);
  font-size: 13px;
  text-decoration: none;
}
</style>
