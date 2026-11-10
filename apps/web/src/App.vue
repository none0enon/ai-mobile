<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import AccentScope from '@/layouts/AccentScope.vue';
import InAppBanner from '@/layouts/InAppBanner.vue';
import { useAppStore } from '@/stores/app';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';

const route = useRoute();
const app = useAppStore();
const chars = useCharacterStore();
const chat = useChatStore();

/** 整个界面的点缀色跟随"当前页面相关的角色"：聊天页跟随聊天对象，其余跟随当前陪伴的角色 */
const accent = computed(() => {
  const chatId = route.params.id as string | undefined;
  const fromChat = route.path.startsWith('/chat/') ? chars.byId(chat.chatById(chatId)?.characterId) : undefined;
  const fromRoute = chars.byId((route.params.charId as string | undefined) ?? (route.query.char as string | undefined));
  return (fromChat ?? fromRoute ?? chars.byId(app.activeCharacterId))?.accent ?? null;
});
</script>

<template>
  <AccentScope :accent="accent" class="app-frame">
    <RouterView />
    <InAppBanner />
  </AccentScope>
</template>
