<script setup lang="ts">
import { worldOf, type MapLocation } from '@app/shared';
import { computed, inject, ref } from 'vue';
import { SCENE_LOCATION } from './location';
import Avatar from '@/components/common/Avatar.vue';
import { useAppStore } from '@/stores/app';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';

/**
 * 场景面板里"她那边"的一行：连线时是她在她世界里做什么，去她那时她就在你旁边，带她来时她在你对面。
 * 让"一起"是双向的——她也在学、也在吃，不只是看着你。
 */
defineProps<{ label: string; content: string; extra?: string; icon?: string }>();
const app = useAppStore();
const chars = useCharacterStore();
const chat = useChatStore();
const location = inject(SCENE_LOCATION, ref<MapLocation | null>(null));
const character = computed(() => chars.byId(app.activeCharacterId) ?? chars.list[0]!);
const mode = computed(() => chat.chatOfCharacter(character.value.id)?.togetherMode ?? 'remote');
const where = computed(() => location.value?.name ?? worldOf(character.value.id).locations[0]?.name ?? '');
const heading = computed(() => {
  const p = character.value.pronoun;
  if (mode.value === 'visit') return `${p}在你旁边 · ${where.value}`;
  if (mode.value === 'bring') return `${p}在你对面 · ${where.value}`;
  return `${p}那边 · ${where.value}`;
});
</script>

<template>
  <div class="her-side">
    <Avatar :character="character" :size="36" live />
    <div class="flex-1 min-w-0">
      <div class="text-[12px] text-ink-3 truncate">{{ heading }}</div>
      <div class="text-[14px] leading-snug mt-0.5">
        <span class="text-ink-3">{{ label }}</span><span :class="icon" class="mx-0.5 text-accent-ink" />{{ content }}
      </div>
      <div v-if="extra" class="text-[12px] text-accent-ink mt-0.5">{{ extra }}</div>
    </div>
  </div>
</template>

<style scoped>
.her-side {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 16px;
  background: var(--accent-soft);
  border: 1px solid var(--accent-line);
}
</style>
