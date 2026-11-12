<script setup lang="ts">
import { getLocation, OUTFIT_KINDS, SCENES, slotIn, toMinutes, worldOf, type OutfitKind, type RhythmDay, type RhythmSlot } from '@app/shared';
import { showConfirmDialog, showToast } from 'vant';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import ErrorDetails from '@/components/common/ErrorDetails.vue';
import PersonTabs from '@/components/common/PersonTabs.vue';
import Segmented from '@/components/common/Segmented.vue';
import PageHeader from '@/layouts/PageHeader.vue';
import { useAiStore } from '@/stores/ai';
import { useAppStore } from '@/stores/app';
import { useCharacterStore } from '@/stores/characters';
import { useLibraryStore } from '@/stores/library';
import { useRhythmStore, type WorldPreview } from '@/stores/rhythm';
import { uid } from '@/utils/id';

/**
 * 我的 → 节律（设计文档 §9 开头）：上面一排头像选看谁的（?char=）。
 * - 还没有小世界的（导入的角色）：先"建世界"，「节律」从角色卡和世界书里生成地点、身边的人、作息模板、三餐、衣柜，看过再用；
 * - 怎么排：固定（一直用模板）/ 每天变化（作息、三餐、穿着分别勾；穿着从衣柜里挑或每天新编）；
 * - 今天：时间线、三餐、穿着（tags 能改）、手头的事；重新排今天、把今天存成模板；
 * - 模板：作息（标"固定"的每天不挪）、三餐习惯、衣柜、手头的事，都能改；
 * - 最近 7 天。
 */
const route = useRoute();
const router = useRouter();
const app = useAppStore();
const chars = useCharacterStore();
const ai = useAiStore();
const lib = useLibraryStore();
const rhythm = useRhythmStore();

const pickedId = ref((route.query.char as string | undefined) ?? app.activeCharacterId);
const c = computed(() => chars.byId(pickedId.value) ?? chars.list[0]);
watch(pickedId, (id) => {
  if (route.query.char !== id) void router.replace({ query: { ...route.query, char: id } });
  preview.value = null;
  buildError.value = null;
});
watch(
  () => route.query.char,
  (id) => {
    if (typeof id === 'string' && id !== pickedId.value) pickedId.value = id;
  },
);

const id = computed(() => c.value?.id ?? '');
const cfg = computed(() => rhythm.configOf(id.value));
const hasWorld = computed(() => !!id.value && rhythm.hasWorld(id.value));
const world = computed(() => (hasWorld.value ? worldOf(id.value) : null));
const built = computed(() => !!rhythm.worlds[id.value]);
const today = computed<RhythmDay | null>(() => (id.value ? rhythm.todayOf(id.value) : null));
const template = computed(() => (id.value ? rhythm.templateOf(id.value) : null));
const status = computed(() => ai.status('rhythm'));
const preset = computed(() => lib.presetForUse('rhythm', c.value));
const busy = computed(() => rhythm.busy[id.value]);
const error = computed(() => rhythm.errors[id.value]);
const locations = computed(() => world.value?.locations ?? []);
const place = (locId: string) => getLocation(locId)?.name ?? locId;
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const dateLabel = (d: string) => `${Number(d.slice(5, 7))} 月 ${Number(d.slice(8, 10))} 日 ${WEEK[new Date(`${d}T12:00:00`).getDay()]}`;
const KINDS = Object.keys(OUTFIT_KINDS) as OutfitKind[];

// —— 怎么排 ——
const mode = computed({
  get: () => cfg.value.settings.mode,
  set: (v: 'fixed' | 'daily') => rhythm.setSettings(id.value, { mode: v }),
});
const outfitMode = computed({
  get: () => cfg.value.settings.outfitMode,
  set: (v: 'pick' | 'new') => rhythm.setSettings(id.value, { outfitMode: v }),
});
function setVary(k: 'schedule' | 'meals' | 'outfits', v: boolean) {
  rhythm.setSettings(id.value, { vary: { ...cfg.value.settings.vary, [k]: v } });
}

