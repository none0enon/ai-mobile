<script setup lang="ts">
import { SPRITE_EXPRESSION_METHODS, SPRITE_POSE_METHODS, type Character, type Portrait, type PortraitGen } from '@app/shared';
import { showConfirmDialog } from 'vant';
import { computed, ref } from 'vue';
import LabelPicker from './LabelPicker.vue';
import PortraitFigure from '@/components/figure/PortraitFigure.vue';
import { ensureExpression, ensureOutfit, ensurePose, removePortrait } from '@/services/portraits';
import { baseOf, setBase } from '@/services/sprites';
import { useCharacterStore } from '@/stores/characters';

/**
 * 改一张立绘：表情、动作、服装（都能就地新建）、对齐（叠一张参考图看着调）、要不要参与自动挑选。
 * 左右箭头翻到上一张 / 下一张，一口气把一批图标完。
 */
const props = defineProps<{ character: Character; order: string[] }>();
const current = defineModel<string | null>({ required: true });
const chars = useCharacterStore();

const set = computed(() => props.character.portraits);
const p = computed<Portrait | undefined>(() => set.value?.portraits.find((x) => x.id === current.value));
const index = computed(() => props.order.indexOf(current.value ?? ''));
const show = computed({
  get: () => !!p.value,
  set: (v: boolean) => {
    if (!v) current.value = null;
  },
});
function go(step: number) {
  const next = props.order[index.value + step];
  if (next) current.value = next;
}
function touch() {
  props.character.updatedAt = Date.now();
}

/** 这张图选中的表情（写说明用） */
const currentExpr = computed(() => set.value?.expressions.find((e) => e.id === p.value?.expression));
const expression = computed({
  get: () => p.value?.expression ?? '',
  set: (v: string) => {
    if (p.value) p.value.expression = v;
    touch();
  },
});
const pose = computed({
  get: () => p.value?.pose ?? '',
  set: (v: string) => {
    if (p.value) p.value.pose = v;
    touch();
  },
});
const outfit = computed({
  get: () => p.value?.outfit ?? '',
  set: (v: string) => {
    if (p.value) p.value.outfit = v;
    touch();
  },
});
function addExpression(label: string) {
  if (set.value) expression.value = ensureExpression(set.value, label);
}
function addPose(label: string) {
  if (set.value) pose.value = ensurePose(set.value, label);
}
function addOutfit(label: string) {
  if (set.value) outfit.value = ensureOutfit(set.value, label);
}

// —— AI 画的 ——
const GEN_LABEL: Record<PortraitGen['method'], string> = {
  base: '底图',
  ...Object.fromEntries(Object.entries(SPRITE_EXPRESSION_METHODS).map(([k, m]) => [k, `换表情 · ${m.label}`])),
  ...Object.fromEntries(Object.entries(SPRITE_POSE_METHODS).map(([k, m]) => [k, `换动作 · ${m.label}`])),
} as Record<PortraitGen['method'], string>;
const isBase = computed(() => !!p.value && baseOf(props.character)?.id === p.value.id);
function useAsBase() {
  if (p.value) setBase(props.character, p.value.id);
}

// —— 对齐 ——
/** 参考图：排在最前面的另一张（通常是默认的那张） */
const reference = computed(() => set.value?.portraits.find((x) => x.id !== current.value && !x.hidden) ?? null);
const onion = ref(true);
function fitValue(k: 'zoom' | 'x' | 'y'): number {
  const f = p.value?.fit;
  return k === 'zoom' ? Math.round((f?.zoom ?? 1) * 100) : Math.round((f?.[k] ?? 0) * 100);
}
function setFit(k: 'zoom' | 'x' | 'y', v: number) {
  if (!p.value) return;
  const f = { zoom: 1, x: 0, y: 0, ...p.value.fit };
  f[k] = v / 100;
  p.value.fit = f.zoom === 1 && !f.x && !f.y ? undefined : f;
  touch();
}
function resetFit() {
  if (p.value) delete p.value.fit;
  touch();
}

const hidden = computed({
  get: () => !!p.value?.hidden,
  set: (v: boolean) => {
    if (!p.value) return;
    if (v) p.value.hidden = true;
    else delete p.value.hidden;
    touch();
  },
});

async function remove() {
  const target = p.value;
  if (!target) return;
  try {
    await showConfirmDialog({ title: '删掉这张立绘？', message: `「${target.name}」会从这台设备上删掉。`, confirmButtonText: '删掉' });
  } catch {
    return;
  }
  const next = props.order[index.value + 1] ?? props.order[index.value - 1] ?? null;
  await removePortrait(props.character, target.id, chars.list);
  current.value = next && next !== target.id ? next : null;
}

</script>

