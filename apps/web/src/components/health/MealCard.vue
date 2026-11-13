<script setup lang="ts">
import { MEAL_LABEL, type MealKey, type PlanMeal } from '@app/shared';
import { ref } from 'vue';

/** 计划里的一顿饭：吃什么、自己做要多久、大概多少千卡；点开看食材和做法。健康计划页和"共同的家"做饭时共用 */
const props = withDefaults(defineProps<{ meal: PlanMeal; which: MealKey | 'snack'; open?: boolean }>(), { open: false });
const expanded = ref(props.open);
</script>

<template>
  <div class="meal-card" :data-meal="which">
    <button type="button" class="head" :aria-expanded="expanded" @click="expanded = !expanded">
      <span class="slot">{{ MEAL_LABEL[which] }}</span>
      <span class="flex-1 min-w-0 text-left">
        <span class="block text-[14.5px] font-600 truncate">{{ meal.name }}</span>
        <span class="block text-[12px] text-ink-3 truncate num">
          {{ meal.cook ? `自己做${meal.minutes ? ` · 约 ${meal.minutes} 分钟` : ''}` : '不自己做' }}<template v-if="meal.kcal"> · 约 {{ meal.kcal }} 千卡</template>
        </span>
      </span>
      <span :class="expanded ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" class="text-ink-3 shrink-0" />
    </button>
    <div v-if="expanded" class="body">
      <div v-if="meal.ingredients.length" class="flex flex-wrap gap-1.5">
        <span v-for="(it, i) in meal.ingredients" :key="i" class="ing">{{ it }}</span>
      </div>
      <ol v-if="meal.steps.length" class="steps">
        <li v-for="(s, i) in meal.steps" :key="i">{{ s }}</li>
      </ol>
      <p v-if="meal.note" class="note-line"><span class="i-lucide-info text-ink-3" />{{ meal.note }}</p>
    </div>
  </div>
</template>

<style scoped>
.meal-card {
  border-radius: 16px;
  background: var(--surface);
  border: 1px solid var(--border);
  overflow: hidden;
}
.head {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 12px;
}
.slot {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 42px;
  height: 26px;
  padding: 0 8px;
  border-radius: 99px;
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: 12px;
  flex-shrink: 0;
}
.body {
  padding: 0 12px 12px;
  font-size: 13.5px;
  line-height: 1.65;
  color: var(--ink-2);
}
.ing {
  display: inline-flex;
  align-items: center;
  height: 24px;
  padding: 0 9px;
  border-radius: 99px;
  background: var(--panel);
  font-size: 12px;
}
.steps {
  margin: 8px 0 0;
  padding-left: 1.3em;
  list-style: decimal;
}
.steps li + li {
  margin-top: 3px;
}
.note-line {
  display: flex;
  gap: 6px;
  align-items: flex-start;
  margin: 6px 0 0;
}
.note-line > span:first-child {
  margin-top: 3px;
}
</style>