// —— 今天 ——
/** 现在几点（半分钟走一次）：时间线上标"现在" */
const clock = ref(Date.now());
const clockTimer = setInterval(() => (clock.value = Date.now()), 30_000);
onBeforeUnmount(() => clearInterval(clockTimer));
const nowSlot = computed(() => (today.value?.schedule.length ? slotIn(today.value.schedule, new Date(clock.value)) : undefined));
const sourceLine = computed(() => {
  const d = today.value;
  if (!d) return '';
  if (d.edited) return '你改过';
  if (d.source === 'model') return `「节律」排的${d.model ? ` · ${d.model}` : ''}`;
  return mode.value === 'daily' ? (status.value.live ? '按模板（还没排）' : '按模板（「节律」没接通）') : '按模板（固定）';
});
async function planNow() {
  if (!id.value) return;
  if (!status.value.live) {
    void router.push('/me/api?feature=rhythm');
    return;
  }
  const r = await rhythm.planToday(id.value, { force: true });
  if (r.ok) showToast(r.value.fixes?.length ? `排好了（检查时改了 ${r.value.fixes.length} 处）` : '排好了');
  else if (r.reason !== '正在排') showToast(r.reason.slice(0, 80));
}
function resetToday() {
  rhythm.resetToday(id.value);
  showToast('今天按模板');
}
function saveAsTemplate() {
  if (rhythm.saveTodayAsTemplate(id.value)) showToast('存成模板了：以后固定的日子都这样过');
}
function editToday(fn: (d: RhythmDay) => void) {
  const d = rhythm.editToday(id.value);
  if (d) fn(d);
}
function setMeal(k: 'breakfast' | 'lunch' | 'dinner', v: string) {
  editToday((d) => (d.meals[k] = v.trim()));
}
function setOutfit(k: OutfitKind, field: 'name' | 'tags', v: string) {
  editToday((d) => {
    const o = d.outfits[k] ?? { name: '', tags: '' };
    d.outfits[k] = { ...o, [field]: v.trim() };
  });
}
function setTask(v: string) {
  editToday((d) => (d.task = v.trim()));
}
const fixesOpen = ref(false);

// —— 模板 ——
const tplOpen = ref(false);
function editTpl(fn: (t: NonNullable<ReturnType<typeof rhythm.editTemplate>>) => void) {
  const t = rhythm.editTemplate(id.value);
  if (t) fn(t);
}
function setSlot(i: number, field: keyof RhythmSlot, v: string | boolean) {
  editTpl((t) => {
    const s = t.schedule[i];
    if (!s) return;
    if ((field === 'from' || field === 'to') && typeof v === 'string') {
      const m = toMinutes(v);
      if (m === null) {
        showToast('时间写成 07:30 这样（最晚 24:00）');
        return;
      }
      s[field] = v.trim().replace('：', ':').padStart(5, '0');
    } else if (field === 'fixed') s.fixed = v === true ? true : undefined;
    else if (typeof v === 'string') (s as unknown as Record<string, string>)[field] = v;
    t.schedule.sort((a, b) => (toMinutes(a.from) ?? 0) - (toMinutes(b.from) ?? 0));
  });
}
function addSlot() {
  editTpl((t) => {
    const last = t.schedule.at(-1);
    t.schedule.push({ from: last?.to && last.to !== '24:00' ? last.to : '12:00', to: '24:00', locationId: world.value?.homeId ?? locations.value[0]?.id ?? '', status: '自己的事' });
  });
}
function removeSlot(i: number) {
  editTpl((t) => t.schedule.splice(i, 1));
}
function setTplMeal(k: 'breakfast' | 'lunch' | 'dinner', v: string) {
  editTpl((t) => (t.meals[k] = v.trim()));
}
function setWear(i: number, field: 'name' | 'tags' | 'kind', v: string) {
  editTpl((t) => {
    const o = t.wardrobe[i];
    if (o) (o as unknown as Record<string, string>)[field] = field === 'kind' ? v : v.trim();
  });
}
function addWear() {
  editTpl((t) => t.wardrobe.push({ id: uid('outfit'), kind: 'daily', name: '新的一套', tags: '' }));
}
function removeWear(i: number) {
  editTpl((t) => t.wardrobe.splice(i, 1));
}
function setTplTask(v: string) {
  editTpl((t) => (t.task = v.trim()));
}
/** 模板时间线有没有盖满一整天 */
const tplGaps = computed(() => {
  const s = template.value?.schedule ?? [];
  let cursor = 0;
  let gaps = 0;
  for (const x of [...s].sort((a, b) => (toMinutes(a.from) ?? 0) - (toMinutes(b.from) ?? 0))) {
    const a = toMinutes(x.from) ?? 0;
    if (a !== cursor) gaps += 1;
    cursor = Math.max(cursor, toMinutes(x.to) ?? 0);
  }
  return gaps + (cursor < 1440 ? 1 : 0);
});

