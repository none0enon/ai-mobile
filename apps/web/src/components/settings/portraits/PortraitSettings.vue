<script setup lang="ts">
import {
  availableExpressions,
  availablePoses,
  expressionLabel,
  hasPortraits,
  pickPortrait,
  type Character,
  type PokeHotspot,
} from '@app/shared';
import { showConfirmDialog, showToast } from 'vant';
import { computed, ref } from 'vue';
import LabelPicker from './LabelPicker.vue';
import PortraitEditSheet from './PortraitEditSheet.vue';
import PortraitFrameEditor from './PortraitFrameEditor.vue';
import PortraitLabels from './PortraitLabels.vue';
import PortraitFigure from '@/components/figure/PortraitFigure.vue';
import StageView from '@/components/stage/StageView.vue';
import { dropAsset } from '@/services/assets';
import { importPortraits } from '@/services/portraits';
import { useCharacterStore } from '@/stores/characters';
import { useRhythmStore } from '@/stores/rhythm';

/**
 * 角色编辑 → 立绘：导入（多选、整个文件夹）、点图标表情 / 动作 / 服装、试一试各个模块会挑到哪张、
 * 管理自定义的表情动作服装、拖头像框和热区。张数不限，以后接着导入就是往里加。
 */
const props = defineProps<{ character: Character }>();
const chars = useCharacterStore();
const rhythm = useRhythmStore();
const set = computed(() => (hasPortraits(props.character.portraits) ? props.character.portraits : null));

// —— 导入 ——
const files = ref<HTMLInputElement | null>(null);
const folder = ref<HTMLInputElement | null>(null);
const busy = ref('');
const report = ref<{ text: string; failed: string[] } | null>(null);
async function pick(e: Event) {
  const input = e.target as HTMLInputElement;
  const list = Array.from(input.files ?? []).filter((f) => !f.name.startsWith('.'));
  input.value = '';
  if (!list.length || busy.value) return;
  const c = props.character;
  const before = c.portraits?.portraits.length ?? 0;
  busy.value = `正在导入 0 / ${list.length}`;
  report.value = null;
  try {
    const r = await importPortraits(c, list, (done, total) => (busy.value = `正在导入 ${done} / ${total}`));
    const guessed = r.added.filter((p) => p.expression).length;
    report.value = {
      text: [
        r.added.length ? `导入了 ${r.added.length} 张` : '没有导入新的图',
        r.skipped.length ? `${r.skipped.length} 张已经有了` : '',
        r.added.length ? (guessed === r.added.length ? '按文件名标好了，不对的点图改' : `${guessed ? `${guessed} 张按文件名标好了，` : ''}${r.added.length - guessed} 张还没标表情，点图标一下`) : '',
      ]
        .filter(Boolean)
        .join('；'),
      failed: r.failed.map((f) => `${f.name}：${f.error}`),
    };
    // 第一次导入完直接打开第一张，顺着往下标
    if (!before && r.added[0] && guessed < r.added.length) editing.value = r.added[0].id;
  } catch (err) {
    report.value = { text: '导入失败', failed: [err instanceof Error ? err.message : String(err)] };
  } finally {
    busy.value = '';
  }
}

// —— 列表 ——
const exprOrder = computed(() => ['', ...(set.value?.expressions.map((e) => e.id) ?? [])]);
const sorted = computed(() => {
  const s = set.value;
  if (!s) return [];
  const rank = (list: { id: string }[], id: string) => (id ? list.findIndex((x) => x.id === id) + 1 || 99 : 0);
  return [...s.portraits].sort(
    (a, b) =>
      rank(s.outfits, a.outfit) - rank(s.outfits, b.outfit) ||
      rank(s.poses, a.pose) - rank(s.poses, b.pose) ||
      exprOrder.value.indexOf(a.expression) - exprOrder.value.indexOf(b.expression),
  );
});
const order = computed(() => sorted.value.map((p) => p.id));
const editing = ref<string | null>(null);
function caption(p: { expression: string; pose: string; outfit: string }): string {
  const s = set.value;
  return [
    expressionLabel(p.expression, s),
    s?.poses.find((x) => x.id === p.pose)?.label,
    (s?.outfits.length ?? 0) > 1 ? s?.outfits.find((x) => x.id === p.outfit)?.label : '',
  ]
    .filter(Boolean)
    .join(' · ');
}
const stats = computed(() => {
  const s = set.value;
  if (!s) return '';
  return [`${s.portraits.length} 张`, `${availableExpressions(s).length} 种表情`, s.poses.length ? `${availablePoses(s).length} 个动作` : '', s.outfits.length > 1 ? `${s.outfits.length} 套服装` : '']
    .filter(Boolean)
    .join(' · ');
});

