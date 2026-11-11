<script setup lang="ts">
import { PRESET_CATEGORIES, PRESET_CATEGORY_ORDER, PRESET_USES, type Character, type PresetCategory, type PresetUse } from '@app/shared';
import { showToast } from 'vant';
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Avatar from '@/components/common/Avatar.vue';
import HScroll from '@/components/common/HScroll.vue';
import PresetPicker from '@/components/settings/PresetPicker.vue';
import PageHeader from '@/layouts/PageHeader.vue';
import { useCharacterStore } from '@/stores/characters';
import { useLibraryStore } from '@/stores/library';

/**
 * 预设按用途分六类（?cat= 选哪一类）。每一类上面是"用在哪"：
 * - 对话：每个角色选自己的对话预设；
 * - 其他：每个用途（一起吃饭、主动消息、番外、总结、配图……）选一个这一类的预设，能跟随对话的可以选"跟随对话预设"。
 * 下面是这一类的所有预设。App 自带的预设来自预设文件，和导入的一样能改、能删、能复制、能导出。
 */
const route = useRoute();
const router = useRouter();
const lib = useLibraryStore();
const chars = useCharacterStore();

const cat = ref<PresetCategory>(PRESET_CATEGORY_ORDER.includes(route.query.cat as PresetCategory) ? (route.query.cat as PresetCategory) : 'chat');
watch(cat, (c) => void router.replace({ query: { ...route.query, cat: c } }));
watch(
  () => route.query.cat,
  (c) => {
    if (PRESET_CATEGORY_ORDER.includes(c as PresetCategory) && c !== cat.value) cat.value = c as PresetCategory;
  },
);

const list = computed(() => lib.presetsOf(cat.value));
const uses = computed(() => PRESET_USES.filter((u) => u.category === cat.value));

/** 一个用途现在用的是什么 */
function useLine(u: PresetUse): string {
  const id = lib.useChoice(u.id);
  if (id === null) return '跟随对话预设';
  return lib.presetById(id)?.name ?? `没有${PRESET_CATEGORIES[u.category].label}预设`;
}
/** 一个预设现在用在哪 */
function usedBy(id: string): string {
  if (cat.value === 'chat') return chars.list.filter((c) => lib.chatPresetFor(c)?.id === id).map((c) => c.name).join('、');
  return lib.usesOf(id).map((u) => u.label).join('、');
}

// —— 选预设的弹层：给一个用途选，或者给一个角色选对话预设 ——
const picking = ref<{ kind: 'use'; use: PresetUse } | { kind: 'character'; character: Character } | null>(null);
const pickOpen = computed({ get: () => !!picking.value, set: (v) => !v && (picking.value = null) });
const pickValue = computed(() => {
  const p = picking.value;
  if (!p) return undefined;
  return p.kind === 'use' ? lib.useChoice(p.use.id) : (lib.chatPresetFor(p.character)?.id ?? null);
});
function pick(id: string | null) {
  const p = picking.value;
  picking.value = null;
  if (!p) return;
  if (p.kind === 'use') {
    lib.setUse(p.use.id, id);
    showToast(`${p.use.label}：${id === null ? '跟随对话预设' : `用「${lib.presetById(id)?.name ?? ''}」`}`);
  } else if (id) {
    chars.setPreset(p.character.id, id);
    showToast(`${p.character.name}聊天用「${lib.presetById(id)?.name ?? ''}」`);
  }
}
</script>

