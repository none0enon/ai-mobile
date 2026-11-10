<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import PageHeader from '@/layouts/PageHeader.vue';
import { presets } from '@/mock/library';
import { assemblePreview } from '@/services/prompt';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';

/** 查看提示词：按预设把这一轮要发给模型的内容逐块列出来（来源、位置、token 占比），方便调预设和世界书 */
const route = useRoute();
const chat = useChatStore();
const chars = useCharacterStore();
const chatId = computed(() => route.params.id as string);
const c = computed(() => chat.chatById(chatId.value));
const character = computed(() => chars.byId(c.value?.characterId));
const preset = computed(() => presets.find((p) => p.id === c.value?.presetId) ?? presets[0]!);
const blocks = computed(() => (c.value && character.value ? assemblePreview(c.value, character.value, chat.list(chatId.value)) : []));
const total = computed(() => blocks.value.filter((b) => b.enabled).reduce((n, b) => n + b.tokens, 0));
const budget = computed(() => preset.value.sampler.contextTokens);
const open = ref<string | null>('environment');
const ROLE: Record<string, string> = { system: '系统', user: '用户', assistant: '助手' };
</script>

<template>
  <div class="page" data-page="inspect">
    <PageHeader title="查看提示词" :subtitle="`${c?.title ?? ''} · 预设「${preset.name}」`" :fallback="`/chat/${chatId}`" />
    <div class="page-scroll pb-8">
      <div class="summary mx-4 mt-3">
        <div class="flex items-end justify-between">
          <div>
            <div class="text-[12.5px] text-ink-3">这一轮大约</div>
            <div class="num text-[26px] font-700 leading-tight">{{ total.toLocaleString('zh-CN') }} <span class="text-[13px] text-ink-3 font-400">/ {{ budget.toLocaleString('zh-CN') }} tokens</span></div>
          </div>
          <span class="chip">流式 · 温度 {{ preset.sampler.temperature }}</span>
        </div>
        <div class="stack">
          <span v-for="b in blocks.filter((x) => x.enabled)" :key="b.identifier" :style="{ flexGrow: b.tokens }" :title="`${b.name} ${b.tokens}`" />
        </div>
        <p class="text-[12px] text-ink-3 mt-2 mb-0 leading-relaxed">
          稳定的内容排在前面，方便命中服务商的前缀缓存；环境、记忆、场景这类每轮都会变的内容按深度插进聊天记录末尾。
        </p>
      </div>

      <div class="px-4 mt-3 grid gap-2">
        <div v-for="(b, i) in blocks" :key="b.identifier" class="block" :class="{ off: !b.enabled }">
          <button class="head" @click="open = open === b.identifier ? null : b.identifier">
            <span class="idx num">{{ i + 1 }}</span>
            <div class="flex-1 min-w-0 text-left">
              <div class="flex items-center gap-1.5">
                <span class="text-[14.5px] font-600 truncate">{{ b.name }}</span>
                <span class="role">{{ ROLE[b.role] }}</span>
              </div>
              <div class="text-[11.5px] text-ink-3 truncate">{{ b.source }} · {{ b.placement }}</div>
            </div>
            <span class="num text-[12px] text-ink-2">{{ b.enabled ? b.tokens : '空' }}</span>
            <span class="i-lucide-chevron-down text-ink-3 transition-transform" :class="{ 'rotate-180': open === b.identifier }" />
          </button>
          <pre v-if="open === b.identifier" class="content">{{ b.content || '（这一轮为空，不发送）' }}</pre>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.summary {
  padding: 14px;
  border-radius: 18px;
  background: var(--surface);
  border: 1px solid var(--border);
}
.stack {
  display: flex;
  gap: 2px;
  height: 8px;
  margin-top: 10px;
  border-radius: 4px;
  overflow: hidden;
}
.stack span {
  flex-basis: 0;
  background: var(--accent);
  opacity: 0.85;
}
.stack span:nth-child(2n) {
  opacity: 0.55;
}
.block {
  border-radius: 14px;
  background: var(--surface);
  border: 1px solid var(--border);
  overflow: hidden;
}
.block.off {
  opacity: 0.55;
}
.head {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 12px;
}
.idx {
  width: 22px;
  height: 22px;
  border-radius: 7px;
  background: var(--panel);
  font-size: 11.5px;
  line-height: 22px;
  text-align: center;
  color: var(--ink-3);
  flex-shrink: 0;
}
.role {
  padding: 0 6px;
  border-radius: 6px;
  background: var(--panel);
  color: var(--ink-3);
  font-size: 11px;
  line-height: 18px;
}
.content {
  margin: 0;
  padding: 10px 12px 12px 44px;
  border-top: 1px solid var(--border);
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--font-sans);
  font-size: 13px;
  line-height: 1.65;
  color: var(--ink-2);
  max-height: 260px;
  overflow-y: auto;
}
</style>
