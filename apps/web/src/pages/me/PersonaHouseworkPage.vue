<script setup lang="ts">
import {
  CHORE_EFFECTS,
  CHORE_KINDS,
  CHORE_TEMPLATES,
  CHORE_WHEN,
  CHORE_WHEN_ORDER,
  choreSchedule,
  WEEKDAY_LABEL,
  WEEKDAY_ORDER,
  type ChoreDef,
  type ChoreEffect,
  type ChoreKind,
  type ChoreWhen,
} from '@app/shared';
import { showToast } from 'vant';
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import Segmented from '@/components/common/Segmented.vue';
import PageHeader from '@/layouts/PageHeader.vue';
import { usePersonaStore } from '@/stores/personas';
import { uid } from '@/utils/id';

/**
 * 人设 → 家务系统（设计文档 §9.12）：每天、每周要做的家务。
 * 每天的可以一天几次（刷牙：早上、睡前）；每周的可以固定哪几天（洗衣服：周三、周六），也可以哪天都行、一周几次。
 * 每件写"没做时她会怎样"：嫌弃、不跟你约会、有点失落（想吃你做的）、唠叨一句、不在意，或者自己写。
 * 打开以后"共同的家"按它列今天的清单；做没做写进提示词（"家务和健康"那一块），她按预设里"家务：你怎么反应"来。
 */
const route = useRoute();
const store = usePersonaStore();
const persona = computed(() => store.byId(route.params.id as string) ?? store.defaultPersona);
const hw = computed(() => store.housework(persona.value));

const daily = computed(() => hw.value.chores.filter((c) => c.freq === 'daily'));
const weekly = computed(() => hw.value.chores.filter((c) => c.freq === 'weekly'));
const templates = computed(() => CHORE_TEMPLATES.filter((t) => !hw.value.chores.some((c) => c.name === t.name)));

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}
function touch() {
  store.touch(persona.value);
}
function addTemplate(t: (typeof CHORE_TEMPLATES)[number]) {
  hw.value.chores.push({ ...clone(t), id: uid('chore'), addedAt: Date.now() });
  if (!hw.value.enabled) {
    hw.value.enabled = true;
    showToast('家务系统打开了');
  }
  touch();
}

// —— 编辑一件 ——
const draft = ref<ChoreDef | null>(null);
const isNew = ref(false);
const editOpen = computed({ get: () => !!draft.value, set: (v) => !v && (draft.value = null) });
function edit(c: ChoreDef) {
  draft.value = clone(c);
  isNew.value = false;
}
function addNew(freq: 'daily' | 'weekly' = 'daily') {
  draft.value = {
    id: uid('chore'),
    name: '',
    kind: 'other',
    freq,
    slots: freq === 'daily' ? ['evening'] : ['any'],
    days: freq === 'daily' ? [] : [6],
    perWeek: 1,
    minutes: 15,
    effect: 'nag',
    effectNote: '',
    addedAt: Date.now(),
  };
  isNew.value = true;
}
function setKind(k: ChoreKind) {
  const d = draft.value;
  if (!d) return;
  // 没特意改过"没做时"的，跟着种类换默认的
  if (d.effect === CHORE_KINDS[d.kind].effect) d.effect = CHORE_KINDS[k].effect;
  d.kind = k;
}
function toggleSlot(s: ChoreWhen) {
  const d = draft.value;
  if (!d) return;
  if (d.freq === 'weekly') {
    d.slots = [s];
    return;
  }
  const has = d.slots.includes(s);
  if (has && d.slots.length === 1) return;
  d.slots = has ? d.slots.filter((x) => x !== s) : [...d.slots, s].sort((a, b) => CHORE_WHEN_ORDER.indexOf(a) - CHORE_WHEN_ORDER.indexOf(b));
}
function toggleDay(day: number) {
  const d = draft.value;
  if (!d) return;
  d.days = d.days.includes(day) ? d.days.filter((x) => x !== day) : [...d.days, day].sort();
  if (d.days.length) d.perWeek = d.days.length;
}
const FREQ = [
  { value: 'daily' as const, label: '每天' },
  { value: 'weekly' as const, label: '每周' },
];
const noteLabel = computed(() => {
  const e = draft.value?.effect;
  if (e === 'miss-food') return '她最想吃你做的（可以不填，例如：番茄牛腩）';
  if (e === 'custom') return '她会怎样（例如：不理你，直到你洗完）';
  return '补一句（可以不填）';
});
function save() {
  const d = draft.value;
  if (!d) return;
  d.name = d.name.trim();
  if (!d.name) {
    showToast('写个名字');
    return;
  }
  if (d.effect === 'custom' && !d.effectNote.trim()) {
    showToast('写一下她会怎样');
    return;
  }
  if (d.freq === 'weekly') d.slots = d.slots.slice(0, 1);
  const i = hw.value.chores.findIndex((c) => c.id === d.id);
  if (i >= 0) hw.value.chores[i] = d;
  else {
    hw.value.chores.push(d);
    if (!hw.value.enabled) hw.value.enabled = true;
  }
  draft.value = null;
  touch();
}
function remove() {
  const d = draft.value;
  if (!d) return;
  hw.value.chores = hw.value.chores.filter((c) => c.id !== d.id);
  draft.value = null;
  touch();
}
</script>

