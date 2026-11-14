<script setup lang="ts">
import { expressionMood, hasPortraits, pickPortrait, type Character, type DayOutfit, type Portrait } from '@app/shared';
import { computed, ref, watch } from 'vue';
import CharacterFigure from './CharacterFigure.vue';
import { FIGURE } from '@/mock/characters';
import { portraitSrc } from '@/services/portraits';
import { useCharacterStore } from '@/stores/characters';

/**
 * 她的样子（各个模块共用）：有立绘时在她的立绘里挑一张（pickPortrait：表情、场景姿势、场景服装、节律里今天那套），
 * 没有立绘时画占位立绘。换图先解码再交叉淡化，不闪白。
 * - crop="full"：铺满外面的立绘框（框的宽高比用 portraitAspect()，底边居中对齐，每张图按自己的对齐参数缩放平移）；
 * - crop="head"：按头像框裁成方的（头像、表情缩略图）。
 * portraitId 指定一张（编辑页的缩略图），不走挑选。
 */
const props = withDefaults(
  defineProps<{
    character: Character;
    expression?: string | null;
    pose?: string | null;
    outfit?: string | null;
    dayOutfit?: DayOutfit;
    crop?: 'full' | 'head';
    portraitId?: string | null;
    /** 不给时用这个角色换表情的次数（同一个表情的几张轮着用） */
    seed?: number;
    title?: string;
  }>(),
  { expression: null, pose: null, outfit: null, crop: 'full', portraitId: null, title: '' },
);

const chars = useCharacterStore();
const set = computed(() => (hasPortraits(props.character.portraits) ? props.character.portraits : null));
const chosen = computed<Portrait | null>(() => {
  const s = set.value;
  if (!s) return null;
  if (props.portraitId) return s.portraits.find((p) => p.id === props.portraitId) ?? null;
  return pickPortrait(s, {
    expression: props.expression,
    pose: props.pose,
    outfit: props.outfit,
    dayOutfit: props.dayOutfit,
    currentPose: chars.pose[props.character.id],
    seed: props.seed ?? chars.expressionSeq[props.character.id] ?? 0,
  });
});

/** 正在显示的那张（新的一张解码好了才换上） */
const shown = ref<{ p: Portrait; src: string } | null>(null);
const missing = ref(false);
let token = 0;
watch(
  chosen,
  async (p) => {
    const mine = ++token;
    if (!p) {
      shown.value = null;
      return;
    }
    const src = await portraitSrc(p.assetKey);
    if (mine !== token) return;
    missing.value = !src;
    shown.value = src ? { p, src } : null;
  },
  { immediate: true },
);

function imgStyle(p: Portrait) {
  const f = p.fit;
  if (!f || (f.zoom === 1 && !f.x && !f.y)) return undefined;
  return { transform: `translate(${f.x * 100}%, ${f.y * 100}%) scale(${f.zoom})` };
}

/** 头像框：把立绘框放大、挪到脸在正中间 */
const headBox = computed(() => {
  const s = set.value;
  if (!s) return undefined;
  const { x, y, size } = s.face;
  const w = 100 / size;
  const h = 100 / (size * s.aspect);
  return { width: `${w}%`, height: `${h}%`, left: `${50 - x * w}%`, top: `${50 - y * h}%` };
});

const placeholder = computed(() => FIGURE[props.character.id] ?? { hairStyle: 'long' as const, eye: '#3b2531' });
const placeholderExpr = computed(() => expressionMood(props.expression, props.character.portraits));
const label = computed(() => props.title || `${props.character.name}的${props.crop === 'head' ? '头像' : '立绘'}`);
</script>

<template>
  <div v-if="set" class="portrait" :class="crop" role="img" :aria-label="label">
    <div class="frame" :style="crop === 'head' ? headBox : undefined">
      <Transition name="pxfade">
        <img v-if="shown" :key="shown.p.id" :src="shown.src" class="layer" :style="imgStyle(shown.p)" alt="" draggable="false" />
      </Transition>
    </div>
    <span v-if="missing" class="lost i-lucide-image-off" title="本机找不到这张立绘了，重新导入一下" />
  </div>
  <div v-else class="portrait" :class="crop">
    <Transition name="pxfade">
      <div :key="`${placeholderExpr}-${outfit}-${pose}`" class="layer">
        <CharacterFigure
          :accent="character.accent"
          :hair="character.hairColor"
          :eye="placeholder.eye"
          :hair-style="placeholder.hairStyle"
          :expression="placeholderExpr"
          :outfit="outfit ?? 'daily'"
          :pose="pose ?? 'stand'"
          :crop="crop"
          :title="`${label}（占位）`"
        />
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.portrait {
  position: relative;
  width: 100%;
  height: 100%;
}
.portrait.head {
  overflow: hidden;
}
.frame {
  position: absolute;
  inset: 0;
}
.head .frame {
  inset: auto;
}
.layer {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
img.layer {
  object-fit: contain;
  object-position: 50% 100%;
  transform-origin: 50% 100%;
  user-select: none;
  -webkit-user-drag: none;
  pointer-events: none;
}
.lost {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  font-size: 22px;
  color: var(--ink-3);
}
.pxfade-enter-active,
.pxfade-leave-active {
  transition: opacity 0.26s ease;
}
.pxfade-enter-from,
.pxfade-leave-to {
  opacity: 0;
}
</style>