// —— 最近 7 天 ——
const recent = computed(() => (id.value ? rhythm.recentDays(id.value, 7) : []));
const openDay = ref<string | null>(null);
function dayBrief(d: RhythmDay): string {
  const doing = [...new Set(d.schedule.filter((s) => !/睡/.test(s.status)).map((s) => s.status))].slice(0, 4).join('、');
  const wear = d.outfits.daily?.name ?? '';
  return [doing, wear ? `穿${wear}` : ''].filter(Boolean).join(' · ');
}

// —— 建世界 ——
const preview = ref<WorldPreview | null>(null);
const buildError = ref<{ reason: string; detail?: string } | null>(null);
async function buildNow() {
  if (!id.value || busy.value) return;
  if (!status.value.live) {
    void router.push('/me/api?feature=rhythm');
    return;
  }
  buildError.value = null;
  const r = await rhythm.buildWorld(id.value);
  if (r.ok) preview.value = r.value;
  else buildError.value = { reason: r.reason, detail: r.detail };
}
function useWorld() {
  if (!preview.value) return;
  rhythm.applyWorld(id.value, preview.value);
  preview.value = null;
  showToast(`${c.value?.name}有自己的小世界了：地图上能去${c.value?.pronoun}那儿`);
}
async function rebuild() {
  try {
    await showConfirmDialog({ title: '重建小世界？', message: '会重新生成地点、作息模板、衣柜和身边的人；看过结果再决定用不用，现在的先不动。', confirmButtonText: '重建' });
  } catch {
    return;
  }
  void buildNow();
}
const sceneName = (sid: string) => SCENES.find((s) => s.id === sid)?.name ?? sid;
</script>