<template>
  <div class="page" data-page="persona-housework">
    <PageHeader title="家务系统" :subtitle="`${persona.name} · 每天、每周要做的家务`" fallback="/me/personas" />
    <div class="page-scroll pb-8">
      <div class="mx-4 mt-3 card-box flex items-center gap-3">
        <span class="big-icon"><span class="i-lucide-house-heart" /></span>
        <div class="flex-1 min-w-0">
          <div class="text-[15px] font-600">打开家务系统</div>
          <div class="text-[12px] text-ink-3 leading-relaxed">"共同的家"按下面的清单列出今天要做的；做没做、拖了几次会写进她看到的提示词，影响她怎么跟你说话，也会记进记忆</div>
        </div>
        <van-switch v-model="hw.enabled" size="22px" data-testid="housework-switch" @change="touch" />
      </div>
      <RouterLink v-if="hw.enabled" to="/scene/home?at=real:home" class="go-home mx-4 mt-2"><span class="i-lucide-arrow-right" />去共同的家看今天的清单</RouterLink>

      <div class="group-title">每天<button class="action" data-testid="add-daily" @click="addNew('daily')">加一件</button></div>
      <div class="px-4 grid gap-2">
        <button v-for="c in daily" :key="c.id" class="chore-row press" :data-chore="c.name" @click="edit(c)">
          <span class="chore-icon"><span :class="CHORE_KINDS[c.kind].icon" /></span>
          <span class="flex-1 min-w-0 text-left">
            <span class="block text-[15px] font-600 truncate">{{ c.name }}</span>
            <span class="block text-[12px] text-ink-3 truncate">{{ choreSchedule(c) }} · 约 {{ c.minutes }} 分钟</span>
          </span>
          <span v-if="c.effect !== 'none'" class="tag" :class="{ accent: c.effect !== 'nag' }">没做时：{{ c.effect === 'custom' ? c.effectNote : CHORE_EFFECTS[c.effect].label }}</span>
        </button>
        <p v-if="!daily.length" class="text-[12.5px] text-ink-3 my-1">还没有每天要做的。下面"常用家务"点一下就加上。</p>
      </div>

      <div class="group-title">每周<button class="action" data-testid="add-weekly" @click="addNew('weekly')">加一件</button></div>
      <div class="px-4 grid gap-2">
        <button v-for="c in weekly" :key="c.id" class="chore-row press" :data-chore="c.name" @click="edit(c)">
          <span class="chore-icon"><span :class="CHORE_KINDS[c.kind].icon" /></span>
          <span class="flex-1 min-w-0 text-left">
            <span class="block text-[15px] font-600 truncate">{{ c.name }}</span>
            <span class="block text-[12px] text-ink-3 truncate">{{ choreSchedule(c) }} · {{ CHORE_WHEN[c.slots[0] ?? 'any'].label }} · 约 {{ c.minutes }} 分钟</span>
          </span>
          <span v-if="c.effect !== 'none'" class="tag" :class="{ accent: c.effect !== 'nag' }">没做时：{{ c.effect === 'custom' ? c.effectNote : CHORE_EFFECTS[c.effect].label }}</span>
        </button>
        <p v-if="!weekly.length" class="text-[12.5px] text-ink-3 my-1">还没有每周要做的（洗衣服、换床单、大扫除……）。</p>
      </div>

      <template v-if="templates.length">
        <div class="group-title">常用家务 · 点一下加上</div>
        <div class="px-4 flex flex-wrap gap-2">
          <button v-for="t in templates" :key="t.name" class="tpl press" :data-template="t.name" @click="addTemplate(t)">
            <span :class="CHORE_KINDS[t.kind].icon" />{{ t.name }}<span class="text-ink-3 text-[11.5px]">{{ choreSchedule(t) }}</span>
          </button>
        </div>
      </template>
      <p class="note">家务日和她的节律一样从凌晨 4 点算起：熬夜到一点刷牙，还算前一天的"睡前"。早上的过了 11 点、中午的过了 14 点、晚上的过了 22 点、睡前的过了你的睡觉时间（<RouterLink to="/me/environment" class="text-accent-ink">环境与作息</RouterLink>）还没勾，就算"过了时间没做"。</p>
    </div>

    <van-popup v-model:show="editOpen" position="bottom" round :style="{ maxHeight: '88%' }">
      <div v-if="draft" class="sheet" data-testid="chore-editor">
        <div class="sheet-title">{{ isNew ? '加一件家务' : `改「${draft.name}」` }}</div>
        <label class="field-label" for="chore-name">名字</label>
        <input id="chore-name" v-model="draft.name" class="input" placeholder="例如：洗衣服" maxlength="30" />
        <div class="field-label">种类</div>
        <div class="flex flex-wrap gap-1.5">
          <button v-for="(k, id) in CHORE_KINDS" :key="id" type="button" class="opt" :class="{ on: draft.kind === id }" @click="setKind(id)"><span :class="k.icon" />{{ k.label }}</button>
        </div>
        <div class="field-label">多久做一次</div>
        <Segmented v-model="draft.freq" :options="FREQ" />
        <template v-if="draft.freq === 'daily'">
          <div class="field-label">一天里什么时候（可以选几次）</div>
          <div class="flex flex-wrap gap-1.5">
            <button v-for="w in CHORE_WHEN_ORDER" :key="w" type="button" class="opt" :class="{ on: draft.slots.includes(w) }" @click="toggleSlot(w)"><span :class="CHORE_WHEN[w].icon" />{{ CHORE_WHEN[w].label }}</button>
          </div>
        </template>
        <template v-else>
          <div class="field-label">固定哪几天（都不选 = 哪天都行）</div>
          <div class="flex flex-wrap gap-1.5">
            <button v-for="d in WEEKDAY_ORDER" :key="d" type="button" class="opt day" :class="{ on: draft.days.includes(d) }" @click="toggleDay(d)">{{ WEEKDAY_LABEL[d] }}</button>
          </div>
          <div v-if="!draft.days.length" class="flex items-center gap-2 mt-2.5">
            <span class="text-[13px] text-ink-2">一周</span>
            <van-stepper v-model="draft.perWeek" :min="1" :max="7" integer button-size="26px" />
            <span class="text-[13px] text-ink-2">次</span>
          </div>
          <div class="field-label">那天什么时候</div>
          <div class="flex flex-wrap gap-1.5">
            <button v-for="w in CHORE_WHEN_ORDER" :key="w" type="button" class="opt" :class="{ on: draft.slots[0] === w }" @click="toggleSlot(w)"><span :class="CHORE_WHEN[w].icon" />{{ CHORE_WHEN[w].label }}</button>
          </div>
        </template>
        <div class="flex items-center gap-2 mt-3">
          <span class="text-[13px] text-ink-2">大概要</span>
          <van-stepper v-model="draft.minutes" :min="1" :max="240" :step="5" integer button-size="26px" input-width="44px" />
          <span class="text-[13px] text-ink-2">分钟</span>
        </div>
        <div class="field-label">没做的时候她会</div>
        <div class="flex flex-wrap gap-1.5">
          <button v-for="(e, id) in CHORE_EFFECTS" :key="id" type="button" class="opt" :class="{ on: draft.effect === id }" @click="draft.effect = id as ChoreEffect">{{ e.label }}</button>
        </div>
        <p class="text-[12px] text-ink-3 mt-1.5 mb-0">{{ CHORE_EFFECTS[draft.effect].desc }}；具体怎么说按她的性格（对话预设里"家务：你怎么反应"那一块，能改）</p>
        <label class="field-label" for="chore-note">{{ noteLabel }}</label>
        <input id="chore-note" v-model="draft.effectNote" class="input" maxlength="80" />
        <div class="flex gap-2.5 mt-5">
          <van-button v-if="!isNew" round block @click="remove">删掉</van-button>
          <van-button round block type="primary" data-testid="chore-save" @click="save">好了</van-button>
        </div>
      </div>
    </van-popup>
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
.go-home {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--accent-ink);
  text-decoration: none;
}
.chore-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 12px;
  border-radius: 16px;
  background: var(--surface);
  border: 1px solid var(--border);
}
.chore-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 12px;
  background: var(--panel);
  color: var(--accent-ink);
  font-size: 18px;
  flex-shrink: 0;
}
.tag {
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  flex-shrink: 0;
}
.tpl {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 34px;
  padding: 0 12px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink);
  font-size: 13.5px;
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
.opt.day {
  min-width: 44px;
  justify-content: center;
}
.opt.on {
  background: var(--accent-soft);
  color: var(--accent-ink);
  outline: 1px solid var(--accent-line);
}
</style>
