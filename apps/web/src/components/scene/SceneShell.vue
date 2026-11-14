<script setup lang="ts">
import { getLocation, getScene, hasMath, type PokeHotspot, type TimeOfDay } from '@app/shared';
import { showImagePreview, showToast } from 'vant';
import { computed, inject, ref } from 'vue';
import Avatar from '@/components/common/Avatar.vue';
import RichText from '@/components/common/RichText.vue';
import StageView from '@/components/stage/StageView.vue';
import { backdropAt, SCENE_LOCATION, titleAt } from './location';
import { goBack } from '@/router';
import { useAppStore } from '@/stores/app';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';
import { useRealWorldStore } from '@/stores/realworld';
import { useRhythmStore } from '@/stores/rhythm';

/**
 * 所有场景共用的外壳：背景 + 立绘 + 顶栏 + 她的一句话 + 底部场景面板（插槽）。
 * 场景只需要写面板，并告诉外壳用什么服装、姿势、表情；背景和标题默认跟着地图上的地点走。
 * 点她的那句话 → 去你们的聊天（离开了场景页，这件事就结束了）。
 * art：这一刻画好的图（生图）。有图时盖在背景和立绘上面、淡入；还没画好时照常显示立绘（设计文档 §10.3）。点图看大图。
 * drawing：正在画（顶栏右边转圈，文字给读屏和长按提示）。
 * bare：外壳只给背景、立绘和顶栏，她的话、面板、画好的图都由场景自己在 overlay 里摆（陪伴学习的分屏和专注画面）。
 * back：左上角返回做什么（一起游戏打开了一个游戏时回游戏列表）；不给时返回上一页。
 * hideMode：右上角不放"连线 / 坐在她旁边"（健身那里放的是连麦）。
 */
const props = withDefaults(
  defineProps<{
    sceneId: string;
    backdrop?: string;
    tod?: TimeOfDay;
    rain?: boolean;
    dim?: number;
    expression?: string;
    outfit?: string;
    pose?: string;
    line?: string;
    typing?: boolean;
    hideFigure?: boolean;
    /** 面板占满顶栏以下（一起看书翻开书时）：她的那句话放进面板顶上，不压在书页上 */
    fill?: boolean;
    pokeable?: boolean;
    showHotspots?: boolean;
    layout?: { left: number; bottom: number; height: number };
    title?: string;
    art?: { url: string; title?: string } | null;
    drawing?: string | null;
    bare?: boolean;
    back?: (() => void) | null;
    hideMode?: boolean;
  }>(),
  { rain: false, dim: 0, typing: false, hideFigure: false, fill: false, pokeable: false, showHotspots: false, art: null, drawing: null, bare: false, back: null, hideMode: false },
);
const emit = defineEmits<{ (e: 'poke', h: PokeHotspot, kind: 'tap' | 'long'): void }>();

const app = useAppStore();
const chars = useCharacterStore();
const chat = useChatStore();
const scene = computed(() => getScene(props.sceneId));
const location = inject(SCENE_LOCATION, ref(null));
const character = computed(() => chars.byId(app.activeCharacterId) ?? chars.list[0]!);
const chatLink = computed(() => `/chat/${chat.chatOfCharacter(character.value.id)?.id}?mode=stage`);

/** 怎么在一起：连线（你在你那儿）/ 去她那（坐她旁边）/ 带她来（她在你那边） */
const real = useRealWorldStore();
const together = computed(() => chat.chatOfCharacter(character.value.id)?.togetherMode ?? null);
const yourPlace = computed(() => getLocation(real.hereId)?.name ?? '家');
const modeText = computed(() => {
  if (together.value === 'remote') return `连线 · 你在${yourPlace.value}`;
  if (together.value === 'visit') return `坐在${character.value.pronoun}旁边`;
  if (together.value === 'bring') return `${character.value.pronoun}在你这边`;
  return '';
});
function toggleMode() {
  if (together.value === 'remote') {
    chat.setTogetherMode(character.value.id, 'visit');
    showToast(`去${character.value.pronoun}那儿，坐到${character.value.pronoun}旁边`);
  } else if (together.value === 'visit') {
    chat.setTogetherMode(character.value.id, 'remote');
    showToast(`回到连线：你在${yourPlace.value}，${character.value.pronoun}在${location.value?.name ?? '那边'}`);
  }
}
const expr = computed(() => props.expression ?? chars.expression[character.value.id] ?? 'smile');
/** 节律里她今天在这个场景穿的那套：有立绘时按它挑服装 */
const rhythm = useRhythmStore();
const dayOutfit = computed(() => rhythm.outfitFor(character.value.id, props.sceneId));
const layout = computed(() => props.layout ?? { left: 50, bottom: 40, height: 50 });
/** 有画好的图时不画立绘（图里就是她） */
const figureHidden = computed(() => props.hideFigure || !!props.art);
function openArt() {
  if (props.art) showImagePreview({ images: [props.art.url], closeable: true, showIndex: false });
}
</script>

