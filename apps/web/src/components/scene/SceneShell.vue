<script setup lang="ts">
import { getScene, type PokeHotspot, type TimeOfDay } from '@app/shared';
import { computed, inject, ref } from 'vue';
import Avatar from '@/components/common/Avatar.vue';
import StageView from '@/components/stage/StageView.vue';
import { backdropAt, SCENE_LOCATION, titleAt } from './location';
import { goBack } from '@/router';
import { useAppStore } from '@/stores/app';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';

/**
 * 所有场景共用的外壳：背景 + 立绘 + 顶栏 + 她的一句话 + 底部场景面板（插槽）。
 * 场景只需要写面板，并告诉外壳用什么服装、姿势、表情；背景和标题默认跟着地图上的地点走。
 * 点她的那句话 → 去你们的聊天接着聊（还算在一起，聊天页显示"你们在…"）。
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
    pokeable?: boolean;
    showHotspots?: boolean;
    layout?: { left: number; bottom: number; height: number };
    title?: string;
  }>(),
  { rain: false, dim: 0, typing: false, hideFigure: false, pokeable: false, showHotspots: false },
);
const emit = defineEmits<{ (e: 'poke', h: PokeHotspot, kind: 'tap' | 'long'): void }>();

const app = useAppStore();
const chars = useCharacterStore();
const chat = useChatStore();
const scene = computed(() => getScene(props.sceneId));
const location = inject(SCENE_LOCATION, ref(null));
const character = computed(() => chars.byId(app.activeCharacterId) ?? chars.list[0]!);
const chatLink = computed(() => `/chat/${chat.chatOfCharacter(character.value.id)?.id}?mode=stage`);
const expr = computed(() => props.expression ?? chars.expression[character.value.id] ?? 'smile');
const layout = computed(() => props.layout ?? { left: 50, bottom: 40, height: 50 });
</script>

<template>
  <div class="page scene-shell" :data-page="`scene-${sceneId}`" :style="{ '--tint': scene.tint }">
    <StageView
      :character="character"
      :expression="expr"
      :outfit="outfit ?? scene.outfit"
      :pose="pose ?? scene.pose"
      :backdrop="backdrop ?? backdropAt(location, sceneId)"
      :tod="tod"
      :rain="rain"
      :dim="dim"
      :pokeable="pokeable"
      :show-hotspots="showHotspots"
      :layout="hideFigure ? { left: 50, bottom: 200, height: 1 } : layout"
      @poke="(h, k) => emit('poke', h, k)"
    >
      <div class="tint" />
      <header class="scene-top">
        <button class="pill" aria-label="返回" @click="goBack('/map')"><span class="i-lucide-chevron-left text-[20px]" /></button>
        <span class="pill title"><span :class="scene.icon" /><span class="truncate">{{ title ?? titleAt(location, sceneId) }}</span></span>
        <span class="flex-1" />
        <slot name="actions" />
      </header>
      <RouterLink v-if="line || typing" :to="chatLink" class="companion" :aria-label="`去和${character.name}聊天`">
        <Avatar :character="character" :size="30" live />
        <div class="say">
          <span v-if="typing && !line" class="inline-flex gap-1 text-accent-ink"><span class="typing-dot" /><span class="typing-dot" /><span class="typing-dot" /></span>
          <template v-else>{{ line }}</template>
        </div>
      </RouterLink>
      <slot name="overlay" />
      <section class="panel">
        <slot />
      </section>
    </StageView>
  </div>
</template>

<style scoped>
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
