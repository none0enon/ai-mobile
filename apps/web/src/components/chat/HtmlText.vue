<script setup lang="ts">
import { hasMath } from '@app/shared';
import { ref, watchEffect } from 'vue';
import { safeHtmlFragment } from '@/utils/html';
import { katexLib, loadKatex, richHtml } from '@/utils/math';

/**
 * 气泡中带 HTML 的文字（消息设置开启 HTML 渲染时）：标签按白名单重新建（utils/html.ts），
 * 标签外面的字照聊天气泡的样子：（动作）*动作* 淡一点、**加粗**、公式用 KaTeX
 */
const props = defineProps<{ text: string; /** 流式时末尾的光标 */ caret?: boolean }>();
const root = ref<HTMLElement | null>(null);

watchEffect(() => {
  if (hasMath(props.text) && !katexLib.value) void loadKatex();
});
watchEffect(() => {
  const el = root.value;
  if (!el) return;
  const k = katexLib.value;
  el.replaceChildren(safeHtmlFragment(props.text, (t) => richHtml(t, k, { actions: true })));
});
</script>

<template>
  <div ref="root" class="html-body rich" :class="{ 'stream-caret': caret }" />
</template>

<style scoped>
/* 换行已经变成 <br>：标签之间的缩进、换行按网页的规矩合并（同 ST 里的 HTML） */
.html-body {
  position: relative;
  overflow: hidden;
  max-width: 100%;
  white-space: normal;
}
.html-body :deep(details) {
  margin: 2px 0;
}
.html-body :deep(details[open]) {
  padding-left: 10px;
  border-left: 2px solid var(--border);
}
.html-body :deep(summary) {
  cursor: pointer;
  font-size: 0.88em;
  opacity: 0.6;
}
.html-body :deep(details[open] > summary) {
  margin-bottom: 4px;
}
.html-body :deep(p) {
  margin: 0.3em 0;
}
.html-body :deep(blockquote) {
  margin: 0.4em 0;
  padding-left: 10px;
  border-left: 3px solid var(--border);
  opacity: 0.85;
}
.html-body :deep(pre) {
  margin: 0.4em 0;
  padding: 8px 10px;
  border-radius: 10px;
  background: var(--panel);
  overflow-x: auto;
  font-size: 0.86em;
  white-space: pre;
}
.html-body :deep(code) {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.9em;
}
.html-body :deep(table) {
  display: block;
  max-width: 100%;
  overflow-x: auto;
  border-collapse: collapse;
  margin: 0.4em 0;
}
.html-body :deep(td),
.html-body :deep(th) {
  padding: 3px 8px;
  border: 1px solid var(--border);
}
.html-body :deep(img) {
  max-width: 100%;
  height: auto;
  border-radius: 10px;
}
.html-body :deep(hr) {
  border: 0;
  border-top: 1px solid var(--border);
  margin: 0.6em 0;
}
.html-body :deep(ul),
.html-body :deep(ol) {
  margin: 0.3em 0;
  padding-left: 1.4em;
}
.html-body :deep(h1),
.html-body :deep(h2),
.html-body :deep(h3),
.html-body :deep(h4),
.html-body :deep(h5),
.html-body :deep(h6) {
  margin: 0.4em 0 0.2em;
  font-size: 1.05em;
  line-height: 1.4;
}
.html-body :deep(a) {
  color: var(--accent-ink);
}
</style>
