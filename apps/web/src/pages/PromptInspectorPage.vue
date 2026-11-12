<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import Segmented from '@/components/common/Segmented.vue';
import PageHeader from '@/layouts/PageHeader.vue';
import { assembleForChat, useLabel, type ChatPrompt } from '@/services/prompt';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';
import { hhmm } from '@/utils/time';

/**
 * 查看提示词：发消息时拼好的提示词原样留在内存里，这里逐条列出来（发了哪些消息、预设每一块怎么处理、
 * 世界书每条为什么触发 / 没触发、请求体）。还没发过时，按现在的聊天记录预览一遍（不推进世界书的粘性 / 冷却）。
 */
const route = useRoute();
const chat = useChatStore();
const chars = useCharacterStore();
const chatId = computed(() => route.params.id as string);
const c = computed(() => chat.chatById(chatId.value));
const character = computed(() => chars.byId(c.value?.characterId));

const last = computed(() => chat.lastPrompt[chatId.value]);
const which = ref<'last' | 'preview'>(last.value ? 'last' : 'preview');
/** 按现在的聊天预览；一个预设都选不到时显示原因 */
const previewError = ref('');
const preview = computed((): ChatPrompt | null => {
  previewError.value = '';
  if (!c.value || !character.value) return null;
  try {
    return assembleForChat(c.value, character.value, chat.list(chatId.value), { dryRun: true });
  } catch (e) {
    previewError.value = e instanceof Error ? e.message : String(e);
    return null;
  }
});
const p = computed(() => (which.value === 'last' && last.value ? last.value.prompt : preview.value));

const tab = ref<'messages' | 'blocks' | 'lore' | 'request'>('messages');
const open = ref<Set<string>>(new Set());
function toggle(key: string) {
  const s = new Set(open.value);
  if (s.has(key)) s.delete(key);
  else s.add(key);
  open.value = s;
}

const ROLE: Record<string, string> = { system: '系统', user: '用户', assistant: '助手' };
const POS: Record<string, string> = {
  before_char: '角色前',
  after_char: '角色后',
  an_top: '作者注前',
  an_bottom: '作者注后',
  at_depth: '按深度',
  em_top: '示例前',
  em_bottom: '示例后',
};
const counts = computed(() => {
  const m = p.value?.messages ?? [];
  return { system: m.filter((x) => x.role === 'system').length, user: m.filter((x) => x.role === 'user').length, assistant: m.filter((x) => x.role === 'assistant').length };
});
const json = computed(() => (p.value ? JSON.stringify(p.value.request, null, 2) : ''));
const loreHits = computed(() => p.value?.lore.log.filter((l) => l.activated).length ?? 0);
/** 世界书条目的位置对应预设里哪一块 */
const SLOT: Record<string, string> = {
  before_char: 'worldInfoBefore',
  after_char: 'worldInfoAfter',
  em_top: 'dialogueExamples',
  em_bottom: 'dialogueExamples',
  an_top: 'chatHistory',
  an_bottom: 'chatHistory',
  at_depth: 'chatHistory',
};
/** 触发了，但预设里对应的位置关着（或这一轮没发）：说明一下，免得以为发出去了 */
function slotNote(position: string): string | null {
  const id = SLOT[position];
  const b = p.value?.blocks.find((x) => x.identifier === id);
  if (!b) return `预设里没有"${id}"这一块，没有发送`;
  if (!b.enabled) return `但预设里「${b.name}」关着，没有发送`;
  return null;
}
</script>

