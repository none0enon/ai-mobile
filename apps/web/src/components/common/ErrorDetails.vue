<script setup lang="ts">
import { copyWithToast } from '@/utils/errors';

/**
 * 完整报错：服务商返回的原文、请求地址、状态码……原样显示（不截断），可以滚动、可以复制。
 * detail 的第一行是一句话的原因，加粗显示。
 */
const props = withDefaults(defineProps<{ detail: string; title?: string; maxHeight?: string }>(), { title: '完整报错', maxHeight: '45vh' });

const firstBreak = () => props.detail.indexOf('\n');
const head = () => (firstBreak() < 0 ? props.detail : props.detail.slice(0, firstBreak()));
const rest = () => (firstBreak() < 0 ? '' : props.detail.slice(firstBreak() + 1).replace(/^\n+/, ''));
</script>

<template>
  <div class="err-box" role="alert">
    <div class="err-top">
      <span class="i-lucide-circle-alert shrink-0" />
      <span class="flex-1 min-w-0">{{ title }}</span>
      <button type="button" class="err-copy" @click.stop="copyWithToast(detail)"><span class="i-lucide-copy" />复制</button>
    </div>
    <div class="err-scroll" :style="{ maxHeight }">
      <div class="err-head">{{ head() }}</div>
      <pre v-if="rest()" class="err-rest">{{ rest() }}</pre>
    </div>
  </div>
</template>

<style scoped>
.err-box {
  margin-top: 10px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--bad) 9%, var(--panel));
  border: 1px solid color-mix(in srgb, var(--bad) 30%, transparent);
  overflow: hidden;
}
.err-top {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px 6px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--bad);
}
.err-copy {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex-shrink: 0;
  height: 24px;
  padding: 0 8px;
  border-radius: 99px;
  background: var(--surface);
  color: var(--ink-2);
  font-size: 12px;
  font-weight: 500;
}
.err-scroll {
  overflow: auto;
  padding: 0 10px 10px;
  -webkit-overflow-scrolling: touch;
}
.err-head {
  font-size: 13px;
  line-height: 1.55;
  color: var(--bad);
  white-space: pre-wrap;
  word-break: break-word;
}
.err-rest {
  margin: 6px 0 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--ink-2);
  white-space: pre-wrap;
  word-break: break-all;
  user-select: text;
  -webkit-user-select: text;
}
</style>
