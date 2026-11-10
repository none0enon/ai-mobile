<script setup lang="ts">
import { nextTick, ref } from 'vue';

/** 输入栏：文字 / 按住说话 / ＋面板（相册、拍照、一起听歌、约会、戳一戳……） */
const props = withDefaults(defineProps<{ busy?: boolean; placeholder?: string; compact?: boolean }>(), {
  busy: false,
  placeholder: '说点什么…',
  compact: false,
});
const emit = defineEmits<{
  (e: 'send', text: string): void;
  (e: 'stop'): void;
  (e: 'voice', durationMs: number): void;
  (e: 'action', id: string): void;
}>();

const text = ref('');
const voiceMode = ref(false);
const plusOpen = ref(false);
const holding = ref(false);
const cancelling = ref(false);
const input = ref<HTMLTextAreaElement | null>(null);
let holdStart = 0;
let startY = 0;

const ACTIONS = [
  { id: 'album', label: '相册', icon: 'i-lucide-image' },
  { id: 'camera', label: '拍照', icon: 'i-lucide-camera' },
  { id: 'music', label: '一起听歌', icon: 'i-lucide-music-2' },
  { id: 'date', label: '约会邀请', icon: 'i-lucide-heart-handshake' },
  { id: 'poke', label: '戳一戳', icon: 'i-lucide-pointer' },
  { id: 'workout', label: '运动记录', icon: 'i-lucide-footprints' },
  { id: 'meal', label: '饭照', icon: 'i-lucide-utensils' },
  { id: 'cg', label: '生成配图', icon: 'i-lucide-wand-sparkles' },
  { id: 'call', label: '语音通话', icon: 'i-lucide-phone' },
  { id: 'scenes', label: '去哪儿', icon: 'i-lucide-map' },
];

function autosize() {
  const el = input.value;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
}

function send() {
  const t = text.value.trim();
  if (!t) return;
  emit('send', t);
  text.value = '';
  void nextTick(autosize);
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
}

function pressStart(e: PointerEvent) {
  holding.value = true;
  cancelling.value = false;
  holdStart = Date.now();
  startY = e.clientY;
  (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
}
function pressMove(e: PointerEvent) {
  if (holding.value) cancelling.value = startY - e.clientY > 60;
}
function pressEnd() {
  if (!holding.value) return;
  holding.value = false;
  const ms = Date.now() - holdStart;
  if (!cancelling.value && ms > 400) emit('voice', ms);
}

function toggleVoice() {
  voiceMode.value = !voiceMode.value;
  plusOpen.value = false;
}

function act(id: string) {
  plusOpen.value = false;
  emit('action', id);
}

defineExpose({ focus: () => input.value?.focus() });
</script>

<template>
  <div class="composer" :class="{ compact }">
    <div class="bar">
      <button class="icon-btn shrink-0" :aria-label="voiceMode ? '切换到键盘' : '切换到语音'" @click="toggleVoice">
        <span :class="voiceMode ? 'i-lucide-keyboard' : 'i-lucide-mic'" class="text-[21px] text-ink-2" />
      </button>
      <button
        v-if="voiceMode"
        class="hold"
        :class="{ active: holding }"
        @pointerdown="pressStart"
        @pointermove="pressMove"
        @pointerup="pressEnd"
        @pointercancel="pressEnd"
      >
        {{ holding ? (cancelling ? '松开取消' : '松开发送 · 上滑取消') : '按住 说话' }}
      </button>
      <textarea
        v-else
        ref="input"
        v-model="text"
        rows="1"
        class="field"
        :placeholder="props.placeholder"
        enterkeyhint="send"
        aria-label="输入消息"
        @input="autosize"
        @keydown="onKey"
        @focus="plusOpen = false"
      />
      <button v-if="busy" class="send stop" aria-label="停止生成" @click="emit('stop')">
        <span class="i-lucide-square text-[15px]" />
      </button>
      <button v-else-if="text.trim()" class="send" aria-label="发送" @click="send">
        <span class="i-lucide-send-horizontal text-[18px]" />
      </button>
      <button v-else-if="!compact" class="icon-btn shrink-0" aria-label="更多" @click="plusOpen = !plusOpen">
        <span class="i-lucide-circle-plus text-[23px] text-ink-2 transition-transform" :class="{ 'rotate-45': plusOpen }" />
      </button>
    </div>
    <div v-if="plusOpen" class="plus">
      <button v-for="a in ACTIONS" :key="a.id" class="plus-item press" @click="act(a.id)">
        <span class="plus-icon"><span :class="a.icon" class="text-[22px]" /></span>
        <span class="text-[11.5px] text-ink-2">{{ a.label }}</span>
      </button>
    </div>
    <div v-if="holding" class="hold-overlay" :class="{ cancel: cancelling }">
      <span class="i-lucide-mic text-[34px]" />
      <span class="flex items-end gap-[3px] h-8">
        <span v-for="i in 12" :key="i" class="wave" :style="{ animationDelay: `${i * 70}ms` }" />
      </span>
      <span class="text-[13px]">{{ cancelling ? '松开手指，取消发送' : '正在听…（演示：松开后识别成文字）' }}</span>
    </div>
  </div>
</template>

<style scoped>
.composer {
  flex-shrink: 0;
  background: var(--glass-strong);
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
  border-top: 1px solid var(--glass-line);
  padding-bottom: var(--safe-bottom);
}
.bar {
  display: flex;
  align-items: flex-end;
  gap: 4px;
  padding: 8px 8px;
}
.field {
  flex: 1;
  min-width: 0;
  min-height: 40px;
  max-height: 120px;
  padding: 8px 14px;
  border: 1px solid var(--border);
  border-radius: 20px;
  background: var(--panel);
  resize: none;
  outline: none;
  line-height: 1.45;
}
.field:focus {
  border-color: var(--accent-line);
}
.hold {
  flex: 1;
  height: 40px;
  border-radius: 20px;
  background: var(--panel);
  border: 1px solid var(--border);
  font-weight: 600;
  font-size: 15px;
  user-select: none;
  -webkit-user-select: none;
  touch-action: none;
}
.hold.active {
  background: var(--accent-soft);
  border-color: var(--accent-line);
}
.send {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: var(--accent);
  color: var(--on-accent);
  flex-shrink: 0;
}
.send.stop {
  background: var(--panel-2);
  color: var(--ink);
}
.plus {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 14px 6px;
  padding: 6px 12px 16px;
}
.plus-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}
.plus-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 52px;
  height: 52px;
  border-radius: 16px;
  background: var(--panel);
  color: var(--ink);
}
.hold-overlay {
  position: absolute;
  left: 50%;
  bottom: 120px;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  width: 220px;
  padding: 18px 12px;
  border-radius: 20px;
  background: var(--glass-strong);
  border: 1px solid var(--glass-line);
  box-shadow: var(--shadow);
  color: var(--ink);
  z-index: 40;
}
.hold-overlay.cancel {
  color: var(--bad);
}
.wave {
  width: 4px;
  height: 100%;
  border-radius: 2px;
  background: currentColor;
  animation: typing 0.9s infinite;
}
.compact .bar {
  padding: 6px;
}
</style>
