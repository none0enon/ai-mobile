<script setup lang="ts">
import { CHORE_WHEN, MEAL_KEYS, moveAmount, weekdayOf, WEEKDAY_LABEL, type FitMove, type MealKey, type MealSpot, type ShoppingItem } from '@app/shared';
import { showToast } from 'vant';
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import BiName from '@/components/common/BiName.vue';
import ErrorDetails from '@/components/common/ErrorDetails.vue';
import Segmented from '@/components/common/Segmented.vue';
import MealCard from '@/components/health/MealCard.vue';
import MoveHow from '@/components/health/MoveHow.vue';
import PageHeader from '@/layouts/PageHeader.vue';
import { distanceText } from '@/services/maps';
import { useAiStore } from '@/stores/ai';
import { useHealthStore, workoutLine } from '@/stores/health';
import { usePersonaStore } from '@/stores/personas';
import { useServicesStore } from '@/stores/services';
import { copyText } from '@/utils/errors';
import { nearbyStoreFor, searchLinkFor } from '@/utils/shopping';
import { listTime } from '@/utils/time';

/**
 * 我的 → 健康计划（设计文档 §9.13）：按默认人设的健康设置，「健康计划」用「健康」预设排的这周和今天的计划。
 * - 今天：练什么（热身、动作、拉伸；复杂的动作点开看怎么做，大白话）、三顿饭（自己做的点开看食材和做法）、一句提醒；"开始今天的健身"去"健身"照着练；
 * - 这周：每天练什么、多久，三餐的方向，要买的东西（按在哪买分组：网店点了在它网站上搜，附近的超市能点开地图）。
 * 接了 Google 地图时，外食是附近真实的店，要买的东西按附近超市和网店真能买到的写（stores/health.ts）。
 * 要提前做的（便当、隔夜燕麦）列在"要提前做的"：开了家务系统就发到"共同的家"今天的家务里，这里看得到做没做，每件带备案。
 * 第一次打开今天、这周还没排时自动排一次（接通了「健康计划」时）；之后手动"重新排"。
 */
const router = useRouter();
const personas = usePersonaStore();
const health = useHealthStore();
const ai = useAiStore();
const persona = computed(() => personas.defaultPersona);
const enabled = computed(() => !!persona.value.health?.enabled);
const status = computed(() => ai.status('health'));
const svc = useServicesStore();
/** 想参考附近的店、但还没接 Google 地图：提示一句 */
const mapsHint = computed(() => persona.value.health?.nearby !== false && !svc.mapsReady);

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

/** 要提前做的：在家务里做没做 */
const PREP_STATE = { off: '没发到家务', todo: '还没做', doing: '正在做', later: '拖着', done: '做完了' } as const;
const houseworkOn = computed(() => !!persona.value.housework?.enabled);
const prepList = computed(() => (day.value?.prep ?? []).map((t) => ({ t, state: health.prepState(persona.value, t) })));

/** 要买的东西按"在哪买"分组：附近的超市带距离和地图，每一样带去哪搜的链接；没写在哪买的放最后 */
interface ShopGroup {
  where: string;
  store?: MealSpot;
  items: (ShoppingItem & { link: { label: string; url: string } | null })[];
}
const shoppingGroups = computed<ShopGroup[]>(() => {
  const w = week.value;
  if (!w) return [];
  const groups = new Map<string, ShopGroup>();
  for (const it of w.shopping) {
    const where = it.where.trim();
    const key = where.toLowerCase();
    let g = groups.get(key);
    if (!g) {
      g = { where, store: nearbyStoreFor(where, w.stores), items: [] };
      groups.set(key, g);
    }
    g.items.push({ ...it, link: searchLinkFor(it, w.country) });
  }
  return [...groups.values()].sort((a, b) => Number(!a.where) - Number(!b.where));
});
async function copyShopping() {
  const text = shoppingGroups.value
    .map((g) => [g.where ? `【${g.where}】` : '', ...g.items.map((it) => `- ${it.name}${it.amount ? ` ${it.amount}` : ''}`)].filter(Boolean).join('\n'))
    .join('\n\n');
  showToast((await copyText(text)) ? '清单复制好了' : '复制不了，长按文字手动复制');
}

