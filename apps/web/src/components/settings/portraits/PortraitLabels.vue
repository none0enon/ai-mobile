<script setup lang="ts">
import { autoExpressionForMood, EXPRESSION_LABELS, EXPRESSIONS, expressionLabel, OUTFIT_KINDS, POSES, type Character, type Expression, type OutfitKind, type Pose, type PortraitPose } from '@app/shared';
import { showConfirmDialog } from 'vant';
import { computed } from 'vue';
import { ensureExpression, ensureOutfit, ensurePose, removeLabel, renameLabel } from '@/services/portraits';

/**
 * 这个角色自己的表情、动作、服装：改名字（模型写的 id 跟着改）、写给模型看的说明、默认的那个、动作适合哪些场景、服装对节律衣柜的哪几身。
 * 删掉一个标签时，用着它的图改成未标表情 / 默认动作 / 默认服装，图不删。
 */
const props = defineProps<{ character: Character }>();
const set = computed(() => props.character.portraits!);
const count = (k: 'expression' | 'pose' | 'outfit', id: string) => set.value.portraits.filter((p) => p[k] === id).length;
function touch() {
  props.character.updatedAt = Date.now();
}

const KIND_NAME = { expression: '表情', pose: '动作', outfit: '服装' } as const;
async function drop(kind: 'expression' | 'pose' | 'outfit', id: string, label: string) {
  const n = count(kind, id);
  try {
    await showConfirmDialog({
      title: `删掉${KIND_NAME[kind]}「${label}」？`,
      message: n ? `有 ${n} 张图用着它，会改成${kind === 'expression' ? '未标表情' : `默认的${KIND_NAME[kind]}`}。图不会删。` : '没有图用着它。',
      confirmButtonText: '删掉',
    });
  } catch {
    return;
  }
  removeLabel(props.character, kind, id);
}

function rename(kind: 'expression' | 'pose' | 'outfit', id: string, e: Event) {
  const input = e.target as HTMLInputElement;
  renameLabel(props.character, kind, id, input.value);
  // 清空了就恢复原来的名字
  const list: { id: string; label: string }[] = kind === 'expression' ? set.value.expressions : kind === 'pose' ? set.value.poses : set.value.outfits;
  input.value = list.find((x) => x.id === id || x.label === input.value.trim())?.label ?? input.value;
}

function add(kind: 'expression' | 'pose' | 'outfit') {
  const name = `新${KIND_NAME[kind]}`;
  if (kind === 'expression') ensureExpression(set.value, labelFree(set.value.expressions, name));
  else if (kind === 'pose') ensurePose(set.value, labelFree(set.value.poses, name));
  else ensureOutfit(set.value, labelFree(set.value.outfits, name));
  touch();
}
function labelFree(list: { label: string }[], name: string): string {
  let label = name;
  for (let i = 2; list.some((x) => x.label === label); i++) label = `${name}${i}`;
  return label;
}

// —— 程序自己换表情的时刻 ——
/** 每种情绪现在用她的哪个表情：'__auto' = 按名字自动，'' = 不换 */
function momentValue(m: Expression): string {
  const own = set.value.moments?.[m];
  return own === undefined ? '__auto' : own;
}
function setMoment(m: Expression, v: string) {
  const s = set.value;
  if (v === '__auto') {
    if (s.moments) delete s.moments[m];
  } else s.moments = { ...s.moments, [m]: v };
  touch();
}
function autoText(m: Expression): string {
  const id = autoExpressionForMood(m, set.value);
  return id ? `自动：${expressionLabel(id, set.value)}` : '自动：对不上，不换';
}
const POSE_FITS = Object.entries(POSES) as [Pose, string][];
const KINDS = Object.entries(OUTFIT_KINDS) as [OutfitKind, string][];

