<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import AccentScope from '@/layouts/AccentScope.vue';
import InAppBanner from '@/layouts/InAppBanner.vue';
import { useAppStore } from '@/stores/app';
import { useAppearanceStore } from '@/stores/appearance';
import { useRealWorldStore } from '@/stores/realworld';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';
import { databaseState } from '@/db/idb';
import { startup } from '@/startup';

const route = useRoute();
const app = useAppStore();
const chars = useCharacterStore();
const chat = useChatStore();
// 外观（配色、背景、头像）要在启动时就生效
const looks = useAppearanceStore();
// 你的真实世界（家、附近的地方）也要先登记好，聊天和场景里才认得这些地点
useRealWorldStore();

/**
 * 整个界面的点缀色：默认跟随"当前页面相关的角色"（聊天页跟随聊天对象，其余跟随当前陪伴的角色）；
 * 外观里选了"跟随配色"时用配色自带的点缀色。
 */
const accent = computed(() => {
  if (looks.settings.accentFrom === 'palette') return looks.paletteAccent;
  const chatId = route.params.id as string | undefined;
  const fromChat = route.path.startsWith('/chat/') ? chars.byId(chat.chatById(chatId)?.characterId) : undefined;
  const fromRoute = chars.byId((route.params.charId as string | undefined) ?? (route.query.char as string | undefined));
  return (fromChat ?? fromRoute ?? chars.byId(app.activeCharacterId))?.accent ?? null;
});

/**
 * 正常打开时不显示开屏画面：本机数据读完之前界面先空着，读完直接进 App。
 * 只有本机数据出了问题（被旧页面占用、在别的页面更新了、读不出来）才拦住界面，说明怎么办。
 */
const notice = computed(() => {
  if (databaseState.status === 'outdated') return { title: 'App 已在其他页面更新', message: '重新打开本页，继续使用已保存的设置和聊天。' };
  if (databaseState.status === 'blocked') return { title: '请先关闭其他 AI 陪伴页面', message: '旧页面正在占用数据。请关闭其他浏览器标签页和已安装的 App 窗口，本页会自动继续读取。' };
  if (startup.error || databaseState.status === 'error') return { title: '本机数据暂时无法读取', message: '请重新打开后再试。不要清除网站数据，已保存的 Key 和聊天需要从这里读取。' };
  return null;
});
const reload = () => window.location.reload();
</script>

<template>
  <AccentScope :accent="accent" class="app-frame">
    <template v-if="startup.ready && databaseState.status !== 'outdated'">
      <RouterView />
      <InAppBanner />
    </template>
    <section v-else-if="notice" class="startup-status" role="status" aria-live="polite">
      <h1>{{ notice.title }}</h1>
      <p>{{ notice.message }}</p>
      <button type="button" @click="reload">重新打开</button>
    </section>
  </AccentScope>
</template>

<style scoped>
.startup-status { display: flex; flex-direction: column; justify-content: center; min-height: 100%; padding: 32px; }
.startup-status h1 { font-size: 20px; margin: 0 0 12px; }
.startup-status p { color: var(--ink-2); margin: 0 0 24px; line-height: 1.8; }
.startup-status button { align-self: flex-start; background: var(--accent); color: var(--on-accent); padding: 10px 20px; border-radius: var(--radius-sm); }
</style>