<template>
  <div class="page" data-page="rhythm">
    <PageHeader title="节律" subtitle="她们每天的作息、三餐和穿着" fallback="/me" />
    <div class="page-scroll pb-10">
      <PersonTabs v-model="pickedId" :characters="chars.list" label="看谁的节律" class="px-4 pt-3" />

      <template v-if="c">
        <div class="api-line" :class="{ warn: !status.live }" data-testid="rhythm-api">
          <span class="i-lucide-calendar-clock shrink-0 mt-0.5" />
          <span class="flex-1 min-w-0">
            <template v-if="status.live">「节律」用 {{ ai.chatModelOf('rhythm') || '未选模型' }}，预设「{{ preset?.name ?? '没有节律预设' }}」。</template>
            <template v-else>「节律」还没接通（{{ status.reason }}）：固定的照常按模板过，"每天变化"和"建世界"要先接通。</template>
            <RouterLink :to="status.live ? '/me/presets?cat=rhythm' : '/me/api?feature=rhythm'" class="text-accent-ink ml-1">{{ status.live ? '改预设' : '去设置' }}</RouterLink>
          </span>
        </div>

        <!-- 还没有小世界：建世界 -->
        <template v-if="!hasWorld || preview">
          <div class="group-title">{{ preview ? '建好的小世界（看过再用）' : `${c.name}还没有小世界` }}</div>
          <div class="px-4 grid gap-3">
            <div v-if="!preview" class="card-box" data-testid="no-world">
              <p class="m-0 text-[13.5px] leading-relaxed text-ink-2">
                {{ c.name }}是导入的角色，还没有自己的小世界。让「节律」从角色卡和世界书里找出{{ c.pronoun }}住在哪、在哪读书或工作、常去哪、身边有谁，写出作息模板、三餐习惯和衣柜。建好以后地图上能去{{ c.pronoun }}那儿，{{ c.pronoun }}按作息出现在不同的地方，生图时穿衣柜里的衣服。
              </p>
              <van-button type="primary" round block class="!mt-3" :loading="busy === 'build'" loading-text="正在建…" data-testid="build-world" @click="buildNow">
                {{ status.live ? '建世界' : '先接通「节律」' }}
              </van-button>
              <ErrorDetails v-if="buildError" :title="buildError.reason" :detail="buildError.detail ?? buildError.reason" max-height="30vh" />
            </div>

            <div v-else class="card-box" data-testid="world-preview">
              <div class="text-[16px] font-600">{{ preview.world.name }}</div>
              <div v-if="preview.world.blurb" class="text-[12.5px] text-ink-3 mt-0.5">{{ preview.world.blurb }}</div>
              <div class="sub">地点</div>
              <div v-for="l in preview.world.locations" :key="l.id" class="loc">
                <span :class="l.icon" class="text-accent-ink shrink-0" />
                <span class="flex-1 min-w-0">
                  <span class="text-[14px]">{{ l.name }}</span><span class="text-[12px] text-ink-3"> · {{ preview.world.areaLabels[l.area as 'home'] ?? '' }}{{ l.id === preview.world.homeId ? '（住处）' : '' }}</span>
                  <span class="block text-[12px] text-ink-3">{{ l.activities.map((a) => a.label).join('、') || '—' }}{{ l.blurb ? ` · ${l.blurb}` : '' }}</span>
                </span>
              </div>
              <template v-if="preview.people.length">
                <div class="sub">身边的人</div>
                <div v-for="p in preview.people" :key="p.name" class="text-[13px] py-0.5">{{ p.name }}<span class="text-ink-3">（{{ p.relation }}）{{ p.note ? ` · ${p.note}` : '' }}</span></div>
              </template>
              <div class="sub">作息模板</div>
              <div v-for="(s, i) in preview.template.schedule" :key="i" class="slot">
                <span class="num time">{{ s.from }}–{{ s.to }}</span><span class="flex-1 min-w-0 truncate">{{ s.status }} · {{ preview.world.locations.find((l) => l.id === s.locationId)?.name ?? s.locationId }}</span>
                <span v-if="s.fixed" class="tag">固定</span>
              </div>
              <div class="sub">三餐 · 衣柜 · 手头的事</div>
              <div class="text-[13px] text-ink-2">早饭{{ preview.template.meals.breakfast || '—' }}；午饭{{ preview.template.meals.lunch || '—' }}；晚饭{{ preview.template.meals.dinner || '—' }}</div>
              <div v-for="o in preview.template.wardrobe" :key="o.id" class="text-[13px] mt-1">
                <span class="tag">{{ OUTFIT_KINDS[o.kind] }}</span> {{ o.name }} <span class="mono text-ink-3 text-[12px]">{{ o.tags }}</span>
              </div>
              <div v-if="preview.template.task" class="text-[13px] mt-1">手头的事：{{ preview.template.task }}</div>
              <div class="text-[12px] text-ink-3 mt-2">{{ preview.model }} 写的</div>
              <div class="flex gap-2 mt-3">
                <van-button round block :loading="busy === 'build'" @click="buildNow">再生成一次</van-button>
                <van-button type="primary" round block data-testid="use-world" @click="useWorld">就用这个</van-button>
              </div>
              <button class="text-[13px] text-ink-3 mt-2 w-full" @click="preview = null">先不用</button>
            </div>
          </div>
        </template>

        <template v-if="hasWorld && !preview">
          <!-- 怎么排 -->
          <div class="group-title">怎么排</div>
          <div class="px-4">
            <Segmented
              v-model="mode"
              :options="[
                { value: 'fixed', label: '固定' },
                { value: 'daily', label: '每天变化' },
              ]"
            />
            <p class="note !mx-0">
              {{ mode === 'fixed' ? `一直按下面的模板过：作息、三餐、衣柜里每类第一套。` : `每天第一次打开 App 时交给「节律」排（凌晨 4 点换一天），排出来的会检查：盖满一整天、地点都在${c.pronoun}的世界里、标了"固定"的事不挪。` }}
            </p>
            <div v-if="mode === 'daily'" class="card-box">
              <div class="flex flex-wrap gap-4">
                <van-checkbox :model-value="cfg.settings.vary.schedule" icon-size="18px" @update:model-value="(v: boolean) => setVary('schedule', v)">作息</van-checkbox>
                <van-checkbox :model-value="cfg.settings.vary.meals" icon-size="18px" @update:model-value="(v: boolean) => setVary('meals', v)">三餐</van-checkbox>
                <van-checkbox :model-value="cfg.settings.vary.outfits" icon-size="18px" @update:model-value="(v: boolean) => setVary('outfits', v)">穿着</van-checkbox>
              </div>
              <template v-if="cfg.settings.vary.outfits">
                <div class="text-[12.5px] text-ink-3 mt-3 mb-1.5">穿着</div>
                <Segmented
                  v-model="outfitMode"
                  :options="[
                    { value: 'pick', label: '从衣柜里挑着搭' },
                    { value: 'new', label: '每天新编' },
                  ]"
                />
                <div class="text-[12px] text-ink-3 mt-1.5">{{ outfitMode === 'pick' ? '更稳：只穿衣柜里有的' : '变化多：按天气和安排新编，tags 也是新写的' }}</div>
              </template>
            </div>
          </div>

          <!-- 今天 -->
          <div class="group-title">
            今天 · {{ dateLabel(rhythm.today) }}
            <span class="action text-[12px] text-ink-3 font-400">{{ sourceLine }}</span>
          </div>
          <div v-if="today" class="px-4 grid gap-3" data-testid="rhythm-today">
            <div class="card-box">
              <div v-for="(s, i) in today.schedule" :key="i" class="slot" :class="{ now: nowSlot === s }">
                <span class="num time">{{ s.from }}–{{ s.to }}</span>
                <span class="flex-1 min-w-0 truncate">{{ s.status }}<span class="text-ink-3"> · {{ place(s.locationId) }}</span></span>
                <span v-if="s.fixed" class="tag">固定</span>
                <span v-if="nowSlot === s" class="tag accent">现在</span>
              </div>
            </div>
            <div class="card-box">
              <div class="sub !mt-0">三餐</div>
              <div v-for="k in (['breakfast', 'lunch', 'dinner'] as const)" :key="k" class="kv">
                <span class="k">{{ { breakfast: '早饭', lunch: '午饭', dinner: '晚饭' }[k] }}</span>
                <input class="input" :value="today.meals[k]" :aria-label="`今天的${{ breakfast: '早饭', lunch: '午饭', dinner: '晚饭' }[k]}`" @change="setMeal(k, ($event.target as HTMLInputElement).value)" />
              </div>
              <div class="sub">穿着（一起做事时画的图都穿这身：运动穿运动的、哄睡穿睡衣、约会穿约会装）</div>
              <div v-for="k in KINDS.filter((x) => today!.outfits[x] || x !== 'date')" :key="k" class="wear">
                <div class="flex items-center gap-2">
                  <span class="tag shrink-0">{{ OUTFIT_KINDS[k] }}</span>
                  <input class="input flex-1" :value="today.outfits[k]?.name ?? ''" placeholder="中文名" :aria-label="`今天的${OUTFIT_KINDS[k]}穿着`" @change="setOutfit(k, 'name', ($event.target as HTMLInputElement).value)" />
                </div>
                <textarea class="textarea mono tags" rows="2" :value="today.outfits[k]?.tags ?? ''" placeholder="NovelAI tags（只写衣服、鞋、配饰）" :aria-label="`今天的${OUTFIT_KINDS[k]}穿着 tags`" @change="setOutfit(k, 'tags', ($event.target as HTMLTextAreaElement).value)" />
              </div>
              <div class="sub">手头的事（陪伴学习里{{ c.pronoun }}的小目标）</div>
              <input class="input" :value="today.task" aria-label="今天手头的事" @change="setTask(($event.target as HTMLInputElement).value)" />
              <template v-if="today.events.length">
                <div class="sub">今天{{ c.pronoun }}那边的小事</div>
                <div v-for="(e, i) in today.events" :key="i" class="text-[13px] text-ink-2 py-0.5">· {{ e }}</div>
              </template>
            </div>
            <div v-if="today.fixes?.length" class="card-box">
              <button class="flex items-center gap-1.5 text-[13px] text-ink-2 w-full" @click="fixesOpen = !fixesOpen">
                <span class="i-lucide-shield-check text-accent-ink" />检查时改了 {{ today.fixes.length }} 处<span class="ml-auto" :class="fixesOpen ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" />
              </button>
              <div v-if="fixesOpen" class="mt-1.5">
                <div v-for="(f, i) in today.fixes" :key="i" class="text-[12.5px] text-ink-3 py-0.5">· {{ f }}</div>
              </div>
            </div>
            <ErrorDetails v-if="error" :title="`排今天没成功：${error.reason}`" :detail="error.detail ?? error.reason" max-height="30vh" />
            <div class="flex gap-2">
              <van-button v-if="mode === 'daily' || status.live" round block type="primary" :loading="busy === 'plan'" loading-text="正在排…" data-testid="plan-today" @click="planNow">
                {{ status.live ? '重新排今天' : '先接通「节律」' }}
              </van-button>
              <van-button round block @click="saveAsTemplate">存成模板</van-button>
            </div>
            <button v-if="today.source === 'model' || today.edited" class="text-[13px] text-ink-3" @click="resetToday">今天改回按模板</button>
          </div>

          <!-- 模板 -->
          <div class="group-title">
            模板
            <button class="action text-accent-ink text-[13px] font-400" @click="tplOpen = !tplOpen">{{ tplOpen ? '收起' : '展开改' }}</button>
          </div>
          <div class="px-4">
            <div v-if="!tplOpen" class="card-box text-[13px] text-ink-2 leading-relaxed">
              作息 {{ template?.schedule.length ?? 0 }} 段（固定 {{ template?.schedule.filter((s) => s.fixed).length ?? 0 }} 段）· 衣柜 {{ template?.wardrobe.length ?? 0 }} 套
              <template v-if="template?.task"> · 手头的事：{{ template.task }}</template>
            </div>
            <div v-else-if="template" class="grid gap-3" data-testid="rhythm-template">
              <div class="card-box">
                <div class="sub !mt-0">作息（标"固定"的每天不挪）<span v-if="tplGaps" class="text-warn"> · 有 {{ tplGaps }} 处空着或重叠，排的时候按前一段补</span></div>
                <div v-for="(s, i) in template.schedule" :key="`${i}-${s.from}`" class="tpl-slot">
                  <div class="flex items-center gap-1.5">
                    <input class="input time-in num" :value="s.from" aria-label="开始" inputmode="numeric" @change="setSlot(i, 'from', ($event.target as HTMLInputElement).value)" />
                    <span class="text-ink-3">–</span>
                    <input class="input time-in num" :value="s.to" aria-label="结束" inputmode="numeric" @change="setSlot(i, 'to', ($event.target as HTMLInputElement).value)" />
                    <select class="input flex-1 min-w-0" :value="s.locationId" aria-label="在哪" @change="setSlot(i, 'locationId', ($event.target as HTMLSelectElement).value)">
                      <option v-for="l in locations" :key="l.id" :value="l.id">{{ l.name }}</option>
                    </select>
                  </div>
                  <div class="flex items-center gap-1.5 mt-1.5">
                    <input class="input flex-1" :value="s.status" aria-label="在做什么" @change="setSlot(i, 'status', ($event.target as HTMLInputElement).value)" />
                    <van-checkbox :model-value="!!s.fixed" icon-size="16px" @update:model-value="(v: boolean) => setSlot(i, 'fixed', v)">固定</van-checkbox>
                    <button class="del" :aria-label="`删掉 ${s.from}–${s.to}`" @click="removeSlot(i)"><span class="i-lucide-x" /></button>
                  </div>
                </div>
                <button class="add" @click="addSlot"><span class="i-lucide-plus" />加一段</button>
              </div>
              <div class="card-box">
                <div class="sub !mt-0">三餐习惯</div>
                <div v-for="k in (['breakfast', 'lunch', 'dinner'] as const)" :key="k" class="kv">
                  <span class="k">{{ { breakfast: '早饭', lunch: '午饭', dinner: '晚饭' }[k] }}</span>
                  <input class="input" :value="template.meals[k]" @change="setTplMeal(k, ($event.target as HTMLInputElement).value)" />
                </div>
                <div class="sub">手头的事</div>
                <input class="input" :value="template.task" @change="setTplTask(($event.target as HTMLInputElement).value)" />
              </div>
              <div class="card-box">
                <div class="sub !mt-0">衣柜（每套写中文名和 NovelAI tags，只写衣服、鞋、配饰）</div>
                <div v-for="(o, i) in template.wardrobe" :key="o.id" class="wear">
                  <div class="flex items-center gap-1.5">
                    <select class="input kind" :value="o.kind" aria-label="用途" @change="setWear(i, 'kind', ($event.target as HTMLSelectElement).value)">
                      <option v-for="k in KINDS" :key="k" :value="k">{{ OUTFIT_KINDS[k] }}</option>
                    </select>
                    <input class="input flex-1 min-w-0" :value="o.name" aria-label="中文名" @change="setWear(i, 'name', ($event.target as HTMLInputElement).value)" />
                    <button class="del" :aria-label="`删掉${o.name}`" @click="removeWear(i)"><span class="i-lucide-x" /></button>
                  </div>
                  <textarea class="textarea mono tags" rows="2" :value="o.tags" placeholder="NovelAI tags" aria-label="tags" @change="setWear(i, 'tags', ($event.target as HTMLTextAreaElement).value)" />
                </div>
                <button class="add" @click="addWear"><span class="i-lucide-plus" />加一套</button>
              </div>
            </div>
          </div>

          <!-- 最近 7 天 -->
          <div class="group-title">最近 7 天</div>
          <div class="px-4">
            <div v-if="!recent.length" class="card-box text-[13px] text-ink-3">还没有记录：排过、改过的日子会留在这里（按模板过的不记）。</div>
            <div v-else class="card-box">
              <div v-for="d in recent" :key="d.date" class="day">
                <button class="flex items-center gap-2 w-full text-left" @click="openDay = openDay === d.date ? null : d.date">
                  <span class="text-[13.5px] shrink-0">{{ dateLabel(d.date) }}</span>
                  <span class="text-[12px] text-ink-3 truncate flex-1 min-w-0">{{ dayBrief(d) }}</span>
                  <span :class="openDay === d.date ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" class="text-ink-3 shrink-0" />
                </button>
                <div v-if="openDay === d.date" class="mt-1.5">
                  <div v-for="(s, i) in d.schedule" :key="i" class="slot small">
                    <span class="num time">{{ s.from }}–{{ s.to }}</span><span class="truncate">{{ s.status }} · {{ place(s.locationId) }}</span>
                  </div>
                  <div class="text-[12px] text-ink-3 mt-1">早饭{{ d.meals.breakfast || '—' }}；午饭{{ d.meals.lunch || '—' }}；晚饭{{ d.meals.dinner || '—' }}</div>
                  <div v-for="(o, k) in d.outfits" :key="k" class="text-[12px] text-ink-3">{{ OUTFIT_KINDS[k as OutfitKind] }}：{{ o?.name }}</div>
                </div>
              </div>
            </div>
          </div>

          <!-- 她的世界 -->
          <div class="group-title">{{ world?.name }}</div>
          <div class="px-4">
            <div class="card-box">
              <div class="flex flex-wrap gap-1.5">
                <span v-for="l in locations" :key="l.id" class="tag"><span :class="l.icon" />{{ l.name }}</span>
              </div>
              <template v-if="cfg.people.length">
                <div class="sub">身边的人</div>
                <div v-for="p in cfg.people" :key="p.name" class="text-[13px] py-0.5">{{ p.name }}<span class="text-ink-3">（{{ p.relation }}）{{ p.note ? ` · ${p.note}` : '' }}</span></div>
              </template>
              <div class="text-[12px] text-ink-3 mt-2">
                {{ built ? `"建世界"生成的，能在这里重建。` : '演示角色的世界写在 App 里。' }}能一起做的事：{{ [...new Set(locations.flatMap((l) => l.activities.map((a) => sceneName(a.sceneId))))].join('、') }}
              </div>
              <div class="flex gap-2 mt-3">
                <van-button round block size="small" :to="`/map?world=${c.id}`">在地图上看</van-button>
                <van-button v-if="built" round block size="small" :loading="busy === 'build'" @click="rebuild">重建小世界</van-button>
              </div>
              <ErrorDetails v-if="buildError && built" :title="buildError.reason" :detail="buildError.detail ?? buildError.reason" max-height="30vh" />
            </div>
          </div>
        </template>
      </template>
      <p v-else class="note">还没有角色。先在"我的 → 导入 ST 文件"里导入一张角色卡。</p>
    </div>
  </div>
