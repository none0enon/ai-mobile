<script setup lang="ts">
import { computed } from 'vue';
import { useChatStore } from '@/stores/chat';

const chat = useChatStore();

const tabs = computed(() => [
  { to: '/chats', label: '消息', icon: 'i-lucide-message-circle', badge: chat.totalUnread },
  { to: '/together', label: '一起', icon: 'i-lucide-heart-handshake', badge: 0 },
  { to: '/memories', label: '回忆', icon: 'i-lucide-book-heart', badge: 0, dot: true },
  { to: '/me', label: '我的', icon: 'i-lucide-user-round', badge: 0 },
]);
</script>

<template>
  <div class="tab-layout">
    <main class="tab-main">
      <RouterView />
    </main>
    <nav class="tabbar" aria-label="主导航">
      <RouterLink v-for="t in tabs" :key="t.to" :to="t.to" class="tab-item" active-class="is-active">
        <span class="relative">
          <span :class="t.icon" class="text-[22px]" />
          <span v-if="t.badge" class="badge num">{{ t.badge > 99 ? '99+' : t.badge }}</span>
          <span v-else-if="t.dot" class="dot" />
        </span>
        <span class="text-[11px] mt-0.5">{{ t.label }}</span>
      </RouterLink>
    </nav>
  </div>
</template>

<style scoped>
.tab-layout {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
}
.tab-main {
  position: relative;
  flex: 1;
  min-height: 0;
}
.tabbar {
  flex-shrink: 0;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  height: calc(var(--tabbar-h) + var(--safe-bottom));
  padding-bottom: var(--safe-bottom);
  background: var(--glass-strong);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border-top: 1px solid var(--glass-line);
}
.tab-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--ink-3);
  text-decoration: none;
  transition: color 0.2s;
}
.tab-item.is-active {
  color: var(--accent-ink);
}
.badge {
  position: absolute;
  top: -4px;
  left: 14px;
  min-width: 17px;
  height: 17px;
  padding: 0 5px;
  border-radius: 99px;
  background: var(--bad);
  color: #fff;
  font-size: 10.5px;
  line-height: 17px;
  text-align: center;
}
.dot {
  position: absolute;
  top: -1px;
  right: -3px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
}
</style>
