<script setup lang="ts">
import { SCENES, timeOfDay, type SceneId } from '@app/shared';
import { computed, ref } from 'vue';
import Avatar from '@/components/common/Avatar.vue';
import CharacterFigure from '@/components/figure/CharacterFigure.vue';
import SceneBackdrop from '@/components/figure/SceneBackdrop.vue';
import { FIGURE } from '@/mock/characters';
import { mockToday, weather } from '@/mock/activity';
import { useAppStore } from '@/stores/app';
import { useCharacterStore } from '@/stores/characters';
import { hhmm } from '@/utils/time';

const app = useAppStore();
const chars = useCharacterStore();
const character = computed(() => chars.byId(app.activeCharacterId) ?? chars.list[0]!);
const figure = computed(() => FIGURE[character.value.id] ?? { hairStyle: 'long' as const, eye: '#3b2531' });
const today = mockToday();
const now = new Date();
const tod = timeOfDay(now.getHours());

/** 按此刻的时段给一个建议，就像她会主动提议的那样 */
const SUGGEST: Record<string, { scene: SceneId; quote: string; cta: string; expr: string }> = {
  dawn: { scene: 'exercise', quote: '早上空气好好，一起去跑两圈？', cta: '去晨跑', expr: 'smile' },
  morning: { scene: 'meal', quote: '早饭吃了没？我陪你吃。', cta: '一起吃早饭', expr: 'smile' },
  noon: { scene: 'meal', quote: '到饭点啦……我有点饿了。', cta: '一起吃午饭', expr: 'shy' },
  afternoon: { scene: 'study', quote: '下午一起自习吧，我给你占了座。', cta: '去陪伴学习', expr: 'smile' },
  dusk: { scene: 'meal', quote: '晚饭想吃什么？我请客～', cta: '一起吃晚饭', expr: 'laugh' },
  night: { scene: 'music', quote: '下雨天，一起听首歌吗？', cta: '一起听歌', expr: 'blush' },
  late: { scene: 'sleep', quote: '已经很晚了……早点躺下，我给你讲故事？', cta: '去哄睡', expr: 'sleepy' },
};
const suggest = SUGGEST[tod] ?? SUGGEST.night!;
const suggestScene = SCENES.find((s) => s.id === suggest.scene)!;

const status = computed<Record<string, string>>(() => ({
  exercise: `今天 ${today.steps.toLocaleString('zh-CN')} 步${today.workout ? ` · 跑了 ${today.workout.distanceKm} 公里` : ''}`,
  meal: today.meals.dinner ? '三餐都吃啦' : today.meals.lunch ? '晚饭还没吃' : today.meals.breakfast ? '午饭还没吃' : '早饭还没吃',
  study: `今天 ${today.studyMin} 分钟 · ${today.pomodoros} 个番茄`,
  sleep: `昨晚 ${today.lastSleep.bed} 睡 · ${today.lastSleep.hours} 小时`,
  music: `上次一起听《${today.lastSong}》`,
  date: '约好周六 · 水族馆',
  poke: `好感 ${character.value.relationship.affection}`,
}));

const switcherOpen = ref(false);
const switchActions = computed(() => chars.list.map((c) => ({ name: c.name, subname: c.status, id: c.id })));
</script>