function toggleFit(p: PortraitPose, f: Pose) {
  const fits = new Set(p.fits ?? []);
  if (fits.has(f)) fits.delete(f);
  else fits.add(f);
  if (fits.size) p.fits = POSE_FITS.map(([k]) => k).filter((k) => fits.has(k));
  else delete p.fits;
  touch();
}
const unlabeled = computed(() => count('expression', ''));
</script>

<template>
  <div class="labels">
    <section>
      <div class="lb-title"><span>表情</span><button type="button" class="lb-add" @click="add('expression')"><span class="i-lucide-plus" />新表情</button></div>
      <p class="lb-note">
        {{ character.name }}有哪些表情就是这里这些，名字、个数都随你；给模型的提示里只列有图的。{{ unlabeled ? `还有 ${unlabeled} 张图没标表情。` : '' }}
      </p>
      <div v-for="e in set.expressions" :key="e.id" class="lb-card">
        <div class="lb-row">
          <input :value="e.label" class="input lb-name" aria-label="表情名字" maxlength="16" @change="rename('expression', e.id, $event)" />
          <span class="text-[12px] text-ink-3 num shrink-0">{{ count('expression', e.id) }} 张</span>
          <button type="button" class="lb-def" :class="{ on: set.defaultExpression === e.id }" :aria-pressed="set.defaultExpression === e.id" @click="(set.defaultExpression = e.id), touch()">默认</button>
          <button type="button" class="lb-del" :aria-label="`删掉表情${e.label}`" @click="drop('expression', e.id, e.label)"><span class="i-lucide-trash-2" /></button>
        </div>
        <input v-model="e.hint" class="input" placeholder="什么时候用（写给模型看，可以不写）" maxlength="40" @input="touch" />
        <div class="lb-id">模型写 <code>[expr:{{ e.id }}]</code></div>
      </div>
      <details v-if="set.expressions.length" class="lb-moments">
        <summary>App 自己换表情的时候用哪个</summary>
        <p class="lb-note">
          戳一下、练完、碰杯、睡着这些时候是程序在换表情，它只会说下面这几种情绪。默认按名字去{{ character.name }}的表情里找对得上的，对不上就不换；想换成别的在这里选。
        </p>
        <label v-for="m in EXPRESSIONS" :key="m" class="lb-row lb-moment">
          <span class="lb-key w-[3.5em]">{{ EXPRESSION_LABELS[m] }}</span>
          <select :value="momentValue(m)" :aria-label="`程序要${EXPRESSION_LABELS[m]}时用哪个表情`" @change="setMoment(m, ($event.target as HTMLSelectElement).value)">
            <option value="__auto">{{ autoText(m) }}</option>
            <option value="">不换</option>
            <option v-for="e in set.expressions" :key="e.id" :value="e.id">{{ e.label }}</option>
          </select>
        </label>
      </details>
    </section>

    <section>
      <div class="lb-title"><span>动作</span><button type="button" class="lb-add" @click="add('pose')"><span class="i-lucide-plus" />新动作</button></div>
      <p v-if="!set.poses.length" class="lb-note">没分动作。托腮、抱臂这样的不同动作分开标上，聊天里她能自己换（[pose:动作]），一起做事时按"适合"挑。</p>
      <div v-for="p in set.poses" :key="p.id" class="lb-card">
        <div class="lb-row">
          <input :value="p.label" class="input lb-name" aria-label="动作名字" maxlength="16" @change="rename('pose', p.id, $event)" />
          <span class="text-[12px] text-ink-3 num shrink-0">{{ count('pose', p.id) }} 张</span>
          <button type="button" class="lb-def" :class="{ on: set.defaultPose === p.id }" :aria-pressed="set.defaultPose === p.id" @click="(set.defaultPose = p.id), touch()">默认</button>
          <button type="button" class="lb-del" :aria-label="`删掉动作${p.label}`" @click="drop('pose', p.id, p.label)"><span class="i-lucide-trash-2" /></button>
        </div>
        <input v-model="p.hint" class="input" placeholder="什么时候换成这个动作（写给模型看）" maxlength="40" @input="touch" />
        <div class="lb-row flex-wrap">
          <span class="lb-key">适合</span>
          <button v-for="[k, l] in POSE_FITS" :key="k" type="button" class="lb-chip" :class="{ on: p.fits?.includes(k) }" :aria-pressed="!!p.fits?.includes(k)" @click="toggleFit(p, k)">{{ l }}</button>
        </div>
        <div class="lb-id">{{ p.fits?.length ? '一起做这些事时优先用它' : '哪儿都能用' }} · 模型写 <code>[pose:{{ p.id }}]</code></div>
      </div>
    </section>

    <section>
      <div class="lb-title"><span>服装</span><button type="button" class="lb-add" @click="add('outfit')"><span class="i-lucide-plus" />新服装</button></div>
      <p v-if="!set.outfits.length" class="lb-note">没分服装。有好几身时分开标上：先按节律里今天穿的那身对名字，对不上按用途挑（健身穿运动的、哄睡穿睡衣）。</p>
      <div v-for="o in set.outfits" :key="o.id" class="lb-card">
        <div class="lb-row">
          <input :value="o.label" class="input lb-name" aria-label="服装名字" maxlength="16" @change="rename('outfit', o.id, $event)" />
          <span class="text-[12px] text-ink-3 num shrink-0">{{ count('outfit', o.id) }} 张</span>
          <button type="button" class="lb-def" :class="{ on: set.defaultOutfit === o.id }" :aria-pressed="set.defaultOutfit === o.id" @click="(set.defaultOutfit = o.id), touch()">默认</button>
          <button type="button" class="lb-del" :aria-label="`删掉服装${o.label}`" @click="drop('outfit', o.id, o.label)"><span class="i-lucide-trash-2" /></button>
        </div>
        <div class="lb-row flex-wrap">
          <span class="lb-key">用途</span>
          <button v-for="[k, l] in KINDS" :key="k" type="button" class="lb-chip" :class="{ on: o.kind === k }" :aria-pressed="o.kind === k" @click="(o.kind = o.kind === k ? undefined : k), touch()">{{ l }}</button>
        </div>
        <input v-model="o.match" class="input" placeholder="节律衣柜里对应的名字、别名（逗号分隔，如：铠甲,战甲,armor）" @input="touch" />
      </div>
    </section>
  </div>
