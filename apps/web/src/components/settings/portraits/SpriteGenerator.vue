<script setup lang="ts">
import { errorReport, errorText, isNovelaiV5, NOVELAI_EMOTION_LEVELS } from '@app/ai';
import { imageAppearance, SPRITE_EXPRESSION_METHODS, SPRITE_POSE_METHODS, spriteBaseLabel, type Character, type SpriteLabel } from '@app/shared';
import { showToast } from 'vant';
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import LooksWriter from './LooksWriter.vue';
import ErrorDetails from '@/components/common/ErrorDetails.vue';
import ImagePick from '@/components/common/ImagePick.vue';
import PortraitFigure from '@/components/figure/PortraitFigure.vue';
import { portraitSrc } from '@/services/portraits';
import {
  acceptBase,
  addLabelToPreset,
  baseOf,
  customLabel,
  drawBase,
  drawExpression,
  drawPose,
  framingOf,
  hasLabel,
  mainFraming,
  maskBox,
  outfitChoices,
  outfitNote,
  presetFramings,
  presetLabels,
  setBase,
  spriteStatus,
  writeLabelTags,
  type SpriteDraft,
  type SpriteOutfit,
} from '@/services/sprites';

/**
 * 角色 → 立绘 → AI 画立绘（NovelAI）：
 * 1. 长相：没有外观 tags 时让 AI 从角色卡、世界书里写（先给你看，能改，"就用这个"才存）；
 * 2. 底图：构图（默认半身：App 里的立绘框、头像框都按半身定；全身也能画）、穿哪身（节律、衣柜、立绘的服装），可以给一张参考图；
 *    画出来是透明底的平静表情（立绘预设里定），看过再用。和这个角色平时的构图不一样的留着备用、不参与自动挑选；
 * 3. 照着底图画表情：预设里的表情一个个画，或者"画没有的"一口气画完；自己起名的表情让 AI 写 tags 再画；
 * 4. 照着底图画动作。
 * 怎么画（tags、模型、换表情的办法）全在立绘预设里，这里只是按钮。
 */
const props = defineProps<{ character: Character; /** 放在折叠的"AI 画立绘"里：不要自己的外框和标题 */ bare?: boolean }>();
const c = computed(() => props.character);
const status = computed(() => spriteStatus(c.value));
const params = computed(() => status.value.params);
const labels = computed(() => presetLabels(c.value));
const base = computed(() => baseOf(c.value));
const baseModel = computed(() => params.value.model || status.value.imageModel);

function fail(e: unknown): { reason: string; detail: string } {
  return { reason: errorText(e), detail: errorReport(e) };
}

// —— 1 长相 ——
const appearance = computed(() => imageAppearance(c.value));
/** 写好外观 tags 时顺带写了一套衣服：画底图默认穿它 */
function onLooks(outfitName: string | null) {
  if (outfitName) pickedOutfit.value = outfitName;
}

// —— 2 底图 ——
const outfits = computed(() => outfitChoices(c.value));
/** 选的那身（按名字记）；'' = 不写衣服 */
const pickedOutfit = ref<string | null>(null);
const outfit = computed<SpriteOutfit | null>(() => {
  if (pickedOutfit.value === '') return null;
  return outfits.value.find((o) => o.name === pickedOutfit.value) ?? outfits.value[0] ?? null;
});
const reference = ref<{ file: File; url: string } | null>(null);
function pickReference(file: File) {
  if (reference.value) URL.revokeObjectURL(reference.value.url);
  reference.value = { file, url: URL.createObjectURL(file) };
}
function clearReference() {
  if (reference.value) URL.revokeObjectURL(reference.value.url);
  reference.value = null;
}
const draft = ref<SpriteDraft | null>(null);
const baseBusy = ref(false);
const baseError = ref<{ reason: string; detail: string } | null>(null);
// 构图：默认是这个角色平时用的（第一张底图定的；还没有立绘时是立绘预设的默认构图，一般是半身）
const framings = computed(() => presetFramings(c.value));
const usual = computed(() => mainFraming(c.value));
const pickedFraming = ref<string | null>(null);
const framing = computed(() => framings.value.find((f) => f.name === (pickedFraming.value ?? usual.value)) ?? framings.value[0] ?? null);
/** 选的构图和这个角色平时用的不一样（已经有立绘时）：画出来留着备用 */
const offFraming = computed(() => !!c.value.portraits?.portraits.length && !!framing.value && framing.value.name !== usual.value);
const baseExpr = computed(() => spriteBaseLabel(labels.value.expressions, params.value.baseExpression)?.name ?? '');
const basePose = computed(() => spriteBaseLabel(labels.value.poses, params.value.basePose)?.name ?? '');
async function makeBase() {
  if (baseBusy.value) return;
  baseBusy.value = true;
  baseError.value = null;
  try {
    const d = await drawBase(c.value, { outfit: outfit.value, framing: framing.value?.name, reference: reference.value?.file ?? null });
    dropDraft();
    draft.value = d;
  } catch (e) {
    baseError.value = fail(e);
  } finally {
    baseBusy.value = false;
  }
}
function dropDraft() {
  if (draft.value) URL.revokeObjectURL(draft.value.url);
  draft.value = null;
}
async function keepDraft() {
  const d = draft.value;
  if (!d) return;
  draft.value = null;
  await acceptBase(c.value, d);
  showToast('底图存好了：接着照着它画表情');
}
onBeforeUnmount(() => {
  dropDraft();
  clearReference();
});

