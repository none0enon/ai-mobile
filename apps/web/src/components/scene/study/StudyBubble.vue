<script setup lang="ts">
import { hasMath } from '@app/shared';
import { computed } from 'vue';
import RichText from '@/components/common/RichText.vue';

/**
 * 专注画面里的半透明对话气泡。
 * - her：她说的话，挂在左上角她的任务卡下面，左上角是尖的（像从卡片里说出来）；点了去聊天接着聊（to）；
 * - me：你这边（"我卡住了"、你刚说的话），挂在右下角你的任务卡上面，右下角是尖的。
 * 在想时显示三个点；有公式时用 KaTeX 显示。
 */
const props = withDefaults(defineProps<{ side: 'her' | 'me'; text?: string; typing?: boolean; to?: string; label?: string }>(), {
  text: '',
  typing: false,
  to: undefined,
  label: undefined,
});
defineEmits<{ (e: 'click'): void }>();
const math = computed(() => !!props.text && hasMath(props.text));
</script>

<template>
  <RouterLink v-if="to" :to="to" class="bubble" :class="side" :aria-label="label">
    <span v-if="typing && !text" class="dots" aria-label="在想"><span class="typing-dot" /><span class="typing-dot" /><span class="typing-dot" /></span>
    <RichText v-else-if="math" :text="text" />
    <template v-else>{{ text }}</template>
  </RouterLink>
  <button v-else type="button" class="bubble" :class="side" :aria-label="label" @click="$emit('click')">
    <slot>
      <RichText v-if="math" :text="text" />
      <template v-else>{{ text }}</template>
    </slot>
  </button>
</template>

<style scoped>
.bubble {
  position: relative;
  display: block;
  max-width: 100%;
  max-height: 9.6em;
  overflow-y: auto;
  padding: 8px 12px;
  background: var(--veil);
  border: 1px solid var(--glass-line);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  color: var(--ink);
  font-size: 14px;
  line-height: 1.55;
  text-align: left;
  text-decoration: none;
  box-shadow: var(--shadow-sm);
  animation: rise 0.3s var(--ease) both;
  overscroll-behavior: contain;
}
.bubble.her {
  border-radius: 4px 16px 16px 16px;
}
.bubble.me {
  margin-left: auto;
  border-radius: 16px 16px 4px 16px;
}
.dots {
  display: inline-flex;
  gap: 4px;
  padding: 4px 0;
  color: var(--accent-ink);
}
</style>