onMounted(() => {
  // 今天还没排、接通了：自动排一次（这周没排的会先排这周）
  if (enabled.value && status.value.live && !day.value && !busy.value) void planToday();
  // 排的时候家务系统还没开的：开了以后把要提前做的补发过去
  health.syncPrep(persona.value);
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
        <div v-if="mapsHint" class="notice mx-4 mt-3" data-testid="maps-hint">
          <span class="i-lucide-map-pinned shrink-0" />
          <span class="flex-1 min-w-0">接上 Google 地图后，外食从附近真实的店里挑，要买的东西按附近超市和网店（Amazon、Kroger……）真能买到的写</span>
          <RouterLink to="/me/services" class="text-accent-ink shrink-0">去接</RouterLink>
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
            <template v-if="prepList.length">
              <div class="group-title">要提前做的</div>
              <div class="px-4 grid gap-2" data-testid="prep-list">
                <div v-for="({ t, state }, i) in prepList" :key="i" class="prep-card">
                  <div class="flex items-start gap-2.5">
                    <span :class="CHORE_WHEN[t.when].icon" class="text-accent-ink text-[18px] mt-0.5 shrink-0" />
                    <div class="flex-1 min-w-0">
                      <div class="text-[14.5px] font-600">{{ t.name }}</div>
                      <div class="text-[12px] text-ink-3 num">{{ CHORE_WHEN[t.when].label }} · 约 {{ t.minutes }} 分钟<template v-if="t.meal"> · 给{{ t.meal }}</template></div>
                    </div>
                    <span class="prep-state" :class="state">{{ PREP_STATE[state] }}</span>
                  </div>
                  <ol v-if="t.steps.length" class="prep-steps">
                    <li v-for="(x, j) in t.steps" :key="j">{{ x }}</li>
                  </ol>
                  <p v-if="t.backup" class="prep-backup">
                    <span class="i-lucide-life-buoy text-ink-3" />
                    <span class="flex-1 min-w-0">没来得及做：{{ t.backup }}<template v-if="t.backupSpot && typeof t.backupSpot.distanceKm === 'number'">（{{ t.backupSpot.name }} · {{ distanceText(t.backupSpot.distanceKm) }}）</template></span>
                    <a v-if="t.backupSpot?.mapsUri" :href="t.backupSpot.mapsUri" target="_blank" rel="noopener noreferrer" class="text-accent-ink shrink-0">地图</a>
                  </p>
                </div>
                <p class="text-[12px] text-ink-3 leading-relaxed m-0">
                  <template v-if="houseworkOn">已经发到"共同的家"今天的家务里，做完在那边打勾；没做的话明天按备案排。</template>
                  <template v-else>打开家务系统后，这些会发到"共同的家"提醒你。<RouterLink :to="`/me/personas/${persona.id}/housework`" class="text-accent-ink">去打开</RouterLink></template>
                </p>
              </div>
            </template>
            <p v-if="day.tips" class="tips mx-4 mt-3"><span class="i-lucide-lightbulb text-accent-ink" />{{ day.tips }}</p>
            <p v-if="day.near" class="near mx-4 mt-3" data-testid="day-near"><span class="i-lucide-map-pin" />{{ day.near }}</p>
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
              <div class="group-title">
                这周要买的
                <button type="button" class="action" data-testid="copy-shopping" @click="copyShopping">复制清单</button>
              </div>
              <div class="px-4 grid gap-2" data-testid="shopping">
                <div v-for="g in shoppingGroups" :key="g.where" class="shop-group">
                  <div v-if="g.where || shoppingGroups.length > 1" class="shop-head">
                    <span :class="g.store ? 'i-lucide-store' : g.where ? 'i-lucide-shopping-cart' : 'i-lucide-list'" class="text-accent-ink shrink-0" />
                    <span class="flex-1 min-w-0 truncate">
                      {{ g.where || '其他' }}<span v-if="typeof g.store?.distanceKm === 'number'" class="text-ink-3 text-[12px] font-400 num"> · {{ distanceText(g.store.distanceKm) }}</span>
                    </span>
                    <a v-if="g.store?.mapsUri" :href="g.store.mapsUri" target="_blank" rel="noopener noreferrer" class="text-accent-ink text-[12.5px] font-400 shrink-0">地图</a>
                  </div>
                  <div v-for="(it, i) in g.items" :key="i" class="shop-item">
                    <span class="flex-1 min-w-0">
                      <BiName class="text-[14px]" :text="it.name" /><span v-if="it.amount" class="text-[12.5px] text-ink-3"> · {{ it.amount }}</span>
                      <span v-if="it.note" class="block text-[12px] text-ink-3">{{ it.note }}</span>
                    </span>
                    <a v-if="it.link" :href="it.link.url" target="_blank" rel="noopener noreferrer" class="buy" :aria-label="`${it.link.label}：${it.name}`">{{ it.link.label }}</a>
                  </div>
                </div>
              </div>
            </template>
            <p v-for="(t, i) in week.tips" :key="i" class="tips mx-4 mt-2"><span class="i-lucide-lightbulb text-accent-ink" />{{ t }}</p>
            <p v-if="week.near" class="near mx-4 mt-3" data-testid="week-near"><span class="i-lucide-map-pin" />{{ week.near }}</p>
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
.prep-card {
  padding: 12px;
  border-radius: 16px;
  background: var(--surface);
  border: 1px solid var(--border);
}
.prep-state {
  flex-shrink: 0;
  height: 22px;
  padding: 0 8px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-3);
  font-size: 11.5px;
  line-height: 22px;
}
.prep-state.done {
  background: var(--accent-soft);
  color: var(--accent-ink);
}
.prep-state.later {
  color: var(--warn, #b7791f);
}
.prep-steps {
  margin: 8px 0 0;
  padding-left: 1.3em;
  list-style: decimal;
  font-size: 13.5px;
  line-height: 1.65;
  color: var(--ink-2);
}
.prep-backup {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 8px 0 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--ink-2);
}
.prep-backup > span:first-child {
  margin-top: 4px;
  flex-shrink: 0;
}
.shop-group {
  padding: 4px 12px;
  border-radius: 14px;
  background: var(--surface);
  border: 1px solid var(--border);
}
.shop-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 0 5px;
  font-size: 13.5px;
  font-weight: 600;
}
.shop-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 0;
}
.shop-head + .shop-item,
.shop-item + .shop-item {
  border-top: 1px solid var(--border);
}
.buy {
  flex-shrink: 0;
  height: 26px;
  padding: 0 10px;
  border-radius: 99px;
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: 12px;
  line-height: 26px;
  text-decoration: none;
  white-space: nowrap;
}
.near {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin-bottom: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--ink-3);
}
.near > span:first-child {
  margin-top: 3px;
  flex-shrink: 0;
}
.wd {
  width: 34px;
  flex-shrink: 0;
  font-size: 13px;
  color: var(--ink-2);
  padding-top: 1px;
}
</style>
