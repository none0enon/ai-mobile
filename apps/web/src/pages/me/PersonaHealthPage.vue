<script setup lang="ts">
import {
  BENTO_LABEL,
  bmiOf,
  COMMON_INGREDIENTS,
  FIT_METHODS,
  FIT_TIME_LABEL,
  HEALTH_GOALS,
  KITCHEN_TOOLS,
  MEAL_KEYS,
  MEAL_LABEL,
  WEEKDAY_LABEL,
  WEEKDAY_ORDER,
  type FitTimeOfDay,
  type HealthBento,
  type HealthSettings,
} from '@app/shared';
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import PageHeader from '@/layouts/PageHeader.vue';
import { usePersonaStore } from '@/stores/personas';
import { useServicesStore } from '@/stores/services';

/**
 * 人设 → 健康系统（设计文档 §9.13）：「健康计划」按这里的设置排这周和今天的健身计划、饮食计划。
 * - 身体：身高、体重、目标体重；年龄、性别只用来按心率估算消耗（都可以不填）；
 * - 目标、身体情况（旧伤……）；
 * - 能接受的健身方式（"健身"里随便动动时也从这里挑）、一周里每天能练多久、一般什么时候练；
 * - 家里常有的食材、忌口、每顿能花多久做饭（0 = 那顿不做饭：外食，或者带提前做好的便当）、能不能带便当、有的厨具；
 * - 接了 Google 地图时参不参考附近的店（外食从附近真实的店里挑，要买的东西按附近超市和网店真能买到的写）。
 * 存在本机。打开以后聊天里她也知道你的目标和今天的计划（"家务和健康"那一块），按预设里"健康：你怎么反应"来。
 */
const route = useRoute();
const store = usePersonaStore();
const persona = computed(() => store.byId(route.params.id as string) ?? store.defaultPersona);
const h = computed(() => store.health(persona.value));
const svc = useServicesStore();
function touch() {
  store.touch(persona.value);
}

type NumKey = 'heightCm' | 'weightKg' | 'targetWeightKg' | 'age';
/** 数字输入框：清空 = 不填（null） */
function numModel(k: NumKey) {
  return computed({
    get: () => h.value[k] ?? '',
    set: (v: string | number) => {
      const n = typeof v === 'number' ? v : Number(String(v).trim());
      h.value[k] = String(v).trim() === '' || !Number.isFinite(n) || n <= 0 ? null : Math.round(n * 10) / 10;
      touch();
    },
  });
}
const height = numModel('heightCm');
const weight = numModel('weightKg');
const target = numModel('targetWeightKg');
const age = numModel('age');
const bmi = computed(() => bmiOf(h.value));

function hasGoal(g: string) {
  return h.value.goal.split(/[，,、\s]+/).includes(g);
}
function toggleGoal(g: string) {
  const parts = h.value.goal.split(/[，,、]/).map((x) => x.trim()).filter(Boolean);
  h.value.goal = (hasGoal(g) ? parts.filter((x) => x !== g) : [...parts, g]).join('、');
  touch();
}

type ListKey = 'methods' | 'tools' | 'ingredients';
function toggleIn(k: ListKey, v: string) {
  const list = h.value[k];
  h.value[k] = list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
  touch();
}
const custom = ref<Record<ListKey, string>>({ methods: '', tools: '', ingredients: '' });
function addCustom(k: ListKey) {
  const v = custom.value[k].trim().slice(0, 30);
  if (!v) return;
  for (const one of v.split(/[，,、]/).map((x) => x.trim()).filter(Boolean)) if (!h.value[k].includes(one)) h.value[k].push(one);
  custom.value[k] = '';
  touch();
}
/** 列表里有、预设选项里没有的（自己加的）也显示出来 */
const methodOptions = computed(() => [...FIT_METHODS.map((m) => m.name), ...h.value.methods.filter((m) => !FIT_METHODS.some((x) => x.name === m))]);
const toolOptions = computed(() => [...KITCHEN_TOOLS, ...h.value.tools.filter((t) => !KITCHEN_TOOLS.includes(t))]);
const ingredientOptions = computed(() => [...COMMON_INGREDIENTS, ...h.value.ingredients.filter((t) => !COMMON_INGREDIENTS.includes(t))]);

const weekTotal = computed(() => h.value.weekMinutes.reduce((a, b) => a + b, 0));
const TIMES: FitTimeOfDay[] = ['morning', 'noon', 'evening', 'any'];
const BENTOS = Object.keys(BENTO_LABEL) as HealthBento[];
const anyZero = computed(() => MEAL_KEYS.some((k) => !h.value.cookMinutes[k]));
function setBento(b: HealthBento) {
  h.value.bento = b;
  touch();
}
function setSex(s: HealthSettings['sex']) {
  h.value.sex = h.value.sex === s ? null : s;
  touch();
}
</script>