// 底图的样子（直接显示原图，好把重画的那块框出来）
const baseSrc = ref<string | null>(null);
watch(
  () => base.value?.assetKey,
  async (k) => (baseSrc.value = k ? await portraitSrc(k) : null),
  { immediate: true },
);
const mask = computed(() => (params.value.expressionMethod === 'img2img' ? null : maskBox(c.value)));
const pickingBase = ref(false);
function chooseBase(id: string) {
  setBase(c.value, id);
  pickingBase.value = false;
}
const baseCaption = computed(() => {
  const s = c.value.portraits;
  const b = base.value;
  if (!s || !b) return '';
  const name = (list: { id: string; label: string }[], id: string) => list.find((x) => x.id === id)?.label ?? '';
  return [framingOf(c.value, b), name(s.expressions, b.expression), name(s.poses, b.pose), name(s.outfits, b.outfit)].filter(Boolean).join(' · ') || b.name;
});
/** 底图的构图和平时的不一样：照着它画的也留着备用 */
const baseOff = computed(() => !!base.value && framingOf(c.value, base.value) !== usual.value);

// —— 3、4 照着底图画 ——
type RowState = { state: 'waiting' | 'error'; reason?: string; detail?: string };
const rows = reactive<Record<string, RowState | undefined>>({});
const rowKey = (kind: 'expression' | 'pose', name: string) => `${kind}:${name}`;
async function drawOne(kind: 'expression' | 'pose', label: SpriteLabel): Promise<boolean> {
  const k = rowKey(kind, label.name);
  if (rows[k]?.state === 'waiting') return true;
  rows[k] = { state: 'waiting' };
  try {
    const replace = hasLabel(c.value, kind, label.name);
    await (kind === 'expression' ? drawExpression(c.value, label, { replace }) : drawPose(c.value, label, { replace }));
    delete rows[k];
    return true;
  } catch (e) {
    rows[k] = { state: 'error', ...fail(e) };
    return false;
  }
}
const missing = computed(() => labels.value.expressions.filter((l) => !hasLabel(c.value, 'expression', l.name)));
const batch = ref<{ done: number; total: number } | null>(null);
async function drawMissing() {
  if (batch.value) return;
  const todo = missing.value;
  batch.value = { done: 0, total: todo.length };
  try {
    for (const l of todo) {
      if (!(await drawOne('expression', l))) break;
      batch.value.done += 1;
    }
  } finally {
    const finished = batch.value.done;
    batch.value = null;
    showToast(finished === todo.length ? `画好了 ${finished} 个表情` : `画了 ${finished} 个，停在出错的那个`);
  }
}
const expressionNote = computed(() => {
  const p = params.value;
  const m = SPRITE_EXPRESSION_METHODS[p.expressionMethod];
  if (p.expressionMethod === 'emotion') return `${m.label}（强度：${NOVELAI_EMOTION_LEVELS[p.emotionLevel] ?? p.emotionLevel}）：${m.desc}`;
  if (p.expressionMethod === 'inpaint') return `${m.label}（框出来的那块，头像框的 ${p.maskScale} 倍）：${m.desc}。框不对的话在下面"头像框和戳戳乐热区"里拖头像框。`;
  return `${m.label}（强度 ${p.img2imgStrength}）：${m.desc}`;
});

