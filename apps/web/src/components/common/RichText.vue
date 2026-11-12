<script setup lang="ts">
import { hasMath } from '@app/shared';
import { computed, watchEffect } from 'vue';
import { katexLib, loadKatex, richHtml } from '@/utils/math';

/**
 * 带公式的文字（$…$、$$…$$ 用 KaTeX 显示）。
 * block：一段书的正文，认标题、列表、表格；actions：聊天气泡，（动作）*动作* 淡一点显示。
 * 文字都先转义再拼 HTML，公式交给 KaTeX（不信任输入，\href 之类的命令不生效）。
 */
const props = withDefaults(defineProps<{ text: string; block?: boolean; actions?: boolean }>(), { block: false, actions: false });

const math = computed(() => hasMath(props.text));
watchEffect(() => {
  if (math.value && !katexLib.value) void loadKatex();
});
const html = computed(() => richHtml(props.text, katexLib.value, { block: props.block, actions: props.actions }));
</script>

<template>
  <div v-if="block" class="rich" v-html="html" />
  <span v-else class="rich" v-html="html" />
</template>