</template>

<style scoped>
.labels {
  display: grid;
  gap: 18px;
}
.lb-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 8px;
}
.lb-add {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 12.5px;
  font-weight: 400;
  color: var(--accent-ink);
}
.lb-note {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--ink-3);
}
.lb-card {
  display: grid;
  gap: 8px;
  margin-top: 10px;
  padding: 10px;
  border-radius: 14px;
  background: var(--panel);
}
.lb-card .input {
  background: var(--surface);
  height: 36px;
}
.lb-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.lb-name {
  flex: 1;
  min-width: 0;
  font-weight: 600;
}
.lb-key {
  font-size: 12.5px;
  color: var(--ink-2);
  flex-shrink: 0;
}
.lb-row select {
  flex: 1;
  min-width: 0;
  padding: 7px 4px;
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--ink);
  background: var(--surface);
}
.lb-chip,
.lb-def {
  height: 26px;
  padding: 0 10px;
  border-radius: 99px;
  background: var(--surface);
  color: var(--ink-2);
  font-size: 12.5px;
  flex-shrink: 0;
}
.lb-chip.on,
.lb-def.on {
  background: var(--accent);
  color: var(--on-accent);
}
.lb-moments {
  margin-top: 12px;
}
.lb-moments summary {
  font-size: 13px;
  color: var(--accent-ink);
  cursor: pointer;
}
.lb-moment {
  margin-top: 8px;
}
.lb-del {
  color: var(--ink-3);
  font-size: 16px;
  padding: 4px;
}
.lb-id {
  font-size: 11.5px;
  color: var(--ink-3);
}
.lb-id code {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
}
</style>
