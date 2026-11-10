<script setup lang="ts">
import { nextTick, ref } from 'vue';

/** 视觉小说式对话框：名字、正文（流式时带光标）、选项、工具条、回复输入 */
const props = withDefaults(
  defineProps<{
    name: string;
    text: string;
    streaming?: boolean;
    thinking?: boolean;
    choices?: string[];
    voiceOn?: boolean;
    autoOn?: boolean;
    showTools?: boolean;
  }>(),
  { streaming: false, thinking: false, choices: () => [], voiceOn: false, autoOn: false, showTools: true },
);
const emit = defineEmits<{
  (e: 'reply', text: string): void;
  (e: 'choose', text: string): void;
  (e: 'log'): void;
  (e: 'toggle-voice'): void;
  (e: 'toggle-auto'): void;
}>();

const replying = ref(false);
const draft = ref('');
const input = ref<HTMLInputElement | null>(null);

async function openReply() {
  replying.value = true;
  await nextTick();
  input.value?.focus();
}

function submit() {
  const t = draft.value.trim();
  if (!t) return;
  emit('reply', t);
  draft.value = '';
  replying.value = false;
}

function segments(text: string) {
  return text.split(/(（[^）]*）|\([^)]*\)|\*[^*]+\*)/).filter(Boolean).map((s) => ({ text: s, action: /^（|^\(|^\*/.test(s) }));
}
</script>

<template>
  <div class="dialog">
    <div v-if="props.choices.length && !streaming" class="choices">
      <button v-for="c in props.choices" :key="c" class="choice press" @click="emit('choose', c)">{{ c }}</button>
    </div>
    <div class="box">
      <div class="name">
        <span class="i-lucide-heart text-[12px]" />{{ name }}
        <span v-if="thinking" class="ml-1 inline-flex gap-1 text-accent-ink">
          <span class="typing-dot !w-1 !h-1" /><span class="typing-dot !w-1 !h-1" /><span class="typing-dot !w-1 !h-1" />
        </span>
      </div>
      <p class="line" :class="{ 'stream-caret': streaming && !thinking }">
        <template v-for="(s, i) in segments(text)" :key="i">
          <span :class="{ action: s.action }">{{ s.text }}</span>
        </template>
      </p>
      <div v-if="replying" class="reply">
        <input
          ref="input"
          v-model="draft"
          class="reply-input"
          placeholder="回她一句…"
          enterkeyhint="send"
          aria-label="回复"
          @keydown.enter.prevent="submit"
        />
        <button class="reply-send" aria-label="发送" @click="submit"><span class="i-lucide-send-horizontal" /></button>
      </div>
      <div v-else-if="showTools" class="tools">
        <button class="tool" aria-label="记录" @click="emit('log')"><span class="i-lucide-scroll-text" /><span class="tool-label">记录</span></button>
        <button class="tool" :class="{ on: autoOn }" aria-label="自动" @click="emit('toggle-auto')"><span class="i-lucide-fast-forward" /><span class="tool-label">自动</span></button>
        <button class="tool" :class="{ on: voiceOn }" aria-label="语音" @click="emit('toggle-voice')"><span class="i-lucide-volume-2" /><span class="tool-label">语音</span></button>
        <button class="tool primary" @click="openReply">回复<span class="i-lucide-chevron-right" /></button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dialog {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 10;
  padding: 0 12px calc(var(--safe-bottom) + 12px);
}
.box {
  padding: 14px 16px 10px;
  border-radius: 24px;
  background: var(--glass-strong);
  border: 1px solid var(--glass-line);
  backdrop-filter: blur(22px);
  -webkit-backdrop-filter: blur(22px);
  box-shadow: var(--shadow);
}
.name {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-bottom: 6px;
  color: var(--accent-ink);
  font-weight: 600;
  font-size: 14px;
}
.line {
  margin: 0;
  min-height: 3.2em;
  font-size: 16px;
  line-height: 1.65;
  letter-spacing: 0.02em;
  white-space: pre-wrap;
  word-break: break-word;
}
.action {
  opacity: 0.6;
  font-style: italic;
}
.tools {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--glass-line);
}
.tool {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  gap: 4px;
  height: 32px;
  padding: 0 10px;
  border-radius: 99px;
  font-size: 13px;
  color: var(--ink-2);
  white-space: nowrap;
}
@media (max-width: 360px) {
  .tool-label {
    display: none;
  }
}
.tool.on {
  color: var(--accent-ink);
  background: var(--accent-soft);
}
.tool.primary {
  margin-left: auto;
  background: var(--accent);
  color: var(--on-accent);
  font-weight: 600;
}
.choices {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 10px;
}
.choice {
  padding: 11px 14px;
  border-radius: 16px;
  background: var(--glass-strong);
  border: 1px solid var(--accent-line);
  color: var(--ink);
  font-size: 15px;
  text-align: center;
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
}
.reply {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}
.reply-input {
  flex: 1;
  min-width: 0;
  height: 40px;
  padding: 0 14px;
  border-radius: 20px;
  border: 1px solid var(--accent-line);
  background: var(--panel);
  outline: none;
}
.reply-send {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: var(--accent);
  color: var(--on-accent);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
</style>
