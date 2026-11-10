<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import Avatar from '@/components/common/Avatar.vue';
import { useAppStore } from '@/stores/app';
import { useCharacterStore } from '@/stores/characters';

/** 在别的页面时收到主动消息 / 来电，顶部弹一条横幅 */
const app = useAppStore();
const chars = useCharacterStore();
const router = useRouter();
const character = computed(() => chars.byId(app.banner?.characterId));

function open() {
  const to = app.banner?.to;
  app.dismissBanner();
  if (to) router.push(to);
}
</script>

<template>
  <Transition name="banner">
    <button v-if="app.banner && character" :key="app.banner.id" class="banner glass" @click="open">
      <Avatar :character="character" :size="40" />
      <div class="flex-1 min-w-0 text-left">
        <div class="flex items-center gap-1.5 text-[13px] font-600">
          <span v-if="app.banner.icon" :class="app.banner.icon" class="text-accent-ink" />
          <span class="truncate">{{ app.banner.title }}</span>
        </div>
        <div class="text-[13px] text-ink-2 truncate">{{ app.banner.text }}</div>
      </div>
      <span class="i-lucide-chevron-right text-ink-3" />
    </button>
  </Transition>
</template>

<style scoped>
.banner {
  position: absolute;
  z-index: 60;
  top: calc(var(--safe-top) + 8px);
  left: 10px;
  right: 10px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 18px;
  box-shadow: var(--shadow);
  color: var(--ink);
}
.banner-enter-active,
.banner-leave-active {
  transition:
    transform 0.32s var(--ease),
    opacity 0.32s;
}
.banner-enter-from,
.banner-leave-to {
  transform: translateY(-120%);
  opacity: 0;
}
</style>