// 自己起名的表情 / 动作
const custom = reactive({ kind: 'expression' as 'expression' | 'pose', name: '', tags: '', hint: '', emotion: '', busy: false, error: null as { reason: string; detail: string } | null });
async function customTags() {
  const name = custom.name.trim();
  if (!name || custom.busy) return;
  custom.busy = true;
  custom.error = null;
  try {
    const r = await writeLabelTags(c.value, custom.kind, name);
    custom.tags = r.value.tags;
    custom.hint = r.value.hint;
    custom.emotion = custom.kind === 'expression' ? r.value.emotion : '';
  } catch (e) {
    custom.error = fail(e);
  } finally {
    custom.busy = false;
  }
}
const customReady = computed(() => !!custom.name.trim() && !!custom.tags.trim());
async function customDraw() {
  if (!customReady.value) return;
  await drawOne(custom.kind, customLabel(custom.name, custom.tags, { hint: custom.hint, emotion: custom.emotion }));
}
function customSave() {
  const preset = status.value.preset;
  if (!preset || !customReady.value) return;
  addLabelToPreset(preset, custom.kind, customLabel(custom.name, custom.tags, { hint: custom.hint, emotion: custom.emotion }));
  showToast(`「${custom.name.trim()}」加进立绘预设了，别的角色也能画`);
}
const customRow = computed(() => rows[rowKey(custom.kind, custom.name.trim())]);
</script>

