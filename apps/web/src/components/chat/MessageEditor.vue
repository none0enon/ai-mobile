<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue';

/**
 * 就地改一条消息的文字。Esc 取消，Ctrl / ⌘ + Enter 保存。
 * allowEmpty：消息里还有卡片（图片、歌曲……）时，文字可以删光
 */
const props = defineProps<{ text: string; mine: boolean; allowEmpty?: boolean }>();
const emit = defineEmits<{ save: [text: string]; cancel: [] }>();
const draft = ref(props.text);
const box = ref<HTMLTextAreaElement | null>(null);

/** 高度跟着内容走（超过半屏在框里滚） */
function fit() {
  const el = box.value;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight + 2}px`;
}

function save() {
  if (!draft.value.trim() && !props.allowEmpty) return;
  emit('save', draft.value);
}

onMounted(async () => {
  await nextTick();
  fit();
  box.value?.focus({ preventScroll: true });
  box.value?.closest('.editor')?.scrollIntoView({ block: 'nearest' });
});
</script>

<template>
  <div class="editor" :class="mine ? 'me' : 'ai'" data-testid="message-editor">
    <textarea
      ref="box"
      v-model="draft"
      class="box"
      rows="1"
      aria-label="改这条消息"
      @input="fit"
      @keydown.esc.prevent="emit('cancel')"
      @keydown.ctrl.enter.prevent="save"
      @keydown.meta.enter.prevent="save"
    />
    <div class="actions">
      <button type="button" class="btn" @click="emit('cancel')">取消</button>
      <button type="button" class="btn primary" :disabled="!draft.trim() && !allowEmpty" @click="save">保存</button>
    </div>
  </div>
</template>

<style scoped>
.editor {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
}
.box {
  display: block;
  width: 100%;
  max-height: 50vh;
  padding: 9px 13px;
  border-radius: 18px;
  border: 1px solid var(--accent-line);
  background: var(--bubble-ai);
  color: var(--ink);
  font-size: 16px;
  line-height: 1.6;
  outline: none;
  resize: none;
  overflow-y: auto;
}
.me .box {
  border-top-right-radius: 6px;
}
.ai .box {
  border-top-left-radius: 6px;
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}
.btn {
  height: 30px;
  padding: 0 14px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 13.5px;
}
.btn.primary {
  background: var(--accent);
  color: var(--on-accent);
  font-weight: 600;
}
.btn:disabled {
  opacity: 0.45;
}
</style>
