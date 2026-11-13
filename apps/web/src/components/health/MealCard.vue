<script setup lang="ts">
import { MEAL_LABEL, type MealKey, type PlanMeal } from '@app/shared';
import { computed, ref } from 'vue';
import BiName from '@/components/common/BiName.vue';
import { distanceText } from '@/services/maps';

/**
 * 计划里的一顿饭：吃什么、自己做要多久、大概多少千卡；点开看食材和做法。健康计划页和"共同的家"做饭时共用。
 * - 外食的那顿（接了 Google 地图时）：去附近哪家、多远、点什么，能点开 Google 地图；店名对不上附近搜到的店时写明，去之前查一下；
 * - 带便当的那顿（做饭时间是 0、提前做好带去的）：哪顿做的、怎么装、怎么热，没做成时的备案（提到附近的店能点开地图）；
 * - 英文的店里的菜名、点的东西写成"中文（英文原名）"，英文淡一点
 */
const props = withDefaults(defineProps<{ meal: PlanMeal; which: MealKey | 'snack'; open?: boolean }>(), { open: false });
const expanded = ref(props.open);
/** 对上了附近的店就用地图上的店名（模型写的大小写、简写可能不一样） */
const placeName = computed(() => props.meal.spot?.name || props.meal.place || '');
const spotLine = computed(() => {
  const s = props.meal.spot;
  if (!s) return '';
  return [s.type, typeof s.distanceKm === 'number' ? distanceText(s.distanceKm) : ''].filter(Boolean).join(' · ');
});
</script>

<template>
  <div class="meal-card" :data-meal="which">
    <button type="button" class="head" :aria-expanded="expanded" @click="expanded = !expanded">
      <span class="slot">{{ MEAL_LABEL[which] }}</span>
      <span class="flex-1 min-w-0 text-left">
        <span class="block text-[14.5px] font-600 truncate"><BiName :text="meal.name" /></span>
        <span class="block text-[12px] text-ink-3 truncate num">
          <template v-if="meal.cook">自己做{{ meal.minutes ? ` · 约 ${meal.minutes} 分钟` : '' }}</template>
          <template v-else-if="meal.bento">带便当 · 提前做好的</template>
          <template v-else-if="meal.place">外食 · {{ placeName }}<template v-if="typeof meal.spot?.distanceKm === 'number'"> · {{ distanceText(meal.spot.distanceKm) }}</template></template>
          <template v-else>不自己做</template>
          <template v-if="meal.kcal"> · 约 {{ meal.kcal }} 千卡</template>
        </span>
      </span>
      <span :class="expanded ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" class="text-ink-3 shrink-0" />
    </button>
    <div v-if="expanded" class="body">
      <p v-if="meal.bento && meal.prep" class="prep" data-testid="meal-prep">
        <span class="i-lucide-package text-accent-ink" />
        <span><b class="font-600 text-ink">便当</b>：{{ meal.prep }}</span>
      </p>
      <p v-if="meal.bento && meal.backup" class="backup" data-testid="meal-backup">
        <span class="i-lucide-life-buoy text-ink-3" />
        <span class="flex-1 min-w-0">没做成、忘了带的话：{{ meal.backup }}<template v-if="meal.backupSpot && typeof meal.backupSpot.distanceKm === 'number'">（{{ meal.backupSpot.name }} · {{ distanceText(meal.backupSpot.distanceKm) }}）</template></span>
        <a v-if="meal.backupSpot?.mapsUri" :href="meal.backupSpot.mapsUri" target="_blank" rel="noopener noreferrer" class="text-accent-ink shrink-0">地图</a>
      </p>
      <div v-if="meal.place" class="spot" data-testid="meal-place">
        <span class="i-lucide-map-pin text-accent-ink shrink-0" />
        <span class="flex-1 min-w-0">
          <span class="font-600 text-ink">{{ placeName }}</span>
          <span v-if="spotLine" class="text-ink-3 num"> · {{ spotLine }}</span>
          <span v-else-if="!meal.spot" class="block text-[12px] text-ink-3">附近搜到的店里没有这一家，去之前查一下</span>
        </span>
        <a v-if="meal.spot?.mapsUri" :href="meal.spot.mapsUri" target="_blank" rel="noopener noreferrer" class="text-accent-ink shrink-0">地图</a>
      </div>
      <div v-if="meal.order?.length" class="flex flex-wrap items-center gap-1.5" :class="{ 'mt-2': meal.place }">
        <span class="text-[12px] text-ink-3">点</span>
        <span v-for="(it, i) in meal.order" :key="i" class="ing"><BiName :text="it" /></span>
      </div>
      <div v-if="meal.ingredients.length" class="flex flex-wrap gap-1.5" :class="{ 'mt-2': meal.bento || meal.place || meal.order?.length }">
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
.prep {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 0;
  padding: 7px 10px;
  border-radius: 12px;
  background: var(--accent-soft);
}
.prep > span:first-child {
  margin-top: 4px;
  flex-shrink: 0;
}
.backup {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 8px 0 0;
  font-size: 13px;
}
.backup > span:first-child {
  margin-top: 4px;
  flex-shrink: 0;
}
.spot {
  display: flex;
  align-items: flex-start;
  gap: 6px;
}
.spot > span:first-child {
  margin-top: 4px;
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
