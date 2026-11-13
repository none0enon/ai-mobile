<script setup lang="ts">
import { MEAL_KEYS, moveAmount, weekdayOf, WEEKDAY_LABEL, type FitMove, type MealKey } from '@app/shared';
import { showToast } from 'vant';
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import ErrorDetails from '@/components/common/ErrorDetails.vue';
import Segmented from '@/components/common/Segmented.vue';
import MealCard from '@/components/health/MealCard.vue';
import MoveHow from '@/components/health/MoveHow.vue';
import PageHeader from '@/layouts/PageHeader.vue';
import { useAiStore } from '@/stores/ai';
import { useHealthStore, workoutLine } from '@/stores/health';
import { usePersonaStore } from '@/stores/personas';
import { listTime } from '@/utils/time';

/**
 * 我的 → 健康计划（设计文档 §9.13）：按默认人设的健康设置，「健康计划」用「健康」预设排的这周和今天的计划。
 * - 今天：练什么（热身、动作、拉伸；复杂的动作点开看怎么做，大白话）、三顿饭（自己做的点开看食材和做法）、一句提醒；"开始今天的健身"去"健身"照着练；
 * - 这周：每天练什么、多久，三餐的方向，要买的东西。
 * 第一次打开今天、这周还没排时自动排一次（接通了「健康计划」时）；之后手动"重新排"。
 */
const router = useRouter();
const personas = usePersonaStore();
const health = useHealthStore();
const ai = useAiStore();
const persona = computed(() => personas.defaultPersona);
const enabled = computed(() => !!persona.value.health?.enabled);
const status = computed(() => ai.status('health'));

const tab = ref<'today' | 'week'>('today');
const TABS = [
  { value: 'today' as const, label: '今天', icon: 'i-lucide-calendar-check' },
  { value: 'week' as const, label: '这周', icon: 'i-lucide-calendar-range' },
];

const day = computed(() => health.dayOf(persona.value.id));
const week = computed(() => health.weekOf(persona.value.id));
const busy = computed(() => health.busy[persona.value.id]);
const error = computed(() => health.errors[persona.value.id]);
const todayWd = computed(() => weekdayOf(health.today()));
const recent = computed(() => health.logsOf(persona.value.id).slice(0, 5));

async function planToday(force = false) {
  const r = await health.planDay(persona.value, { force });
  if (r.ok && force) showToast('今天的计划重新排好了');
}
async function planWeek(force = false) {
  const r = await health.planWeek(persona.value, { force });
  if (r.ok && force) showToast('这周的计划重新排好了');
}

/** 点开看怎么做的动作 */
const openMove = ref<string | null>(null);
function moveKey(group: string, i: number) {
  return `${group}:${i}`;
}
const groups = computed(() => {
  const w = day.value?.workout;
  if (!w) return [];
  return [
    { id: 'warmup', label: '热身', moves: w.warmup },
    { id: 'items', label: '动作', moves: w.items },
    { id: 'cooldown', label: '拉伸放松', moves: w.cooldown },
  ].filter((g) => g.moves.length);
});
function hasMore(m: FitMove) {
  return m.how.length > 0 || !!m.tips || !!m.easier;
}
const meals = computed(() => (day.value ? [...MEAL_KEYS, 'snack' as const].filter((k) => day.value!.meals[k]).map((k) => ({ key: k as MealKey | 'snack', meal: day.value!.meals[k]! })) : []));

onMounted(() => {
  // 今天还没排、接通了：自动排一次（这周没排的会先排这周）
  if (enabled.value && status.value.live && !day.value && !busy.value) void planToday();
});
</script>

