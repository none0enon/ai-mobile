<script setup lang="ts">
import type { Character } from '@app/shared';
import { computed } from 'vue';
import CharacterFigure from '@/components/figure/CharacterFigure.vue';
import { FIGURE } from '@/mock/characters';
import { useAppearanceStore } from '@/stores/appearance';
import { useCharacterStore } from '@/stores/characters';
import { mix } from '@/utils/color';

/** 头像：你给她上传过头像就用那张图；没有时用占位立绘的头部裁切 */
const props = withDefaults(
  defineProps<{ character: Character; size?: number; ring?: boolean; live?: boolean; status?: 'online' | 'busy' | null }>(),
  { size: 44, ring: false, live: false, status: null },
);
const chars = useCharacterStore();
const looks = useAppearanceStore();
const src = computed(() => looks.imageUrl(looks.avatarKey('character', props.character.id) ?? props.character.avatar));
const expression = computed(() => (props.live ? (chars.expression[props.character.id] ?? 'smile') : 'smile'));
const figure = computed(() => FIGURE[props.character.id] ?? { hairStyle: 'long' as const, eye: '#3b2531' });
const bg = computed(
  () => `linear-gradient(160deg, ${mix(props.character.accent, '#ffffff', 0.25)}, ${mix(props.character.accent, '#3b2a4a', 0.35)})`,
);
</script>

<template>
  <span
    class="avatar"
    :class="{ 'has-ring': ring }"
    :style="{ width: `${size}px`, height: `${size}px`, background: bg, '--ring': character.accent }"
    :title="character.name"
  >
    <img v-if="src" :src="src" class="avatar-img" alt="" />
    <CharacterFigure
      v-else
      :accent="character.accent"
      :hair="character.hairColor"
      :eye="figure.eye"
      :hair-style="figure.hairStyle"
      :expression="expression"
      crop="head"
      :title="`${character.name}的头像`"
    />
    <span v-if="status" class="status" :class="status" />
  </span>
</template>

<style scoped>
.avatar {
  position: relative;
  flex-shrink: 0;
  display: inline-block;
  border-radius: 50%;
  overflow: visible;
}
.avatar-img {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: 50%;
  object-fit: cover;
}
.avatar :deep(svg) {
  border-radius: 50%;
  overflow: hidden;
}
.avatar.has-ring {
  box-shadow:
    0 0 0 2px var(--bg),
    0 0 0 4px var(--ring);
}
.status {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 28%;
  height: 28%;
  min-width: 9px;
  min-height: 9px;
  border-radius: 50%;
  border: 2px solid var(--bg);
}
.status.online {
  background: var(--good);
}
.status.busy {
  background: var(--warn);
}
</style>