</template>

<style scoped>
.api-line {
  display: flex;
  gap: 8px;
  margin: 10px 16px 0;
  padding: 10px 12px;
  border-radius: 14px;
  background: var(--accent-soft);
  color: var(--ink-2);
  font-size: 12.5px;
  line-height: 1.6;
}
.api-line.warn {
  background: color-mix(in srgb, var(--warn) 14%, transparent);
}
.card-box {
  padding: 12px;
  border-radius: 16px;
  background: var(--surface);
  border: 1px solid var(--border);
}
.sub {
  margin: 12px 0 6px;
  font-size: 12.5px;
  color: var(--ink-3);
}
.slot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 4px;
  font-size: 13.5px;
  border-radius: 10px;
}
.slot.small {
  padding: 2px 0;
  font-size: 12.5px;
  color: var(--ink-2);
}
.slot.now {
  background: var(--accent-soft);
}
.time {
  flex-shrink: 0;
  width: 92px;
  color: var(--ink-2);
}
.loc {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 5px 0;
}
.kv {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.kv .k {
  flex-shrink: 0;
  width: 36px;
  font-size: 13px;
  color: var(--ink-2);
}
.wear {
  padding: 8px 0;
  border-top: 1px solid var(--border);
}
.wear:first-of-type {
  border-top: 0;
}
.tags {
  min-height: 0;
  margin-top: 6px;
  font-size: 12.5px;
}
.mono {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
}
.tpl-slot {
  padding: 8px 0;
  border-top: 1px solid var(--border);
}
.tpl-slot:first-of-type {
  border-top: 0;
}
.time-in {
  width: 66px;
  flex-shrink: 0;
  padding: 0 8px;
  text-align: center;
}
.kind {
  width: 76px;
  flex-shrink: 0;
  padding: 0 6px;
}
.del {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  color: var(--ink-3);
}
.add {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  width: 100%;
  height: 38px;
  margin-top: 6px;
  border-radius: 12px;
  border: 1.5px dashed var(--border);
  color: var(--ink-2);
  font-size: 13px;
}
.day {
  padding: 8px 0;
  border-top: 1px solid var(--border);
}
.day:first-child {
  border-top: 0;
}
</style>