<template>
  <div class="page scene-shell" :data-page="`scene-${sceneId}`" :style="{ '--tint': scene.tint }">
    <StageView
      :character="character"
      :expression="expr"
      :outfit="outfit ?? scene.outfit"
      :pose="pose ?? scene.pose"
      :day-outfit="dayOutfit"
      :backdrop="backdrop ?? backdropAt(location, sceneId)"
      :tod="tod"
      :rain="rain"
      :dim="dim"
      :pokeable="pokeable"
      :show-hotspots="showHotspots"
      :layout="figureHidden ? { left: 50, bottom: 200, height: 1 } : layout"
      @poke="(h, k) => emit('poke', h, k)"
    >
      <Transition name="art">
        <button v-if="art" :key="art.url" type="button" class="scene-art" :aria-label="`看大图：${art.title || character.name}`" @click="openArt">
          <img :src="art.url" :alt="art.title || character.name" />
        </button>
      </Transition>
      <div class="tint" />
      <header class="scene-top">
        <button class="pill" aria-label="返回" @click="back ? back() : goBack('/map')"><span class="i-lucide-chevron-left text-[20px]" /></button>
        <span class="pill title"><span :class="scene.icon" /><span class="truncate">{{ title ?? titleAt(location, sceneId) }}</span></span>
        <span class="flex-1" />
        <button v-if="modeText && !hideMode" class="pill mode" :class="together ?? ''" :disabled="together === 'bring'" :aria-label="`怎么在一起：${modeText}`" @click="toggleMode">
          <span :class="together === 'remote' ? 'i-lucide-link' : together === 'visit' ? 'i-lucide-armchair' : 'i-lucide-navigation'" class="shrink-0" />
          <span class="truncate">{{ modeText }}</span>
        </button>
        <span v-if="drawing" class="pill drawing" role="status" :aria-label="drawing" :title="drawing"><span class="i-lucide-loader-circle spin" /></span>
        <slot name="actions" />
      </header>
      <RouterLink v-if="!bare && !fill && (line || typing)" :to="chatLink" class="companion" :aria-label="`去和${character.name}聊天`">
        <Avatar :character="character" :size="30" live />
        <div class="say">
          <span v-if="typing && !line" class="inline-flex gap-1 text-accent-ink"><span class="typing-dot" /><span class="typing-dot" /><span class="typing-dot" /></span>
          <RichText v-else-if="line && hasMath(line)" :text="line" />
          <template v-else>{{ line }}</template>
        </div>
      </RouterLink>
      <slot name="overlay" />
      <section v-if="!bare" class="panel" :class="{ fill }">
        <RouterLink v-if="fill && (line || typing)" :to="chatLink" class="companion in-panel" :aria-label="`去和${character.name}聊天`">
          <Avatar :character="character" :size="26" live />
          <div class="say">
            <span v-if="typing && !line" class="inline-flex gap-1 text-accent-ink"><span class="typing-dot" /><span class="typing-dot" /><span class="typing-dot" /></span>
            <RichText v-else-if="line && hasMath(line)" :text="line" />
            <template v-else>{{ line }}</template>
          </div>
        </RouterLink>
        <slot />
      </section>
    </StageView>
  </div>
</template>

<style scoped>
.scene-art {
  position: absolute;
  inset: 0;
  display: block;
  padding: 0;
  border: 0;
  background: #000;
  cursor: zoom-in;
}
.scene-art img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  /* 竖图的脸多在上面三分之一：面板盖住下半截时也看得到 */
  object-position: 50% 18%;
}
.art-enter-active,
.art-leave-active {
  transition: opacity 0.6s ease;
}
.art-enter-from,
.art-leave-to {
  opacity: 0;
}
.pill.drawing {
  flex-shrink: 0;
  color: var(--accent-ink);
}
.spin {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.tint {
  position: absolute;
  inset: 0;
  background: radial-gradient(120% 70% at 50% 0%, color-mix(in srgb, var(--tint) 18%, transparent), transparent 70%);
  pointer-events: none;
}
@supports not (background: color-mix(in srgb, red 10%, transparent)) {
  .tint {
    display: none;
  }
}
.scene-top {
  position: absolute;
  z-index: 10;
  top: calc(var(--safe-top) + 10px);
  left: 10px;
  right: 10px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  min-width: 38px;
  height: 38px;
  padding: 0 10px;
  border-radius: 99px;
  background: var(--glass);
  border: 1px solid var(--glass-line);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  color: var(--ink);
  font-size: 14px;
}
.pill.title {
  min-width: 0;
  font-weight: 600;
}
.pill.mode {
  min-width: 0;
  max-width: 46%;
  flex-shrink: 1;
  font-size: 12.5px;
  color: var(--accent-ink);
}
.pill.mode:disabled {
  opacity: 1;
}
.pill.title > span:first-child {
  flex-shrink: 0;
  color: var(--tint);
}
.companion {
  position: absolute;
  z-index: 9;
  top: calc(var(--safe-top) + 60px);
  left: 12px;
  right: 12px;
  color: inherit;
  text-decoration: none;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  animation: rise 0.3s var(--ease) both;
}
.say {
  max-width: calc(100% - 40px);
  padding: 8px 12px;
  border-radius: 6px 16px 16px 16px;
  background: var(--glass-strong);
  border: 1px solid var(--glass-line);
  font-size: 14.5px;
  line-height: 1.55;
  box-shadow: var(--shadow-sm);
}
.panel.fill {
  top: calc(var(--safe-top) + 58px);
  max-height: none;
  display: flex;
  flex-direction: column;
}
.companion.in-panel {
  position: static;
  flex: none;
  margin-bottom: 10px;
  animation: none;
}
.companion.in-panel .say {
  max-height: 4.8em;
  overflow-y: auto;
  padding: 6px 10px;
  font-size: 13.5px;
}
.panel {
  position: absolute;
  z-index: 8;
  left: 0;
  right: 0;
  bottom: 0;
  max-height: 64%;
  overflow-y: auto;
  padding: 16px 16px calc(var(--safe-bottom) + 16px);
  border-radius: 26px 26px 0 0;
  background: var(--glass-strong);
  border-top: 1px solid var(--glass-line);
  backdrop-filter: blur(22px);
  -webkit-backdrop-filter: blur(22px);
}
</style>