<template>
  <van-popup v-model:show="show" position="bottom" round closeable :style="{ maxHeight: '92%' }" teleport="body">
    <div v-if="p && set" class="sheet pe" data-testid="portrait-edit">
      <div class="pe-head">
        <button type="button" class="nav" :disabled="index <= 0" aria-label="上一张" @click="go(-1)"><span class="i-lucide-chevron-left" /></button>
        <div class="min-w-0 text-center">
          <div class="sheet-title truncate">{{ p.name }}</div>
          <div class="text-[12px] text-ink-3 num">{{ index + 1 }} / {{ order.length }} · {{ p.width }}×{{ p.height }}</div>
        </div>
        <button type="button" class="nav" :disabled="index >= order.length - 1" aria-label="下一张" @click="go(1)"><span class="i-lucide-chevron-right" /></button>
      </div>

      <div class="pe-stage">
        <div class="pe-box" :style="{ aspectRatio: String(set.aspect) }">
          <div v-if="onion && reference" class="pe-layer pe-ref"><PortraitFigure :character="character" :portrait-id="reference.id" title="参考图" /></div>
          <div class="pe-layer"><PortraitFigure :character="character" :portrait-id="p.id" /></div>
        </div>
      </div>

      <label class="field-label">表情</label>
      <LabelPicker v-model="expression" name="表情" none-label="未标" :options="set.expressions" add-label="新表情" @add="addExpression" />
      <input
        v-if="currentExpr"
        v-model="currentExpr.hint"
        class="input mt-2"
        :placeholder="`「${currentExpr.label}」什么时候用（写给模型看，可以不写）`"
        maxlength="40"
        @input="touch"
      />

      <label class="field-label">动作</label>
      <LabelPicker v-model="pose" name="动作" none-label="不分" :options="set.poses" add-label="新动作" @add="addPose" />

      <label class="field-label">服装</label>
      <LabelPicker v-model="outfit" name="服装" none-label="不分" :options="set.outfits" add-label="新服装" @add="addOutfit" />

      <div class="field-label flex items-center gap-2">
        <span class="flex-1">对齐（构图和别的图不一样时调，切换时不跳）</span>
        <label v-if="reference" class="flex items-center gap-1 text-[12px]"><van-checkbox v-model="onion" icon-size="15px" />叠参考图</label>
        <button type="button" class="text-[12px] text-accent-ink" @click="resetFit">复原</button>
      </div>
      <div class="pe-fit">
        <span>大小</span><van-slider :model-value="fitValue('zoom')" :min="50" :max="200" bar-height="4px" button-size="16px" @update:model-value="(v: number) => setFit('zoom', v)" /><output class="num">{{ fitValue('zoom') }}%</output>
        <span>左右</span><van-slider :model-value="fitValue('x')" :min="-50" :max="50" bar-height="4px" button-size="16px" @update:model-value="(v: number) => setFit('x', v)" /><output class="num">{{ fitValue('x') }}</output>
        <span>上下</span><van-slider :model-value="fitValue('y')" :min="-50" :max="50" bar-height="4px" button-size="16px" @update:model-value="(v: number) => setFit('y', v)" /><output class="num">{{ fitValue('y') }}</output>
      </div>

      <div class="pe-row mt-3">
        <span class="flex-1 text-[13.5px]">留着备用，不参与自动挑选</span>
        <van-switch v-model="hidden" size="20px" aria-label="不参与自动挑选" />
      </div>
      <div class="pe-row mt-2">
        <span class="flex-1 min-w-0">
          <span class="block text-[13.5px]">AI 画立绘时照着这张画</span>
          <span class="block text-[11.5px] text-ink-3">别的表情、动作都照它画（导入的图也行）</span>
        </span>
        <button type="button" class="pe-base" :class="{ on: isBase }" :aria-pressed="isBase" @click="useAsBase">{{ isBase ? '是底图' : '当底图' }}</button>
      </div>
      <div v-if="p.gen" class="pe-gen">
        <div class="text-[12.5px] text-ink-2">AI 画的 · {{ GEN_LABEL[p.gen.method] }}{{ p.gen.removedBg ? ' · 去过背景' : '' }}</div>
        <div class="text-[11.5px] text-ink-3 mt-0.5">{{ p.gen.model }}{{ p.gen.seed ? ` · 种子 ${p.gen.seed}` : '' }}</div>
        <div class="text-[11.5px] text-ink-3 mt-0.5 break-all pe-mono">{{ p.gen.prompt }}</div>
      </div>
      <van-button round block plain type="danger" class="!mt-4" icon="delete-o" @click="remove">删掉这张</van-button>
    </div>
  </van-popup>
</template>

<style scoped>
.pe-base {
  flex-shrink: 0;
  height: 30px;
  padding: 0 12px;
  border-radius: 15px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 12.5px;
}
.pe-base.on {
  background: var(--accent);
  color: var(--on-accent);
  font-weight: 600;
}
.pe-gen {
  margin-top: 10px;
  padding: 8px 10px;
  border-radius: 12px;
  background: var(--panel);
}
.pe-mono {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
}
.pe {
  padding-top: 14px;
}
.pe-head {
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr) 36px;
  align-items: center;
  gap: 8px;
  padding-right: 28px;
}
.nav {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--panel);
  font-size: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.nav:disabled {
  opacity: 0.35;
}
.pe-stage {
  display: flex;
  justify-content: center;
  margin-top: 10px;
  height: 34vh;
  min-height: 200px;
  border-radius: 16px;
  background:
    repeating-conic-gradient(var(--panel) 0 25%, transparent 0 50%) 0 0 / 16px 16px,
    var(--surface);
  overflow: hidden;
}
.pe-box {
  position: relative;
  height: 100%;
  max-width: 100%;
}
.pe-layer {
  position: absolute;
  inset: 0;
}
.pe-ref {
  opacity: 0.35;
  filter: grayscale(1);
}
.pe-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.pe-fit {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) 3em;
  align-items: center;
  gap: 12px 12px;
  font-size: 12.5px;
  color: var(--ink-2);
}
.pe-fit output {
  text-align: right;
}
</style>
