<script setup lang="ts">
import { computed, ref } from 'vue';
import type { useMicLink } from '@/composables/useMicLink';

/**
 * 连麦中的一条小状态栏（健身）：她在说 / 在听你说、闭麦、改打字；哪一步没接通写明原因。
 * 挂断在右上角的连麦按钮上。typeForm：这里自己带打字框（练的时候下面已经有输入框，就不带）。
 */
const props = defineProps<{ link: ReturnType<typeof useMicLink>; pronoun: string; typeForm?: boolean }>();

const s = computed(() => props.link.state);
const status = computed(() => {
  const p = props.pronoun;
  if (s.value.her === 'speaking') return `${p}在说……`;
  if (s.value.her === 'thinking') return `${p}在想……`;
  if (s.value.you === 'recognizing') return '在听清你说的话……';
  if (s.value.you === 'speaking') return '在听你说……';
  if (s.value.input === 'type') return `打字和${p}说`;
  if (s.value.muted) return '你闭麦了';
  return `连麦中，说话${p}就听得到`;
});
const issue = computed(() => s.value.micIssue || s.value.sttIssue || s.value.llmIssue || s.value.hint);
const typed = ref('');
function send() {
  const t = typed.value.trim();
  if (!t) return;
  typed.value = '';
  void props.link.say(t);
}
</script>

<template>
  <div class="link-bar" data-testid="fit-link">
    <div class="flex items-center gap-2">
      <span class="live-dot" :class="{ talking: s.her === 'speaking' || s.you === 'speaking' }" />
      <span class="flex-1 min-w-0 truncate text-[12.5px] text-accent-ink" role="status">{{ status }}</span>
      <button type="button" class="lb" :class="{ on: s.muted }" :disabled="s.input === 'type'" :aria-label="s.muted ? '打开麦克风' : '闭麦'" :aria-pressed="s.muted" @click="link.setMuted(!s.muted)">
        <span :class="s.muted ? 'i-lucide-mic-off' : 'i-lucide-mic'" />
      </button>
      <button type="button" class="lb" :aria-label="s.input === 'type' ? '改成说话' : '改成打字'" @click="link.setInput(s.input === 'type' ? 'auto' : 'type')">
        <span :class="s.input === 'type' ? 'i-lucide-audio-lines' : 'i-lucide-keyboard'" />
      </button>
    </div>
    <p v-if="issue" class="issue" :class="{ soft: issue === s.hint }">{{ issue }}</p>
    <button v-if="s.needTap && s.input !== 'type'" type="button" class="tap" @click="link.tapToListen()"><span class="i-lucide-mic" />浏览器要先点一下才能听你说话：点这里</button>
    <form v-if="typeForm && s.input === 'type'" class="flex gap-2 mt-1.5" @submit.prevent="send">
      <input v-model="typed" class="field" :placeholder="`跟${pronoun}说……`" :aria-label="`跟${pronoun}说`" enterkeyhint="send" />
      <button type="submit" class="lb send" :disabled="!typed.trim()" aria-label="发送"><span class="i-lucide-send" /></button>
    </form>
  </div>
</template>

<style scoped>
.link-bar {
  width: 100%;
  padding: 7px 8px 7px 12px;
  border-radius: 16px;
  background: var(--veil);
  border: 1px solid var(--glass-line);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  box-shadow: var(--shadow-sm);
}
.live-dot {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  border-radius: 99px;
  background: var(--good);
}
.live-dot.talking {
  animation: pulse 1s ease-in-out infinite;
}
@keyframes pulse {
  50% {
    transform: scale(1.5);
    opacity: 0.6;
  }
}
.lb {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 30px;
  height: 30px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 14px;
}
.lb.on {
  background: var(--accent-soft);
  color: var(--accent-ink);
}
.lb:disabled {
  opacity: 0.5;
}
.issue {
  margin: 5px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--bad);
}
.issue.soft {
  color: var(--ink-3);
}
.tap {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 5px;
  font-size: 12px;
  color: var(--accent-ink);
}
.field {
  flex: 1;
  min-width: 0;
  height: 32px;
  padding: 0 12px;
  border-radius: 99px;
  border: 1px solid var(--glass-line);
  background: var(--glass-strong);
  outline: none;
  font-size: 14px;
}
.lb.send {
  background: var(--accent);
  color: var(--on-accent);
}
</style>