// —— 试一试 ——
const tryExpr = ref<string>(props.character.portraits?.defaultExpression ?? '');
const tryPose = ref('');
const tryOutfit = ref('');
const trySeed = ref(0);
const tryExprOptions = computed(() => {
  const have = new Set(availableExpressions(set.value).map((e) => e.id));
  return (set.value?.expressions ?? []).map((e) => ({ id: e.id, label: e.label, dim: !have.has(e.id) }));
});
const dayOutfit = computed(() => rhythm.outfitFor(props.character.id, null));
const tryWant = computed(() => ({
  expression: tryExpr.value,
  pose: tryPose.value || 'stand',
  outfit: tryOutfit.value || null,
  dayOutfit: tryOutfit.value ? undefined : dayOutfit.value,
  currentPose: chars.pose[props.character.id],
  seed: trySeed.value,
}));
const tried = computed(() => (set.value ? pickPortrait(set.value, tryWant.value) : null));
const tryNote = computed(() => {
  const p = tried.value;
  const s = set.value;
  if (!p || !s) return '';
  const same = s.portraits.filter((x) => !x.hidden && x.expression === p.expression && x.pose === p.pose && x.outfit === p.outfit).length;
  const parts = [
    !tryExpr.value || p.expression === tryExpr.value ? '' : `这身、这个动作没有「${expressionLabel(tryExpr.value, s)}」的图，用了「${expressionLabel(p.expression, s)}」`,
    same > 1 ? `这个样子有 ${same} 张，换表情时轮着用` : '',
  ].filter(Boolean);
  return `${p.name}${parts.length ? ` · ${parts.join('；')}` : ''}`;
});
const showSpots = ref(false);
/** 预览里戳一下：换成那个热区的表情，看看对不对 */
function onPoke(h: PokeHotspot, kind: 'tap' | 'long') {
  const r = kind === 'long' && h.longPress ? h.longPress : h.tap;
  tryExpr.value = r.expression;
}

// —— 全删 ——
async function clearAll() {
  const c = props.character;
  const s = c.portraits;
  if (!s) return;
  try {
    await showConfirmDialog({ title: `删掉${c.name}的全部立绘？`, message: `${s.portraits.length} 张图和自己加的表情、动作、服装都会删掉，换回占位立绘。`, confirmButtonText: '全部删掉' });
  } catch {
    return;
  }
  const keys = s.portraits.map((p) => p.assetKey);
  delete c.portraits;
  c.updatedAt = Date.now();
  const used = new Set(chars.list.flatMap((o) => o.portraits?.portraits.map((p) => p.assetKey) ?? []));
  for (const k of new Set(keys)) if (!used.has(k)) await dropAsset(k);
  showToast('删掉了');
}
</script>

<template>
  <div class="portrait-settings" data-testid="portrait-settings">
    <p class="ps-intro">
      一张图就是一个样子（表情 + 动作 + 服装画在一起）。张数不限，以后接着导入就是往里加。表情、动作、服装都是{{ character.name }}自己的，名字和个数随你：点图标上，聊天、剧场、一起做事、通话、头像都按此刻的表情和场景挑最合适的那张。
    </p>
    <input ref="files" hidden type="file" accept="image/*" multiple aria-label="导入立绘图片" data-testid="portrait-upload" @change="pick" />
    <input ref="folder" hidden type="file" webkitdirectory multiple aria-label="导入立绘文件夹" @change="pick" />
    <div class="ps-actions">
      <van-button round type="primary" icon="photo-o" :loading="!!busy" :loading-text="busy" @click="files?.click()">{{ set ? '接着导入' : '导入立绘' }}（可多选）</van-button>
      <van-button round :disabled="!!busy" @click="folder?.click()">选文件夹</van-button>
    </div>
    <p class="ps-hint">
      文件名按 <code>服装_动作_表情</code>、<code>动作_表情</code> 或 <code>表情</code> 写会自动标好，表情、动作、服装的名字就用文件名里的（SillyTavern 表情文件夹也能直接导）。只有编号的导入后点图标。透明背景的 PNG / WebP 最好，长边超过 2048 会缩小。
    </p>
    <div v-if="report" class="ps-report" role="status">
      <div>{{ report.text }}</div>
      <div v-for="f in report.failed" :key="f" class="text-bad">{{ f }}</div>
    </div>

    <template v-if="set">
      <div class="ps-title"><span>试一试</span><span class="text-[12px] text-ink-3 font-400">{{ stats }}</span></div>
      <div class="ps-stage">
        <StageView
          :character="character"
          :expression="tryExpr"
          :pose="tryPose || 'stand'"
          :outfit="tryOutfit || undefined"
          :day-outfit="tryOutfit ? undefined : dayOutfit"
          :seed="trySeed"
          backdrop="room"
          :pokeable="showSpots"
          :show-hotspots="showSpots"
          :layout="{ left: 50, bottom: 0, height: 100 }"
          @poke="onPoke"
        />
        <button type="button" class="ps-cycle" aria-label="同一个样子换一张" @click="trySeed++"><span class="i-lucide-shuffle" /></button>
        <button type="button" class="ps-spots" :class="{ on: showSpots }" :aria-pressed="showSpots" @click="showSpots = !showSpots"><span class="i-lucide-scan" />热区</button>
      </div>
      <div class="ps-note" data-testid="portrait-picked">{{ tryNote }}</div>
      <template v-if="tryExprOptions.length">
        <label class="field-label">表情</label>
        <LabelPicker v-model="tryExpr" name="试表情" :options="tryExprOptions" />
      </template>
      <template v-if="set.poses.length">
        <label class="field-label">动作</label>
        <LabelPicker v-model="tryPose" name="试动作" none-label="自动" :options="set.poses" />
      </template>
      <template v-if="set.outfits.length > 1">
        <label class="field-label">服装</label>
        <LabelPicker v-model="tryOutfit" name="试服装" :none-label="dayOutfit ? `按节律（今天穿${dayOutfit.name}）` : '默认'" :options="set.outfits" />
      </template>

      <div class="ps-title"><span>全部立绘</span><span class="text-[12px] text-ink-3 font-400">点图标表情、动作、服装</span></div>
      <div class="ps-grid">
        <button v-for="p in sorted" :key="p.id" type="button" class="ps-cell" :class="{ hidden: p.hidden, picked: tried?.id === p.id }" :aria-label="`${p.name}：${caption(p)}`" @click="editing = p.id">
          <span class="ps-thumb" :style="{ aspectRatio: String(set.aspect) }"><PortraitFigure :character="character" :portrait-id="p.id" /></span>
          <span class="ps-cap">{{ caption(p) }}</span>
          <span v-if="p.hidden" class="ps-badge i-lucide-eye-off" />
        </button>
      </div>

      <details class="ps-more">
        <summary>表情、动作、服装</summary>
        <PortraitLabels :character="character" />
      </details>
      <details class="ps-more">
        <summary>头像框和戳戳乐热区</summary>
        <PortraitFrameEditor :character="character" />
      </details>
      <button type="button" class="ps-clear" @click="clearAll">删掉全部立绘</button>
    </template>
    <div v-else class="ps-empty">
      <div class="ps-empty-fig"><PortraitFigure :character="character" expression="smile" /></div>
      <p>还没有立绘，现在用的是占位立绘。</p>
    </div>

    <PortraitEditSheet v-model="editing" :character="character" :order="order" />
  </div>
