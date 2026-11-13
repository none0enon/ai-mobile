<script setup lang="ts">
import { computed } from 'vue';
import { splitEnglish } from '@/utils/text';

/** "中文（English）"：中文照常，英文原名跟在后面、淡一点（英文的店里的菜名、商品名） */
const props = defineProps<{ text: string }>();
const parts = computed(() => splitEnglish(props.text));
</script>

<template>
  <span>{{ parts.zh }}<span v-if="parts.en" class="bi-en" lang="en"> {{ parts.en }}</span></span>
</template>

<style scoped>
.bi-en {
  color: var(--ink-3);
  font-weight: 400;
  font-size: 0.88em;
}
</style>