<template>
  <div class="page" data-page="health-plan">
    <PageHeader title="健康计划" :subtitle="`${persona.name} · 按健康系统的设置排`" fallback="/me">
      <template #right>
        <RouterLink :to="`/me/personas/${persona.id}/health`" class="icon-btn" aria-label="健康系统设置"><span class="i-lucide-settings-2 text-[20px]" /></RouterLink>
      </template>
    </PageHeader>
    <div class="page-scroll pb-8">
      <div v-if="!enabled" class="mx-4 mt-4 card-box text-center">
        <span class="i-lucide-heart-pulse text-[34px] text-accent-ink" />
        <div class="text-[15px] font-600 mt-2">健康系统还没打开</div>
        <p class="text-[13px] text-ink-3 leading-relaxed mt-1 mb-3">在人设里打开健康系统，填上身高体重、目标、能练的方式和时间、家里的食材和厨具，这里就按它排这周和今天的健身、饮食计划。</p>
        <van-button type="primary" round size="small" data-testid="open-health" @click="router.push(`/me/personas/${persona.id}/health`)">去打开</van-button>
      </div>

      <template v-else>
        <div v-if="!status.live" class="notice mx-4 mt-3">
          <span class="i-lucide-plug-zap shrink-0" />
          <span class="flex-1 min-w-0">「健康计划」还没接通：{{ status.reason }}</span>
          <RouterLink to="/me/api?feature=health" class="text-accent-ink shrink-0">去设置</RouterLink>
        </div>
        <div v-if="error && !busy" class="mx-4 mt-3">
          <ErrorDetails :detail="error.detail || error.reason" :title="`没排出来：${error.reason}`" max-height="160px" />
        </div>
        <div class="px-4 pt-3"><Segmented v-model="tab" :options="TABS" /></div>

        <!-- 今天 -->
        <template v-if="tab === 'today'">
          <div v-if="!day" class="mx-4 mt-3 card-box text-center">
            <div class="text-[14.5px] font-600">今天的计划还没排</div>
            <p class="text-[12.5px] text-ink-3 mt-1 mb-3">{{ week ? '照这周的计划排今天的动作和三顿饭' : '先排这周，再排今天（要一点时间）' }}</p>
            <van-button type="primary" round size="small" :loading="!!busy" :loading-text="busy === 'week' ? '在排这周…' : '在排今天…'" :disabled="!status.live" data-testid="plan-today" @click="planToday()">排今天的计划</van-button>
          </div>
          <template v-else>
            <div class="group-title">练什么</div>
            <div v-if="day.rest || !day.workout" class="mx-4 card-box flex items-center gap-3">
              <span class="i-lucide-bed text-[22px] text-accent-ink" />
              <div class="flex-1 text-[14px]">今天休息，走走路、拉伸一下就好</div>
            </div>
            <div v-else class="mx-4 card-box" data-testid="today-workout">
              <div class="flex items-start gap-2">
                <div class="flex-1 min-w-0">
                  <div class="text-[16px] font-700">{{ day.workout.title }}</div>
                  <div class="text-[12.5px] text-ink-3 mt-0.5 num">{{ day.workout.minutes }} 分钟<template v-if="day.workout.intensity"> · {{ day.workout.intensity }}</template> · {{ day.workout.items.length }} 个动作</div>
                </div>
                <van-button type="primary" round size="small" data-testid="start-plan" @click="router.push('/scene/exercise?mode=plan')">开始</van-button>
              </div>
              <template v-for="g in groups" :key="g.id">
                <div class="text-[12.5px] text-ink-3 mt-3 mb-1">{{ g.label }}</div>
                <div v-for="(m, i) in g.moves" :key="i" class="move">
                  <button type="button" class="move-head" :aria-expanded="openMove === moveKey(g.id, i)" @click="openMove = openMove === moveKey(g.id, i) ? null : moveKey(g.id, i)">
                    <span class="flex-1 min-w-0 text-left">
                      <span class="text-[14.5px]">{{ m.name }}</span>
                      <span v-if="moveAmount(m)" class="text-[12.5px] text-ink-3 num"> · {{ moveAmount(m) }}</span>
                      <span v-if="m.rest && m.sets > 1" class="text-[12px] text-ink-3 num"> · 组间歇 {{ m.rest }} 秒</span>
                    </span>
                    <span v-if="hasMore(m)" class="how-tag">{{ openMove === moveKey(g.id, i) ? '收起' : '怎么做' }}</span>
                  </button>
                  <MoveHow v-if="openMove === moveKey(g.id, i)" :move="m" class="pb-2.5 px-0.5" />
                </div>
              </template>
            </div>

            <template v-if="meals.length">
              <div class="group-title">吃什么</div>
              <div class="px-4 grid gap-2">
                <MealCard v-for="m in meals" :key="m.key" :meal="m.meal" :which="m.key" />
              </div>
            </template>
            <p v-if="day.tips" class="tips mx-4 mt-3"><span class="i-lucide-lightbulb text-accent-ink" />{{ day.tips }}</p>
            <div class="flex items-center gap-2 mx-4 mt-3 text-[12px] text-ink-3">
              <span class="flex-1 min-w-0 truncate">{{ day.model }} · {{ listTime(day.at) }}排的</span>
              <button class="text-accent-ink shrink-0" :disabled="!!busy || !status.live" @click="planToday(true)">{{ busy === 'day' ? '在排…' : '重新排今天' }}</button>
            </div>
          </template>
        </template>

        <!-- 这周 -->
        <template v-else>
          <div v-if="!week" class="mx-4 mt-3 card-box text-center">
            <div class="text-[14.5px] font-600">这周的计划还没排</div>
            <p class="text-[12.5px] text-ink-3 mt-1 mb-3">每天练什么、练多久，三餐的方向，这周要买的东西</p>
            <van-button type="primary" round size="small" :loading="busy === 'week'" loading-text="在排这周…" :disabled="!status.live || !!busy" data-testid="plan-week" @click="planWeek()">排这周的计划</van-button>
          </div>
          <template v-else>
            <p v-if="week.focus" class="tips mx-4 mt-3"><span class="i-lucide-target text-accent-ink" />{{ week.focus }}</p>
            <div class="px-4 mt-3 grid gap-2">
              <div v-for="d in week.days" :key="d.weekday" class="week-row" :class="{ today: d.weekday === todayWd, rest: d.rest }">
                <span class="wd">{{ WEEKDAY_LABEL[d.weekday] }}</span>
                <div class="flex-1 min-w-0">
                  <div class="text-[14px]">{{ d.rest ? '休息' : d.workout }}<span v-if="!d.rest && d.minutes" class="text-ink-3 text-[12.5px] num"> · {{ d.minutes }} 分钟</span></div>
                  <div v-if="d.meals" class="text-[12px] text-ink-3 leading-relaxed mt-0.5">{{ d.meals }}</div>
                </div>
              </div>
            </div>
            <template v-if="week.shopping.length">
              <div class="group-title">这周要买的</div>
              <div class="px-4 flex flex-wrap gap-1.5">
                <span v-for="(s, i) in week.shopping" :key="i" class="tag !h-[26px] !px-2.5 !text-[12.5px]">{{ s }}</span>
              </div>
            </template>
            <p v-for="(t, i) in week.tips" :key="i" class="tips mx-4 mt-2"><span class="i-lucide-lightbulb text-accent-ink" />{{ t }}</p>
            <div class="flex items-center gap-2 mx-4 mt-3 text-[12px] text-ink-3">
              <span class="flex-1 min-w-0 truncate">{{ week.weekStart }} 开始 · {{ week.model }}</span>
              <button class="text-accent-ink shrink-0" :disabled="!!busy || !status.live" @click="planWeek(true)">{{ busy === 'week' ? '在排…' : '重新排这周' }}</button>
            </div>
          </template>
        </template>

        <template v-if="recent.length">
          <div class="group-title">最近练的</div>
          <div class="px-4 grid gap-1.5">
            <div v-for="l in recent" :key="l.id" class="text-[13px] text-ink-2 num">{{ workoutLine(l) }}</div>
          </div>
        </template>
        <p class="note">排计划用的提示词在<RouterLink to="/me/presets?cat=health" class="text-accent-ink">我的 → 预设 → 健康</RouterLink>里，能改（比如动作讲得再细一点）。计划只是参考：身体不舒服就停下来。</p>
      </template>
    </div>
  </div>
</template>

<style scoped>
.card-box {
  padding: 14px;
  border-radius: 18px;
  background: var(--surface);
  border: 1px solid var(--border);
}
.notice {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 12px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 12.5px;
}
.move {
  border-top: 1px solid var(--border);
}
.move-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 9px 2px;
}
.how-tag {
  flex-shrink: 0;
  height: 24px;
  padding: 0 9px;
  border-radius: 99px;
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: 12px;
  line-height: 24px;
}
.tips {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin-bottom: 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--ink-2);
}
.tips > span:first-child {
  margin-top: 3px;
  flex-shrink: 0;
}
.week-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 14px;
  background: var(--surface);
  border: 1px solid var(--border);
}
.week-row.today {
  border-color: var(--accent-line);
  background: var(--accent-soft);
}
.week-row.rest {
  opacity: 0.75;
}
.wd {
  width: 34px;
  flex-shrink: 0;
  font-size: 13px;
  color: var(--ink-2);
  padding-top: 1px;
}
</style>