<template>
  <section class="sg" :class="{ bare }" data-testid="sprite-generator">
    <div v-if="!bare" class="sg-head"><span class="i-lucide-wand-sparkles text-accent-ink" />AI 画立绘（NovelAI）</div>
    <p class="sg-line">
      <template v-if="status.preset">
        立绘预设「{{ status.preset.name }}」· 底图用 <span class="mono">{{ baseModel || '未选模型' }}</span>{{ isNovelaiV5(baseModel) ? '，直接画透明底' : params.removeBackground ? '，画完去背景' : '' }}。
      </template>
      <template v-else>没有立绘预设。</template>
      <RouterLink :to="status.preset ? `/me/presets/${status.preset.id}` : '/me/presets?cat=sprite'" class="text-accent-ink">{{ status.preset ? '改预设' : '去预设' }}</RouterLink>
    </p>
    <p v-if="!status.imageLive" class="sg-warn">
      「生图」还没接通（{{ status.imageReason }}）。<RouterLink to="/me/api?feature=image" class="text-accent-ink">去设置</RouterLink>
    </p>
    <p v-else-if="!status.canEdit" class="sg-warn">「生图」用的不是 NovelAI：能画底图，但照着底图换表情、换动作和去背景要 NovelAI。</p>

    <!-- 1 长相 -->
    <div class="sg-step">
      <div class="sg-step-title"><span class="sg-no">1</span>长相</div>
      <div class="sg-tags mono" :class="{ empty: !appearance }">{{ appearance || '还没有外观 tags' }}</div>
      <LooksWriter :character="character" @applied="onLooks">
        <RouterLink :to="`/me/characters/${character.id}?tab=look`" class="sg-link">自己写 / 同人角色</RouterLink>
      </LooksWriter>
    </div>

    <!-- 2 底图 -->
    <div class="sg-step">
      <div class="sg-step-title"><span class="sg-no">2</span>底图（{{ [framing?.name, baseExpr, basePose].filter(Boolean).join(' · ') || '第一张' }}，透明底）</div>
      <div v-if="base && !draft" class="sg-base">
        <div class="sg-base-img checker" :style="{ aspectRatio: `${base.width} / ${base.height}` }">
          <img v-if="baseSrc" :src="baseSrc" alt="" draggable="false" />
          <span v-if="mask" class="sg-mask" :style="{ left: `${mask.x * 100}%`, top: `${mask.y * 100}%`, width: `${mask.w * 100}%`, height: `${mask.h * 100}%` }" />
        </div>
        <div class="flex-1 min-w-0">
          <div class="text-[13.5px] font-600">现在照着这张画</div>
          <div class="text-[12px] text-ink-3 mt-0.5">{{ baseCaption }}</div>
          <div v-if="mask" class="text-[12px] text-ink-3 mt-1">虚线框是换表情时重画的那块。</div>
          <button type="button" class="sg-link mt-2" @click="pickingBase = !pickingBase">{{ pickingBase ? '收起' : '换一张当底图' }}</button>
        </div>
      </div>
      <div v-if="pickingBase && character.portraits" class="sg-pick">
        <button
          v-for="p in character.portraits.portraits"
          :key="p.id"
          type="button"
          class="sg-pick-cell"
          :class="{ on: base?.id === p.id }"
          :style="{ aspectRatio: String(character.portraits.aspect) }"
          :aria-label="`用 ${p.name} 当底图`"
          @click="chooseBase(p.id)"
        >
          <PortraitFigure :character="character" :portrait-id="p.id" />
        </button>
      </div>

      <template v-if="!draft">
        <template v-if="framings.length">
          <div class="field-label">构图</div>
          <div class="flex flex-wrap gap-1.5" data-testid="sprite-framing">
            <button v-for="f in framings" :key="f.name" type="button" class="opt" :class="{ on: framing?.name === f.name }" :title="f.tags" @click="pickedFraming = f.name">
              {{ f.name }}<span class="opt-sub">{{ f.name === usual ? (character.portraits?.portraits.length ? '平时用' : '默认') : f.tags }}</span>
            </button>
          </div>
          <p v-if="offFraming" class="sg-note text-warn">
            {{ character.name }}平时用「{{ usual }}」（立绘框、头像框按它定）：画好的「{{ framing?.name }}」和照着它画的表情、动作都留着备用，不参与自动挑选，免得换表情时人忽大忽小；要用的话在图上关掉"留着备用"。
          </p>
          <p v-else-if="framing?.hint" class="sg-note">{{ framing.hint }}</p>
        </template>
        <p v-else class="sg-note text-warn">立绘预设里没有构图：去预设里加一块"构图"（半身写 upper body），不然画出来是半身还是全身全看模型。</p>
        <div class="field-label">穿哪身</div>
        <div class="flex flex-wrap gap-1.5">
          <button v-for="o in outfits" :key="`${o.name}|${o.tags}`" type="button" class="opt" :class="{ on: outfit?.name === o.name }" :title="o.tags" @click="pickedOutfit = o.name">
            {{ o.name }}<span class="opt-sub">{{ outfitNote(o) }}</span>
          </button>
          <button type="button" class="opt" :class="{ on: !outfit }" @click="pickedOutfit = ''">不写衣服</button>
        </div>
        <p v-if="!outfits.length" class="sg-note">还没有衣服的 tags：让 AI 写外观 tags 时会顺带写一套，或者去节律建世界（有衣柜）。</p>
        <div class="field-label">参考图（可以不给）</div>
        <div class="flex items-center gap-2.5">
          <ImagePick aria-label="选一张参考图">
            <span class="sg-ref" :class="{ has: reference }">
              <img v-if="reference" :src="reference.url" alt="参考图" />
              <span v-else class="i-lucide-image-plus text-[20px]" />
            </span>
          </ImagePick>
          <div class="flex-1 min-w-0 text-[12px] text-ink-3 leading-relaxed">
            角色卡的原图、别处画的{{ character.name }}：用 V4.5 的精准参考照着画（<span class="mono">{{ params.referenceModel }}</span>），画完去背景。
            <button v-if="reference" type="button" class="sg-link" @click="clearReference">不用参考图</button>
          </div>
        </div>
        <van-button round block type="primary" class="!mt-3" :loading="baseBusy" loading-text="在画…" :disabled="!status.imageLive" data-testid="sprite-base" @click="makeBase">
          {{ base ? '再画一张底图' : '画底图' }}
        </van-button>
      </template>
      <ErrorDetails v-if="baseError" :title="baseError.reason" :detail="baseError.detail" max-height="30vh" />

      <div v-if="draft" class="sg-card" data-testid="sprite-draft">
        <div class="sg-draft">
          <div class="sg-draft-img checker" :style="{ aspectRatio: `${draft.width} / ${draft.height}` }"><img :src="draft.url" alt="画好的底图" /></div>
          <div class="flex-1 min-w-0 text-[12px] text-ink-3 leading-relaxed">
            <div class="text-[13.5px] text-ink font-600">{{ draft.transparent ? '透明底' : '不是透明底' }}{{ draft.gen.removedBg ? '（去过背景）' : '' }}</div>
            <div class="mt-1">{{ draft.gen.model }}{{ draft.gen.seed ? ` · 种子 ${draft.gen.seed}` : '' }}</div>
            <div class="mono mt-1 break-all">{{ draft.gen.prompt }}</div>
            <div v-if="!draft.transparent" class="text-warn mt-1">在立绘预设的出图参数里打开"去背景"，或者底图换成 V5。</div>
          </div>
        </div>
        <div class="flex gap-2 mt-2.5">
          <van-button round block size="small" :loading="baseBusy" @click="makeBase">再画一张</van-button>
          <van-button round block size="small" type="primary" data-testid="sprite-draft-use" @click="keepDraft">用这张当底图</van-button>
        </div>
        <button type="button" class="sg-skip" @click="dropDraft">不要了</button>
      </div>
    </div>

    <!-- 3 表情 -->
    <div v-if="base" class="sg-step">
      <div class="sg-step-title"><span class="sg-no">3</span>照着底图画表情（{{ framingOf(character, base) }}）</div>
      <p class="sg-note">{{ expressionNote }}</p>
      <p v-if="baseOff" class="sg-note text-warn">这张底图是「{{ framingOf(character, base) }}」，{{ character.name }}平时用「{{ usual }}」：照着它画的表情、动作都留着备用。</p>
      <van-button v-if="missing.length" round block type="primary" class="!mt-2" :loading="!!batch" :loading-text="batch ? `在画 ${batch.done + 1} / ${batch.total}` : ''" :disabled="!status.canEdit" data-testid="sprite-missing" @click="drawMissing">
        画没有的（{{ missing.map((l) => l.name).join('、') }}）
      </van-button>
      <div class="sg-rows">
        <div v-for="l in labels.expressions" :key="l.name" class="sg-row">
          <div class="flex-1 min-w-0">
            <div class="text-[14px]">{{ l.name }}<span v-if="hasLabel(character, 'expression', l.name)" class="tag good ml-1.5">有了</span></div>
            <div class="text-[11.5px] text-ink-3 truncate mono">{{ l.tags }}</div>
            <ErrorDetails v-if="rows[rowKey('expression', l.name)]?.state === 'error'" :title="rows[rowKey('expression', l.name)]!.reason" :detail="rows[rowKey('expression', l.name)]!.detail!" max-height="24vh" />
          </div>
          <van-button size="small" round :loading="rows[rowKey('expression', l.name)]?.state === 'waiting'" :disabled="!status.canEdit" @click="drawOne('expression', l)">{{ hasLabel(character, 'expression', l.name) ? '重画' : '画' }}</van-button>
        </div>
      </div>
      <p v-if="!labels.expressions.length" class="sg-note">立绘预设里没有表情：在预设里加几块"表情"。</p>
    </div>

    <!-- 4 动作 -->
    <div v-if="base && labels.poses.length" class="sg-step">
      <div class="sg-step-title"><span class="sg-no">4</span>照着底图画动作</div>
      <p class="sg-note">{{ SPRITE_POSE_METHODS[params.poseMethod].label }}：{{ SPRITE_POSE_METHODS[params.poseMethod].desc }}。画好的动作也能"当底图"，再照着它画这个动作的各个表情。</p>
      <div class="sg-rows">
        <div v-for="l in labels.poses" :key="l.name" class="sg-row">
          <div class="flex-1 min-w-0">
            <div class="text-[14px]">{{ l.name }}<span v-if="hasLabel(character, 'pose', l.name)" class="tag good ml-1.5">有了</span></div>
            <div class="text-[11.5px] text-ink-3 truncate mono">{{ l.tags }}</div>
            <ErrorDetails v-if="rows[rowKey('pose', l.name)]?.state === 'error'" :title="rows[rowKey('pose', l.name)]!.reason" :detail="rows[rowKey('pose', l.name)]!.detail!" max-height="24vh" />
          </div>
          <van-button size="small" round :loading="rows[rowKey('pose', l.name)]?.state === 'waiting'" :disabled="!status.canEdit" @click="drawOne('pose', l)">{{ hasLabel(character, 'pose', l.name) ? '重画' : '画' }}</van-button>
        </div>
      </div>
    </div>

    <!-- 自己起名的 -->
    <details v-if="base" class="sg-custom">
      <summary>画一个预设里没有的表情或动作</summary>
      <div class="flex gap-1.5 mt-2.5">
        <button type="button" class="opt" :class="{ on: custom.kind === 'expression' }" @click="custom.kind = 'expression'">表情</button>
        <button type="button" class="opt" :class="{ on: custom.kind === 'pose' }" @click="custom.kind = 'pose'">动作</button>
      </div>
      <label class="field-label" for="sg-c-name">名字</label>
      <div class="flex gap-2">
        <input id="sg-c-name" v-model="custom.name" class="input flex-1" maxlength="16" :placeholder="custom.kind === 'expression' ? '例如 坏笑、委屈、得意' : '例如 托腮、抱臂'" />
        <van-button size="small" round :loading="custom.busy" :disabled="!custom.name.trim()" @click="customTags">AI 写 tags</van-button>
      </div>
      <label class="field-label" for="sg-c-tags">NovelAI tags（可以自己写）</label>
      <textarea id="sg-c-tags" v-model="custom.tags" class="textarea mono" rows="2" spellcheck="false" />
      <p v-if="custom.hint" class="sg-note">什么时候用：{{ custom.hint }}{{ custom.emotion ? ` · Director Tools 情绪：${custom.emotion}` : '' }}</p>
      <ErrorDetails v-if="custom.error" :title="custom.error.reason" :detail="custom.error.detail" max-height="24vh" />
      <ErrorDetails v-if="customRow?.state === 'error'" :title="customRow.reason" :detail="customRow.detail!" max-height="24vh" />
      <div class="flex gap-2 mt-2.5">
        <van-button round block size="small" :disabled="!customReady || !status.preset" @click="customSave">加进立绘预设</van-button>
        <van-button round block size="small" type="primary" :disabled="!customReady || !status.canEdit" :loading="customRow?.state === 'waiting'" @click="customDraw">照着底图画</van-button>
      </div>
    </details>
  </section>