<template>
  <div class="page" data-page="together">
    <header class="gutter pt-[calc(var(--safe-top)+14px)] pb-2 flex items-center gap-2">
      <h1 class="m-0 text-[28px] font-700">一起</h1>
      <button class="switcher press ml-auto" @click="switcherOpen = true">
        <Avatar :character="character" :size="28" live />
        <span class="text-[14px]">{{ character.name }}</span>
        <span class="i-lucide-chevron-down text-ink-3" />
      </button>
    </header>

    <div class="page-scroll pb-6">
      <!-- 此刻的建议 -->
      <RouterLink :to="`/scene/${suggest.scene}`" class="now mx-4 press">
        <SceneBackdrop :kind="suggestScene.backdrop" :tod="tod" :rain="weather.text.includes('雨')" />
        <div class="now-figure">
          <CharacterFigure
            :accent="character.accent"
            :hair="character.hairColor"
            :eye="figure.eye"
            :hair-style="figure.hairStyle"
            :expression="suggest.expr"
            :outfit="suggestScene.outfit"
            crop="full"
          />
        </div>
        <div class="now-body">
          <span class="now-chip num"><span :class="weather.icon" />{{ hhmm(now.getTime()) }} · {{ weather.text }} {{ weather.tempC }}°</span>
          <p class="now-quote text-balance">「{{ suggest.quote }}」</p>
          <span class="now-cta">{{ suggest.cta }}<span class="i-lucide-chevron-right" /></span>
        </div>
      </RouterLink>

      <div class="section-title">陪伴场景</div>
      <div class="grid grid-cols-2 gap-2.5 px-4">
        <RouterLink v-for="s in SCENES" :key="s.id" :to="`/scene/${s.id}`" class="scene-card press" :style="{ '--tone': s.tint }">
          <span class="scene-icon"><span :class="s.icon" /></span>
          <span class="text-[15px] font-600">{{ s.name }}</span>
          <span class="text-[12px] text-ink-3 truncate w-full">{{ status[s.id] }}</span>
        </RouterLink>
        <RouterLink :to="`/call/${character.id}`" class="scene-card press" style="--tone: #8db8ff">
          <span class="scene-icon"><span class="i-lucide-phone" /></span>
          <span class="text-[15px] font-600">语音通话</span>
          <span class="text-[12px] text-ink-3 truncate w-full">上次 12:03 · 哄睡</span>
        </RouterLink>
      </div>

      <div class="section-title">今天的你</div>
      <div class="grid grid-cols-4 gap-2 px-4">
        <div class="stat"><span class="i-lucide-footprints" /><b class="num">{{ (today.steps / 1000).toFixed(1) }}k</b><small>步数</small></div>
        <div class="stat"><span class="i-lucide-utensils" /><b>{{ ['breakfast', 'lunch', 'dinner'].filter((k) => today.meals[k as 'lunch']).length }}/3</b><small>三餐</small></div>
        <div class="stat"><span class="i-lucide-book-open" /><b class="num">{{ today.studyMin }}′</b><small>学习</small></div>
        <div class="stat"><span class="i-lucide-moon-star" /><b class="num">{{ today.lastSleep.hours }}h</b><small>睡眠</small></div>
      </div>
      <p class="text-center text-[12px] text-ink-3 mt-5 px-6">场景也能在聊天里从 ＋ 面板直接打开；她会根据这些数据主动找你</p>
    </div>

    <van-action-sheet
      v-model:show="switcherOpen"
      :actions="switchActions"
      cancel-text="取消"
      description="现在陪着你的是"
      close-on-click-action
      @select="(a: { id: string }) => (app.activeCharacterId = a.id)"
    />
  </div>
</template>

<style scoped>
.switcher {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 38px;
  padding: 0 10px 0 5px;
  border-radius: 99px;
  background: var(--surface);
  border: 1px solid var(--border);
}
.now {
  position: relative;
  display: block;
  height: 210px;
  border-radius: 26px;
  overflow: hidden;
  color: #fff;
  text-decoration: none;
  isolation: isolate;
}
.now-figure {
  position: absolute;
  right: -6%;
  bottom: -46%;
  width: 52%;
  aspect-ratio: 600 / 1000;
}
.now-body {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  padding: 16px;
  max-width: 64%;
  gap: 8px;
}
.now-chip {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 9px;
  border-radius: 99px;
  background: rgba(10, 6, 20, 0.45);
  font-size: 12px;
}
.now-quote {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
  line-height: 1.45;
  text-shadow: 0 2px 12px rgba(0, 0, 0, 0.45);
}
.now-cta {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  height: 34px;
  padding: 0 12px 0 14px;
  border-radius: 99px;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 14px;
  font-weight: 600;
}
.section-title {
  padding: 20px 16px 10px;
  font-size: 13px;
  color: var(--ink-3);
  letter-spacing: 0.04em;
}
.scene-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  min-width: 0;
  padding: 14px;
  border-radius: 20px;
  background: var(--surface);
  border: 1px solid var(--border);
  color: inherit;
  text-decoration: none;
}
.scene-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  margin-bottom: 6px;
  border-radius: 13px;
  background: color-mix(in srgb, var(--tone) 20%, transparent);
  color: var(--tone);
  font-size: 20px;
}
@supports not (background: color-mix(in srgb, red 10%, transparent)) {
  .scene-icon {
    background: var(--panel);
  }
}
.stat {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 12px 4px;
  border-radius: 16px;
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--accent-ink);
}
.stat b {
  color: var(--ink);
  font-size: 16px;
}
.stat small {
  color: var(--ink-3);
  font-size: 11.5px;
}
</style>
