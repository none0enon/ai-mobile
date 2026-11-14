<script setup lang="ts">
import { NOVELAI_EMOTION_LEVELS, NOVELAI_MODELS, NOVELAI_SAMPLERS, NOVELAI_SCHEDULES } from '@app/ai';
import {
  SPRITE_EXPRESSION_METHODS,
  SPRITE_POSE_METHODS,
  spriteFramings,
  spriteLabels,
  spriteParams,
  type Preset,
  type SpriteExpressionMethod,
  type SpriteParams,
  type SpritePoseMethod,
} from '@app/shared';
import { computed, reactive, ref, watch } from 'vue';
import Segmented from '@/components/common/Segmented.vue';

/**
 * 立绘预设的出图参数（存在预设的 extra.sprite 里）：画底图的模型和尺寸、照着底图换表情 / 换动作的办法、去背景。
 * 改了马上存进预设，下一次画时生效。
 */
const props = defineProps<{ preset: Preset }>();
const emit = defineEmits<{ (e: 'touch'): void }>();

const p = reactive<SpriteParams>(spriteParams(props.preset));
const extraText = ref(JSON.stringify(p.extra, null, 2));
const extraError = ref('');
watch(
  () => props.preset.id,
  () => {
    Object.assign(p, spriteParams(props.preset));
    extraText.value = JSON.stringify(p.extra, null, 2);
    extraError.value = '';
  },
);

function save() {
  props.preset.extra = { ...props.preset.extra, sprite: JSON.parse(JSON.stringify(p)) as SpriteParams };
  emit('touch');
}
function setExtra() {
  const raw = extraText.value.trim();
  try {
    const v = raw ? (JSON.parse(raw) as unknown) : {};
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('要写成一个 JSON 对象');
    p.extra = v as Record<string, unknown>;
    extraError.value = '';
    save();
  } catch (e) {
    extraError.value = e instanceof Error ? e.message : String(e);
  }
}
/** 宽高要是 64 的倍数 */
function snap(k: 'width' | 'height') {
  p[k] = Math.max(64, Math.round(p[k] / 64) * 64);
  save();
}

const framings = computed(() => spriteFramings(props.preset));
const expressions = computed(() => spriteLabels(props.preset, 'expression'));
const poses = computed(() => spriteLabels(props.preset, 'pose'));
const expressionMethods = Object.entries(SPRITE_EXPRESSION_METHODS).map(([value, m]) => ({ value: value as SpriteExpressionMethod, label: m.label }));
const poseMethods = Object.entries(SPRITE_POSE_METHODS).map(([value, m]) => ({ value: value as SpritePoseMethod, label: m.label }));
const pixels = computed(() => p.width * p.height);
</script>

