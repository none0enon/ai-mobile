<script setup lang="ts">
import type { SceneId } from '@app/shared';
import { computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { SCENE_COMPONENTS } from '@/scenes';
import { useAppStore } from '@/stores/app';
import { useChatStore } from '@/stores/chat';

const route = useRoute();
const app = useAppStore();
const chat = useChatStore();
const sceneId = computed(() => route.params.sceneId as SceneId);
const component = computed(() => SCENE_COMPONENTS[sceneId.value]);

onMounted(() => {
  // 进入场景时记到当前会话上：提示词组装会带上这个场景的规则和可用标签
  const c = chat.chatOfCharacter(app.activeCharacterId);
  if (c) c.currentScene = sceneId.value;
});
</script>

<template>
  <component :is="component" v-if="component" :key="sceneId" />
  <div v-else class="page items-center justify-center text-ink-3" data-page="scene-missing">没有这个场景</div>
</template>