</template>

<style scoped>
.portrait-settings {
  padding: 4px 16px 24px;
}
.ps-intro {
  font-size: 13px;
  line-height: 1.7;
  margin: 10px 0;
}
.ps-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.ps-hint,
.ps-note {
  font-size: 12px;
  line-height: 1.6;
  color: var(--ink-3);
}
.ps-hint code {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 11.5px;
}
.ps-note {
  margin-top: 6px;
  min-height: 1.6em;
  overflow-wrap: anywhere;
}
.ps-report {
  padding: 10px 12px;
  border-radius: 14px;
  background: var(--panel);
  font-size: 13px;
  line-height: 1.6;
}
.ps-title {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin: 20px 0 8px;
  font-size: 14px;
  font-weight: 600;
}
.ps-stage {
  position: relative;
  height: 360px;
  border-radius: 18px;
  overflow: hidden;
}
.ps-cycle {
  position: absolute;
  right: 10px;
  top: 10px;
  z-index: 2;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: rgba(12, 10, 22, 0.45);
  color: #fff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.ps-spots {
  position: absolute;
  left: 10px;
  top: 10px;
  z-index: 2;
  height: 30px;
  padding: 0 10px;
  border-radius: 15px;
  background: rgba(12, 10, 22, 0.45);
  color: #fff;
  font-size: 12px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.ps-spots.on {
  background: var(--accent);
  color: var(--on-accent);
}
.ps-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}
.ps-cell {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px;
  border-radius: 14px;
  background: var(--panel);
  text-align: center;
}
.ps-cell.picked {
  box-shadow: inset 0 0 0 2px var(--accent);
}
.ps-cell.hidden .ps-thumb {
  opacity: 0.45;
}
.ps-thumb {
  position: relative;
  display: block;
  width: 100%;
  border-radius: 10px;
  overflow: hidden;
  background: linear-gradient(180deg, var(--surface), var(--accent-soft));
}
.ps-cap {
  font-size: 11.5px;
  color: var(--ink-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ps-badge {
  position: absolute;
  right: 10px;
  top: 10px;
  color: var(--ink-2);
}
.ps-more {
  margin-top: 16px;
  padding: 12px;
  border-radius: 16px;
  border: 1px solid var(--border);
  background: var(--surface);
}
.ps-more summary {
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.ps-more[open] summary {
  margin-bottom: 12px;
}
.ps-clear {
  display: block;
  margin: 18px auto 0;
  color: var(--bad);
  font-size: 13px;
}
.ps-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  margin-top: 14px;
  color: var(--ink-3);
  font-size: 13px;
}
.ps-empty-fig {
  width: 132px;
  aspect-ratio: 600 / 1000;
}
</style>