<template>
  <div class="px-4" data-testid="sprite-params">
    <datalist id="sp-models">
      <option v-for="m in NOVELAI_MODELS" :key="m" :value="m" />
    </datalist>

    <div class="sp-title">底图（第一张，透明底）</div>
    <label class="field-label">新画底图默认用哪种构图</label>
    <div class="flex flex-wrap gap-1.5">
      <button v-for="(f, i) in framings" :key="f.name" type="button" class="opt" :class="{ on: p.framing === f.name || (!framings.some((x) => x.name === p.framing) && i === 0) }" @click="(p.framing = f.name), save()">
        {{ f.name }}
      </button>
    </div>
    <p class="sp-note">
      {{ framings.length ? 'App 里的立绘框、头像框都是按半身定的，平时用半身。已经有立绘的角色按它自己的构图画（第一张底图定的），画别的构图时那几张留着备用。' : '预设里还没有构图：在"提示词"里加一块"构图"（半身写 upper body）。' }}
    </p>
    <label class="field-label" for="sp-model">画底图的模型（空着 = 用"生图"的 API 里选的那个）</label>
    <input id="sp-model" v-model.trim="p.model" class="input mono" list="sp-models" autocomplete="off" spellcheck="false" placeholder="nai-diffusion-5-full" @change="save" />
    <p class="sp-note">V5（nai-diffusion-5-…）能直接画透明背景（画法里写 transparent background、has alpha）；V4.5 及更早的不能，画完按下面的开关去背景。</p>
    <div class="sp-row">
      <label class="sp-num">
        <span>宽</span>
        <input v-model.number="p.width" type="number" min="64" step="64" class="input num" @change="snap('width')" />
      </label>
      <label class="sp-num">
        <span>高</span>
        <input v-model.number="p.height" type="number" min="64" step="64" class="input num" @change="snap('height')" />
      </label>
      <label class="sp-num">
        <span>步数</span>
        <input v-model.number="p.steps" type="number" min="1" max="50" class="input num" @change="save" />
      </label>
    </div>
    <p class="sp-note" :class="{ warn: pixels > 1024 * 1024 || p.steps > 28 }">
      {{ pixels > 1024 * 1024 || p.steps > 28 ? '超过 1024×1024 或 28 步：Opus 也要花点数。' : '不超过 1024×1024、28 步。' }}照着底图改（换表情、换动作、去背景）都要花点数，V5 另有用量上限。
    </p>
    <label class="field-label">引导（CFG）{{ p.scale.toFixed(1) }}</label>
    <van-slider v-model="p.scale" :min="0" :max="10" :step="0.1" bar-height="4px" button-size="16px" @change="save" />
    <label class="field-label">采样器</label>
    <div class="flex flex-wrap gap-1.5">
      <button v-for="s in NOVELAI_SAMPLERS" :key="s" type="button" class="opt" :class="{ on: p.sampler === s }" @click="(p.sampler = s), save()">{{ s }}</button>
    </div>
    <label class="field-label">噪声调度</label>
    <div class="flex flex-wrap gap-1.5">
      <button v-for="s in NOVELAI_SCHEDULES" :key="s" type="button" class="opt" :class="{ on: p.noiseSchedule === s }" @click="(p.noiseSchedule = s), save()">{{ s }}</button>
    </div>
    <label class="field-label">底图用哪个表情</label>
    <div class="flex flex-wrap gap-1.5">
      <button v-for="(e, i) in expressions" :key="e.name" type="button" class="opt" :class="{ on: p.baseExpression === e.name || (!expressions.some((x) => x.name === p.baseExpression) && i === 0) }" @click="(p.baseExpression = e.name), save()">
        {{ e.name }}
      </button>
    </div>
    <template v-if="poses.length">
      <label class="field-label">底图用哪个动作</label>
      <div class="flex flex-wrap gap-1.5">
        <button v-for="(x, i) in poses" :key="x.name" type="button" class="opt" :class="{ on: p.basePose === x.name || (!poses.some((y) => y.name === p.basePose) && i === 0) }" @click="(p.basePose = x.name), save()">
          {{ x.name }}
        </button>
      </div>
    </template>
    <p class="sp-note">NovelAI 建议换表情从一张正面、平静的脸开始。</p>

    <div class="sp-title">照着底图换表情</div>
    <Segmented v-model="p.expressionMethod" :options="expressionMethods" @update:model-value="save" />
    <p class="sp-note">{{ SPRITE_EXPRESSION_METHODS[p.expressionMethod].desc }}</p>
    <template v-if="p.expressionMethod !== 'img2img'">
      <label class="field-label">只重画脸：遮罩是头像框的 {{ p.maskScale.toFixed(2) }} 倍</label>
      <van-slider v-model="p.maskScale" :min="1" :max="2.5" :step="0.05" bar-height="4px" button-size="16px" @change="save" />
      <label class="field-label">只重画脸的强度 {{ p.inpaintStrength.toFixed(2) }}（1 = 整块重画；小一点更像原来的脸，但表情变化小）</label>
      <van-slider v-model="p.inpaintStrength" :min="0.1" :max="1" :step="0.01" bar-height="4px" button-size="16px" @change="save" />
      <label class="field-label" for="sp-inpaint">重绘模型（空着 = 画底图的模型的重绘版）</label>
      <input id="sp-inpaint" v-model.trim="p.inpaintModel" class="input mono" autocomplete="off" spellcheck="false" placeholder="nai-diffusion-5-full-inpainting" @change="save" />
    </template>
    <template v-if="p.expressionMethod === 'emotion'">
      <label class="field-label">换表情的强度</label>
      <div class="flex flex-wrap gap-1.5">
        <button v-for="(label, i) in NOVELAI_EMOTION_LEVELS" :key="label" type="button" class="opt" :class="{ on: p.emotionLevel === i }" @click="(p.emotionLevel = i), save()">{{ label }}</button>
      </div>
      <p class="sp-note">每个表情用哪种情绪在"提示词"里那个表情的块上选。</p>
    </template>
    <template v-if="p.expressionMethod === 'img2img'">
      <label class="field-label">图生图的强度 {{ p.img2imgStrength.toFixed(2) }}</label>
      <van-slider v-model="p.img2imgStrength" :min="0.05" :max="0.95" :step="0.01" bar-height="4px" button-size="16px" @change="save" />
    </template>

    <div class="sp-title">照着底图换动作</div>
    <Segmented v-model="p.poseMethod" :options="poseMethods" @update:model-value="save" />
    <p class="sp-note">{{ SPRITE_POSE_METHODS[p.poseMethod].desc }}</p>
    <template v-if="p.poseMethod === 'reference'">
      <label class="field-label" for="sp-ref">精准参考用的模型（只有 V4.5 能用）</label>
      <input id="sp-ref" v-model.trim="p.referenceModel" class="input mono" list="sp-models" autocomplete="off" spellcheck="false" @change="save" />
      <label class="field-label">跟底图有多像 {{ p.referenceStrength.toFixed(2) }}（太高时动作也会照搬）</label>
      <van-slider v-model="p.referenceStrength" :min="0" :max="1" :step="0.01" bar-height="4px" button-size="16px" @change="save" />
      <label class="field-label">保真度 {{ p.referenceFidelity.toFixed(2) }}（越高越难用提示词改）</label>
      <van-slider v-model="p.referenceFidelity" :min="0" :max="1" :step="0.01" bar-height="4px" button-size="16px" @change="save" />
    </template>

    <div class="sp-title">透明背景</div>
    <label class="sp-switch">
      <span class="flex-1 min-w-0">
        <span class="block text-[14px]">画出来不是透明底时去背景</span>
        <span class="block text-[12px] text-ink-3 mt-0.5">用 Director Tools 的去背景（花点数）。V5 直接画透明底时不会再去。</span>
      </span>
      <van-switch v-model="p.removeBackground" size="22px" @change="save" />
    </label>

    <label class="field-label" for="sp-extra">原样并入请求参数（JSON，高级）</label>
    <textarea id="sp-extra" v-model="extraText" class="textarea mono" rows="3" spellcheck="false" @change="setExtra" />
    <p v-if="extraError" class="sp-note warn">{{ extraError }}</p>
  </div>
</template>

<style scoped>
.sp-title {
  margin: 18px 0 2px;
  font-size: 14px;
  font-weight: 600;
}
.sp-title:first-of-type {
  margin-top: 6px;
}
.sp-note {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--ink-3);
}
.sp-note.warn {
  color: var(--warn);
}
.sp-row {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin-top: 10px;
}
.sp-num {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--ink-3);
}
.sp-switch {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 8px;
  padding: 10px 12px;
  border-radius: 14px;
  background: var(--panel);
}
.mono {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 13px;
}
.opt {
  height: 32px;
  padding: 0 12px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 13px;
}
.opt.on {
  background: var(--accent);
  color: var(--on-accent);
  font-weight: 600;
}
</style>