</template>

<style scoped>
.sg {
  margin-top: 14px;
  padding: 12px;
  border-radius: 18px;
  background: var(--surface);
  border: 1px solid var(--border);
}
.sg.bare {
  margin: 0;
  padding: 0;
  border: 0;
  background: none;
}
.sg.bare > .sg-line {
  margin-top: 0;
}
.sg-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 15px;
  font-weight: 600;
}
.sg-line,
.sg-note {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--ink-3);
}
.sg-warn {
  margin: 8px 0 0;
  padding: 8px 10px;
  border-radius: 12px;
  background: var(--panel);
  color: var(--warn);
  font-size: 12.5px;
  line-height: 1.6;
}
.sg-step {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
.sg-step-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
}
.sg-no {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: 12px;
}
.sg-tags {
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: 12px;
  background: var(--panel);
  font-size: 12.5px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.sg-tags.empty {
  color: var(--ink-3);
}
.sg-link {
  color: var(--accent-ink);
  font-size: 12.5px;
}
.sg-card {
  margin-top: 10px;
  padding: 10px;
  border-radius: 14px;
  background: var(--panel);
}
.sg-skip {
  display: block;
  width: 100%;
  margin-top: 6px;
  font-size: 13px;
  color: var(--ink-3);
}
.checker {
  background-color: var(--surface);
  background-image:
    linear-gradient(45deg, var(--panel) 25%, transparent 25%),
    linear-gradient(-45deg, var(--panel) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, var(--panel) 75%),
    linear-gradient(-45deg, transparent 75%, var(--panel) 75%);
  background-size: 14px 14px;
  background-position:
    0 0,
    0 7px,
    7px -7px,
    -7px 0;
}
.sg-base,
.sg-draft {
  display: flex;
  gap: 12px;
  margin-top: 10px;
}
.sg-base-img,
.sg-draft-img {
  position: relative;
  flex-shrink: 0;
  width: 112px;
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid var(--border);
}
.sg-base-img img,
.sg-draft-img img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: fill;
}
.sg-mask {
  position: absolute;
  border: 1.5px dashed var(--accent);
  border-radius: 4px;
  box-shadow: 0 0 0 999px rgba(0, 0, 0, 0.12);
}
.sg-pick {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 6px;
  margin-top: 10px;
}
.sg-pick-cell {
  position: relative;
  border-radius: 10px;
  overflow: hidden;
  background: var(--panel);
}
.sg-pick-cell.on {
  box-shadow: inset 0 0 0 2px var(--accent);
}
.sg-ref {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  border-radius: 12px;
  border: 1.5px dashed var(--border);
  color: var(--ink-3);
  overflow: hidden;
}
.sg-ref.has {
  border-style: solid;
}
.sg-ref img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.sg-rows {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 6px;
  margin-top: 10px;
}
.sg-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 12px;
  background: var(--panel);
}
.sg-custom {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
.sg-custom summary {
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.opt {
  min-height: 32px;
  padding: 4px 12px;
  border-radius: 16px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 13px;
  text-align: left;
}
.opt.on {
  background: var(--accent);
  color: var(--on-accent);
  font-weight: 600;
}
.opt-sub {
  display: block;
  font-size: 10.5px;
  font-weight: 400;
  opacity: 0.75;
}
.mono {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
}
</style>
