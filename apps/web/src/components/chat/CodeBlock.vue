<script setup lang="ts">
import { computed, ref } from 'vue';

/**
 * 消息中未渲染的 ``` 代码块：完整 HTML 页面默认折叠，展开可查看代码，标题旁注明未渲染的原因；
 * 普通代码默认展开
 */
const props = defineProps<{ code: string; lang: string; frontend: boolean; note?: string }>();
const open = ref(!props.frontend);
const title = computed(() => (props.frontend ? 'HTML 页面' : props.lang ? `代码 · ${props.lang}` : '代码'));
const lines = computed(() => props.code.split('\n').length);
</script>

<template>
  <div class="code-block" data-testid="code-block" :data-frontend="frontend ? '1' : undefined">
    <button type="button" class="head" :aria-expanded="open" @click.stop="open = !open">
      <span class="i-lucide-code-xml text-[15px] shrink-0" />
      <span class="font-600 shrink-0">{{ title }}</span>
      <span class="note truncate">{{ note || `${lines} 行` }}</span>
      <span class="i-lucide-chevron-down chev shrink-0" :class="{ up: open }" />
    </button>
    <pre v-if="open">{{ code }}</pre>
  </div>
</template>

<style scoped>
.code-block {
  width: 100%;
  min-width: 0;
  border-radius: 14px;
  border: 1px solid var(--border);
  background: var(--surface);
  overflow: hidden;
}
.head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-height: 36px;
  padding: 6px 12px;
  font-size: 12.5px;
  color: var(--ink-2);
  text-align: left;
}
.note {
  flex: 1;
  min-width: 0;
  color: var(--ink-3);
  font-size: 12px;
}
.chev {
  color: var(--ink-3);
  transition: transform 0.2s;
}
.chev.up {
  transform: rotate(180deg);
}
pre {
  margin: 0;
  max-height: 46vh;
  overflow: auto;
  padding: 8px 12px 10px;
  border-top: 1px solid var(--border);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 1.55;
  white-space: pre;
  color: var(--ink-2);
  -webkit-overflow-scrolling: touch;
}
</style>