<template>
  <div class="page" data-page="inspect">
    <PageHeader title="查看提示词" :subtitle="`${c?.title ?? ''} · 预设「${p?.preset.name ?? ''}」${p ? `（${useLabel(p.use, p.keptIn)}）` : ''}`" :fallback="`/chat/${chatId}`" />
    <div v-if="!p && previewError" class="page-scroll px-4 py-6 text-[14px] text-ink-2 leading-relaxed" data-testid="inspect-error">
      {{ previewError }}
      <RouterLink to="/me/presets" class="block mt-3 text-accent-ink">去"我的 → 预设"</RouterLink>
    </div>
    <div v-if="p" class="page-scroll pb-8">
      <div class="summary mx-4 mt-3">
        <div class="flex gap-1.5 mb-2.5">
          <button v-if="last" class="mini" :class="{ on: which === 'last' }" @click="which = 'last'">上一次发送 · {{ hhmm(last.at) }}</button>
          <button class="mini" :class="{ on: which === 'preview' }" @click="which = 'preview'">按现在的聊天预览</button>
        </div>
        <div class="flex items-end justify-between gap-2">
          <div class="min-w-0">
            <div class="text-[12.5px] text-ink-3">{{ p.messages.length }} 条消息 · 系统 {{ counts.system }} · 你 {{ counts.user }} · 角色 {{ counts.assistant }}</div>
            <div class="num text-[26px] font-700 leading-tight" data-testid="inspect-tokens">
              {{ p.tokens.toLocaleString('zh-CN') }} <span class="text-[13px] text-ink-3 font-400">/ {{ p.budget.toLocaleString('zh-CN') }} tokens</span>
            </div>
          </div>
          <span class="chip shrink-0">{{ p.preset.sampler.stream ? '流式' : '非流式' }} · 温度 {{ p.preset.sampler.temperature }}</span>
        </div>
        <div class="stack">
          <span v-for="(m, i) in p.messages" :key="i" :class="m.role" :style="{ flexGrow: Math.max(1, m.content.length) }" :title="m.label" />
        </div>
        <p class="text-[12px] text-ink-3 mt-2 mb-0 leading-relaxed">
          聊天记录放了 {{ p.historyIncluded }} / {{ p.historyTotal }} 条 · 世界书触发 {{ loreHits }} 条<template v-if="p.overBudget"> · <b class="text-[var(--bad)]">必带的块已经超出上下文预算</b></template>。
          {{ which === 'last' ? '这是上一次实际发给模型的内容。' : '预览不推进世界书的粘性 / 冷却；真正发送时用的是同一个拼装函数。' }}
        </p>
      </div>

      <Segmented
        v-model="tab"
        sticky
        class="mt-2"
        :options="[
          { value: 'messages', label: '发送的消息' },
          { value: 'blocks', label: '预设块' },
          { value: 'lore', label: '世界书' },
          { value: 'request', label: '请求体' },
        ]"
      />

      <div v-if="tab === 'messages'" class="px-4 grid gap-2" data-testid="inspect-messages">
        <div v-for="(m, i) in p.messages" :key="i" class="block" :data-role="m.role">
          <button class="head" @click="toggle(`m${i}`)">
            <span class="idx num">{{ i + 1 }}</span>
            <div class="flex-1 min-w-0 text-left">
              <div class="flex items-center gap-1.5 min-w-0">
                <span class="role" :class="m.role">{{ ROLE[m.role] }}</span>
                <span class="text-[13.5px] font-600 truncate">{{ m.label }}</span>
              </div>
              <div v-if="!open.has(`m${i}`)" class="text-[12px] text-ink-3 truncate">{{ m.content }}</div>
            </div>
            <span class="i-lucide-chevron-down text-ink-3 transition-transform shrink-0" :class="{ 'rotate-180': open.has(`m${i}`) }" />
          </button>
          <pre v-if="open.has(`m${i}`)" class="content">{{ m.content }}</pre>
        </div>
      </div>

      <div v-else-if="tab === 'blocks'" class="px-4 grid gap-2">
        <div v-for="(b, i) in p.blocks" :key="b.identifier" class="block" :class="{ off: !b.sent }">
          <button class="head" @click="toggle(`b${i}`)">
            <span class="idx num">{{ i + 1 }}</span>
            <div class="flex-1 min-w-0 text-left">
              <div class="flex items-center gap-1.5 min-w-0">
                <span class="text-[14px] font-600 truncate">{{ b.name }}</span>
                <span class="role">{{ ROLE[b.role] }}</span>
                <span v-if="b.origin === 'app'" class="role accent">App</span>
              </div>
              <div class="text-[11.5px] text-ink-3 truncate">{{ b.note ?? `${b.source} · ${b.placement}` }}</div>
            </div>
            <span class="num text-[12px] text-ink-2 shrink-0">{{ b.sent ? b.tokens : '—' }}</span>
            <span class="i-lucide-chevron-down text-ink-3 transition-transform shrink-0" :class="{ 'rotate-180': open.has(`b${i}`) }" />
          </button>
          <pre v-if="open.has(`b${i}`)" class="content">{{ b.content || '（这一轮为空）' }}</pre>
        </div>
        <p class="text-[12px] text-ink-3 m-0 leading-relaxed">灰色的块这一轮没有发送；关掉的程序填充块也会算出内容，方便看"打开后会放什么"。在预设里可以开关。</p>
      </div>

      <div v-else-if="tab === 'lore'" class="px-4 grid gap-2">
        <div v-for="l in p.lore.log" :key="l.key" class="lore" :class="{ on: l.activated }">
          <span
            :class="l.activated ? (slotNote(l.position) ? 'i-lucide-circle-alert text-[var(--warn)]' : 'i-lucide-circle-check text-accent-ink') : 'i-lucide-circle-minus text-ink-3'"
            class="shrink-0 mt-0.5"
          />
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-1.5 min-w-0">
              <span class="text-[14px] font-600 truncate">{{ l.comment || `条目 ${l.uid}` }}</span>
              <span class="role">{{ POS[l.position] }}</span>
            </div>
            <div class="text-[12px] text-ink-2 leading-relaxed">{{ l.reason }}</div>
            <div v-if="l.activated && slotNote(l.position)" class="text-[12px] text-[var(--warn)] leading-relaxed">{{ slotNote(l.position) }}</div>
            <div class="text-[11px] text-ink-3 truncate">{{ l.bookName }} · #{{ l.uid }}</div>
          </div>
        </div>
        <p v-if="!p.lore.log.length" class="text-[13px] text-ink-3 text-center py-6 m-0">这个角色没有绑定世界书</p>
        <p v-else class="text-[12px] text-ink-3 m-0 leading-relaxed">
          扫描规则同 SillyTavern：默认看最近 2 条消息，常驻条目总是触发；"延迟到递归"的条目只在别的条目内容触发递归时才有机会。预算 {{ p.lore.budget.toLocaleString('zh-CN') }} tokens。
          触发了的条目还要看预设里对应的位置（例如"世界书（角色前）"）开没开，才会发出去。
        </p>
      </div>

      <div v-else class="px-4">
        <pre class="json" data-testid="inspect-request">{{ json }}</pre>
        <p class="text-[12px] text-ink-3 mt-2 mb-0 leading-relaxed">OpenAI 兼容的 /v1/chat/completions 请求体。接上真实 API 后就发这个；模型名来自"API 设置"里主对话的设置。</p>
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
.mini {
  height: 28px;
  padding: 0 10px;
  border-radius: 99px;
  background: var(--panel);
  font-size: 12px;
  color: var(--ink-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mini.on {
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-weight: 600;
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
  min-width: 2px;
  background: var(--ink-3);
  opacity: 0.6;
}
.stack span.user {
  background: var(--accent);
  opacity: 0.9;
}
.stack span.assistant {
  background: var(--accent);
  opacity: 0.5;
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
  flex-shrink: 0;
}
.role.user,
.role.accent {
  background: var(--accent-soft);
  color: var(--accent-ink);
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
  max-height: 320px;
  overflow-y: auto;
}
.lore {
  display: flex;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 14px;
  background: var(--surface);
  border: 1px solid var(--border);
}
.lore:not(.on) {
  opacity: 0.75;
}
.json {
  margin: 0;
  padding: 12px;
  border-radius: 14px;
  background: var(--surface);
  border: 1px solid var(--border);
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
  line-height: 1.55;
  color: var(--ink-2);
  max-height: 70vh;
  overflow: auto;
}
</style>
