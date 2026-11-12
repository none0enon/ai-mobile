<script setup lang="ts">
import { defaultLocationFor, getLocation, type MapLocation, type SceneId, type TogetherMode } from '@app/shared';
import { computed, provide, ref, watch } from 'vue';
import { onBeforeRouteLeave, useRoute } from 'vue-router';
import { SCENE_LOCATION } from '@/components/scene/location';
import { SCENE_COMPONENTS } from '@/scenes';
import { useAppStore } from '@/stores/app';
import { useChatStore } from '@/stores/chat';

/**
 * 场景都发生在地图上的某个地点，算作你们那条聊天里的一段：
 * 进来时在聊天里记"来到…"，离开时记"离开…"（什么都没发生就不留痕迹）。
 * 场景只在这一页上：离开这一页就是结束这件事，去聊天、打电话也一样（聊天页只是聊天）。
 */
const route = useRoute();
const app = useAppStore();
const chat = useChatStore();
const sceneId = computed(() => route.params.sceneId as SceneId);
const component = computed(() => SCENE_COMPONENTS[sceneId.value]);

/**
 * 在哪儿：?at= 指定的地点（她小世界里的，或你真实世界里的）→ 已经和她在一起的地方（那里能做这件事的话）
 * → 她的世界里做这件事的默认地点。
 * 约会没指定地点时先让你挑，由 DateScene 自己决定。
 */
function resolveLocation(): MapLocation | null {
  const at = getLocation(route.query.at as string | undefined);
  if (at) return at;
  if (sceneId.value === 'date') return null;
  const current = getLocation(chat.chatOfCharacter(app.activeCharacterId)?.togetherAt);
  if (current?.activities.some((a) => a.sceneId === sceneId.value)) return current;
  return defaultLocationFor(sceneId.value, app.activeCharacterId);
}

const location = ref<MapLocation | null>(null);
provide(SCENE_LOCATION, location);

/** ?how=visit 表示"去她那"（坐到她旁边）；默认连线；真实地点总是"带她来" */
watch(
  () => [sceneId.value, route.query.at, route.query.how],
  () => {
    location.value = resolveLocation();
    const how = route.query.how === 'visit' ? 'visit' : undefined;
    if (location.value) chat.enterScene(app.activeCharacterId, location.value.id, sceneId.value, how as TogetherMode | undefined);
  },
  { immediate: true },
);

// 离开这一页就结束这件事，去哪儿都一样
onBeforeRouteLeave(() => {
  chat.leaveScene(app.activeCharacterId);
});
</script>

<template>
  <component :is="component" v-if="component" :key="sceneId" />
  <div v-else class="page items-center justify-center text-ink-3" data-page="scene-missing">没有这个场景</div>
</template>