<template>
  <div class="page" data-page="persona-health">
    <PageHeader title="健康系统" :subtitle="`${persona.name} · 按它排健身和饮食计划`" fallback="/me/personas" />
    <div class="page-scroll pb-8">
      <div class="mx-4 mt-3 card-box flex items-center gap-3">
        <span class="big-icon"><span class="i-lucide-heart-pulse" /></span>
        <div class="flex-1 min-w-0">
          <div class="text-[15px] font-600">打开健康系统</div>
          <div class="text-[12px] text-ink-3 leading-relaxed">「健康计划」按下面的设置排这周和今天的健身、饮食计划；"健身"里可以照着练；她也会知道你的目标和今天练没练</div>
        </div>
        <van-switch v-model="h.enabled" size="22px" data-testid="health-switch" @change="touch" />
      </div>
      <RouterLink v-if="h.enabled" to="/me/health" class="go mx-4 mt-2"><span class="i-lucide-arrow-right" />去看健康计划</RouterLink>

      <div class="group-title">身体</div>
      <div class="mx-4 card-box">
        <div class="grid grid-cols-2 gap-x-3">
          <div>
            <label class="field-label !mt-0" for="h-height">身高（cm）</label>
            <input id="h-height" v-model="height" class="input" type="number" inputmode="decimal" placeholder="例如 170" />
          </div>
          <div>
            <label class="field-label !mt-0" for="h-weight">体重（kg）</label>
            <input id="h-weight" v-model="weight" class="input" type="number" inputmode="decimal" placeholder="例如 65" />
          </div>
          <div>
            <label class="field-label" for="h-target">目标体重（可以不填）</label>
            <input id="h-target" v-model="target" class="input" type="number" inputmode="decimal" />
          </div>
          <div>
            <label class="field-label" for="h-age">年龄（可以不填）</label>
            <input id="h-age" v-model="age" class="input" type="number" inputmode="numeric" />
          </div>
        </div>
        <div class="field-label">性别（可以不填）</div>
        <div class="flex gap-1.5 items-center">
          <button type="button" class="opt" :class="{ on: h.sex === 'male' }" @click="setSex('male')">男</button>
          <button type="button" class="opt" :class="{ on: h.sex === 'female' }" @click="setSex('female')">女</button>
          <span v-if="bmi" class="ml-auto text-[12.5px] text-ink-3 num">BMI {{ bmi }}</span>
        </div>
        <p class="text-[12px] text-ink-3 mt-2 mb-0">年龄、性别只用来按心率估算运动消耗；不填就按运动强度和体重估。</p>
      </div>

      <div class="group-title">目标</div>
      <div class="mx-4 card-box">
        <div class="flex flex-wrap gap-1.5">
          <button v-for="g in HEALTH_GOALS" :key="g" type="button" class="opt" :class="{ on: hasGoal(g) }" @click="toggleGoal(g)">{{ g }}</button>
        </div>
        <textarea v-model="h.goal" class="textarea mt-2.5 !min-h-[70px]" placeholder="可以多写几句，例如：减脂，三个月瘦 5 斤；想把俯卧撑做到 20 个" aria-label="目标" @change="touch" />
        <label class="field-label" for="h-note">身体情况（可以不填）</label>
        <input id="h-note" v-model="h.note" class="input" placeholder="例如：膝盖不太好，不能跳；久坐腰酸" @change="touch" />
      </div>

      <div class="group-title">能接受的健身方式</div>
      <div class="mx-4 card-box">
        <div class="flex flex-wrap gap-1.5">
          <button v-for="m in methodOptions" :key="m" type="button" class="opt" :class="{ on: h.methods.includes(m) }" :data-method="m" @click="toggleIn('methods', m)">{{ m }}</button>
        </div>
        <form class="flex gap-2 mt-2.5" @submit.prevent="addCustom('methods')">
          <input v-model="custom.methods" class="input !h-[34px]" placeholder="别的方式（例如：羽毛球）" aria-label="加一种健身方式" />
          <van-button size="small" round native-type="submit">加上</van-button>
        </form>
        <p class="text-[12px] text-ink-3 mt-2 mb-0">排计划只用选中的这些；"健身"里随便动动时也从这里挑。</p>
      </div>

      <div class="group-title">能练的时间<span class="ml-auto num text-[12px]">一周 {{ weekTotal }} 分钟</span></div>
      <div class="mx-4 card-box">
        <div v-for="d in WEEKDAY_ORDER" :key="d" class="day-row">
          <span class="w-10 text-[14px]">{{ WEEKDAY_LABEL[d] }}</span>
          <van-stepper v-model="h.weekMinutes[d]" :min="0" :max="300" :step="10" integer button-size="26px" input-width="44px" @change="touch" />
          <span class="text-[12.5px]" :class="h.weekMinutes[d] ? 'text-ink-2' : 'text-ink-3'">{{ h.weekMinutes[d] ? '分钟' : '不练' }}</span>
        </div>
        <div class="field-label">一般什么时候练</div>
        <div class="flex flex-wrap gap-1.5">
          <button v-for="t in TIMES" :key="t" type="button" class="opt" :class="{ on: h.timeOfDay === t }" @click="(h.timeOfDay = t), touch()">{{ FIT_TIME_LABEL[t] }}</button>
        </div>
        <input v-model="h.timeNote" class="input mt-2.5" placeholder="补充（可以不填），例如：周三要加班；周末上午最好" aria-label="时间补充" @change="touch" />
      </div>

      <div class="group-title">吃</div>
      <div class="mx-4 card-box">
        <div class="field-label !mt-0">家里常有的食材</div>
        <div class="flex flex-wrap gap-1.5">
          <button v-for="t in ingredientOptions" :key="t" type="button" class="opt" :class="{ on: h.ingredients.includes(t) }" @click="toggleIn('ingredients', t)">{{ t }}</button>
        </div>
        <form class="flex gap-2 mt-2.5" @submit.prevent="addCustom('ingredients')">
          <input v-model="custom.ingredients" class="input !h-[34px]" placeholder="别的食材，可以用顿号隔开" aria-label="加食材" />
          <van-button size="small" round native-type="submit">加上</van-button>
        </form>
        <label class="field-label" for="h-avoid">忌口 / 过敏（可以不填）</label>
        <input id="h-avoid" v-model="h.avoid" class="input" placeholder="例如：不吃香菜；乳糖不耐" @change="touch" />
        <div class="field-label">每顿能花多久做饭（0 = 那顿不做饭：外食，或者带提前做好的便当）</div>
        <div v-for="k in MEAL_KEYS" :key="k" class="day-row">
          <span class="w-10 text-[14px]">{{ MEAL_LABEL[k] }}</span>
          <van-stepper v-model="h.cookMinutes[k]" :min="0" :max="180" :step="5" integer button-size="26px" input-width="44px" @change="touch" />
          <span class="text-[12.5px]" :class="h.cookMinutes[k] ? 'text-ink-2' : 'text-ink-3'">{{ h.cookMinutes[k] ? '分钟' : h.bento === 'off' ? '外食' : '外食或带便当' }}</span>
        </div>
        <template v-if="anyZero">
          <div class="field-label">带便当（不做饭的那顿，在能做饭的那顿顺手做好带去；隔夜燕麦这类也算）</div>
          <div class="flex flex-wrap gap-1.5" role="radiogroup" aria-label="带便当">
            <button v-for="b in BENTOS" :key="b" type="button" role="radio" class="opt" :class="{ on: h.bento === b }" :aria-checked="h.bento === b" :data-testid="`bento-${b}`" @click="setBento(b)">{{ BENTO_LABEL[b] }}</button>
          </div>
        </template>
        <div class="field-label">有的厨具</div>
        <div class="flex flex-wrap gap-1.5">
          <button v-for="t in toolOptions" :key="t" type="button" class="opt" :class="{ on: h.tools.includes(t) }" @click="toggleIn('tools', t)">{{ t }}</button>
        </div>
        <form class="flex gap-2 mt-2.5" @submit.prevent="addCustom('tools')">
          <input v-model="custom.tools" class="input !h-[34px]" placeholder="别的厨具（例如：宿舍小电锅）" aria-label="加厨具" />
          <van-button size="small" round native-type="submit">加上</van-button>
        </form>
        <div class="flex items-center gap-3 mt-3.5">
          <div class="flex-1 min-w-0">
            <div class="text-[14px]">外食和买东西参考附近真实的店</div>
            <div class="text-[12px] text-ink-3 leading-relaxed">
              <template v-if="svc.mapsReady">用 Google 地图搜家附近（出门时是你在的地方）能吃饭的地方和超市：外食只从这些店里挑，要买的东西按这些超市和网店（Amazon、Kroger……）真能买到的写。发给模型的是店名、种类、距离，不发地址</template>
              <template v-else>要先在"我的 → 地图、天气、音乐"里接上 Google 地图</template>
            </div>
          </div>
          <van-switch v-model="h.nearby" size="20px" data-testid="health-nearby" @change="touch" />
        </div>
      </div>
      <p class="note">这些只存在这台设备上；排计划时发给「健康计划」用的模型（API 设置里能单独设置，默认跟随主对话）。</p>
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
.big-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 42px;
  border-radius: 14px;
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: 21px;
  flex-shrink: 0;
}
.go {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--accent-ink);
  text-decoration: none;
}
.opt {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 32px;
  padding: 0 12px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 13px;
}
.opt.on {
  background: var(--accent-soft);
  color: var(--accent-ink);
  outline: 1px solid var(--accent-line);
}
.day-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 5px 0;
}
</style>
