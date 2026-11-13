<script setup lang="ts">
import type { FitMove } from '@app/shared';

/** 一个动作怎么做：一步一步（大白话）、最要注意的一点、做不动时怎么做。健康计划页和"健身"里共用 */
defineProps<{ move: FitMove }>();
</script>

<template>
  <div class="move-how">
    <ol v-if="move.how.length" class="steps">
      <li v-for="(s, i) in move.how" :key="i">{{ s }}</li>
    </ol>
    <p v-if="move.tips" class="line"><span class="i-lucide-lightbulb text-accent-ink" />{{ move.tips }}</p>
    <p v-if="move.easier" class="line"><span class="i-lucide-feather text-ink-3" />做不动的话：{{ move.easier }}</p>
    <p v-if="!move.how.length && !move.tips && !move.easier" class="line text-ink-3">这个动作比较简单，照着名字做就行。</p>
  </div>
</template>

<style scoped>
.move-how {
  font-size: 13.5px;
  line-height: 1.65;
  color: var(--ink-2);
}
.steps {
  margin: 0;
  padding-left: 1.3em;
  list-style: decimal;
}
.steps li + li {
  margin-top: 3px;
}
.line {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 6px 0 0;
}
.line > span:first-child {
  margin-top: 3px;
}
</style>