<template>
  <div class="page" data-page="presets">
    <PageHeader title="预设" subtitle="按用途分六类；每一类都能导入、复制、改、删" fallback="/me">
      <template #right>
        <RouterLink to="/import" class="icon-btn" aria-label="导入预设"><span class="i-lucide-file-down text-[20px]" /></RouterLink>
      </template>
    </PageHeader>
    <HScroll :active="cat" class="gap-2 px-4 pt-1 pb-2" role="tablist" aria-label="预设分类">
      <button
        v-for="c in PRESET_CATEGORY_ORDER"
        :key="c"
        type="button"
        role="tab"
        :aria-selected="cat === c"
        class="cat press"
        :class="{ on: cat === c }"
        :data-cat="c"
        @click="cat = c"
      >
        <span :class="PRESET_CATEGORIES[c].icon" />{{ PRESET_CATEGORIES[c].label }}<span class="num text-ink-3 text-[12px]">{{ lib.presetsOf(c).length }}</span>
      </button>
    </HScroll>

    <div class="page-scroll px-4 pb-8 grid gap-3 content-start">
      <p class="text-[12.5px] text-ink-3 m-0 leading-relaxed">{{ PRESET_CATEGORIES[cat].desc }}</p>

      <!-- 用在哪 -->
      <section class="card" data-testid="preset-uses">
        <div class="text-[13px] font-600 mb-1.5">用在哪</div>
        <template v-if="cat === 'chat'">
          <button v-for="c in chars.list" :key="c.id" type="button" class="use press" :data-use="`character:${c.id}`" @click="picking = { kind: 'character', character: c }">
            <Avatar :character="c" :size="26" />
            <span class="flex-1 min-w-0 text-left">
              <span class="block text-[14px]">{{ c.name }}</span>
              <span class="block text-[12px] text-ink-3">平时聊天（气泡、剧场模式）</span>
            </span>
            <span class="pick">{{ lib.chatPresetFor(c)?.name ?? '没有对话预设' }}</span>
            <span class="i-lucide-chevron-right text-ink-3" />
          </button>
        </template>
        <template v-else>
          <button v-for="u in uses" :key="u.id" type="button" class="use press" :data-use="u.id" @click="picking = { kind: 'use', use: u }">
            <span class="use-icon"><span :class="u.icon" /></span>
            <span class="flex-1 min-w-0 text-left">
              <span class="block text-[14px]">{{ u.label }}</span>
              <span class="block text-[12px] text-ink-3 truncate">{{ u.desc }}</span>
            </span>
            <span class="pick">{{ useLine(u) }}</span>
            <span class="i-lucide-chevron-right text-ink-3" />
          </button>
        </template>
      </section>

      <!-- 这一类的预设 -->
      <RouterLink v-for="p in list" :key="p.id" :to="`/me/presets/${p.id}`" class="preset press" :data-preset="p.id">
        <div class="flex items-center gap-2">
          <span class="text-[16px] font-600 truncate">{{ p.name }}</span>
          <span class="ml-auto i-lucide-chevron-right text-ink-3 shrink-0" />
        </div>
        <p v-if="p.description" class="text-[12.5px] text-ink-2 mt-1 mb-0 leading-relaxed line-clamp-3">{{ p.description }}</p>
        <div class="flex flex-wrap gap-1.5 mt-2">
          <span class="tag">{{ p.blocks.length }} 块</span>
          <span class="tag num">温度 {{ p.sampler.temperature }}</span>
          <span class="tag num">最长 {{ p.sampler.maxTokens }}</span>
          <span v-if="p.seedFile" class="tag">自带 · {{ p.seedFile }}</span>
          <span v-else-if="p.source?.kind === 'sillytavern'" class="tag">从 SillyTavern 导入</span>
        </div>
        <div v-if="usedBy(p.id)" class="text-[12px] text-accent-ink mt-1.5">用在：{{ usedBy(p.id) }}</div>
      </RouterLink>
      <p v-if="!list.length" class="text-[13px] text-ink-3 text-center py-4 m-0">还没有{{ PRESET_CATEGORIES[cat].label }}预设：导入一个预设文件，或者在别的预设里点"复制"。</p>

      <RouterLink to="/import" class="import-link"><span class="i-lucide-file-down" />导入预设（SillyTavern 预设或预设文件）</RouterLink>
      <p class="text-[12px] text-ink-3 m-0 leading-relaxed">
        App 自带的预设来自 apps/web/src/presets 里的预设文件：第一次打开时放进预设库，之后和你导入的一样能改、能删；删掉的不会自己回来，想要可以重新导入那个文件。
      </p>
    </div>

    <van-popup v-model:show="pickOpen" position="bottom" round :style="{ maxHeight: '80%' }">
      <div v-if="picking" class="sheet" data-testid="use-sheet">
        <div class="sheet-title">{{ picking.kind === 'use' ? picking.use.label : `${picking.character.name} · 对话预设` }}</div>
        <p class="text-[12.5px] text-ink-3 mt-1 mb-3 leading-relaxed">{{ picking.kind === 'use' ? picking.use.desc : '平时聊天用这套；一起做事时用各自的功能预设。' }}</p>
        <PresetPicker
          :model-value="pickValue"
          :category="picking.kind === 'use' ? picking.use.category : 'chat'"
          :follow="picking.kind === 'use' && picking.use.followChat"
          @update:model-value="pick"
          @edit="picking = null"
        />
      </div>
    </van-popup>
  </div>
</template>

<style scoped>
.cat {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 34px;
  padding: 0 12px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 14px;
  white-space: nowrap;
  flex-shrink: 0;
}
.cat.on {
  background: var(--accent-soft);
  color: var(--ink);
  font-weight: 600;
  box-shadow: inset 0 0 0 1.5px var(--accent-line);
}
.card {
  padding: 12px 12px 6px;
  border-radius: 18px;
  background: var(--surface);
  border: 1px solid var(--border);
}
.use {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 0;
  border-top: 1px solid var(--border);
}
.use:first-of-type {
  border-top: 0;
}
.use-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 8px;
  background: var(--panel);
  color: var(--accent-ink);
  flex-shrink: 0;
}
.pick {
  max-width: 42%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  color: var(--accent-ink);
}
.preset {
  display: block;
  padding: 14px;
  border-radius: 18px;
  background: var(--surface);
  border: 1px solid var(--border);
  color: inherit;
  text-decoration: none;
}
.import-link {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 44px;
  border-radius: 14px;
  border: 1.5px dashed var(--border);
  color: var(--ink-2);
  font-size: 13.5px;
  text-decoration: none;
}
</style>
