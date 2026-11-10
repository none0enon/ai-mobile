<script setup lang="ts">
import { getLocation, isRealPlace, type Character } from '@app/shared';
import { computed } from 'vue';
import ChatListItem from '@/components/chat/ChatListItem.vue';
import Avatar from '@/components/common/Avatar.vue';
import { weather } from '@/mock/activity';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';
import { weekday } from '@/utils/time';

const chat = useChatStore();
const chars = useCharacterStore();

/** 消息页只放"像真人"的东西：她们在哪、聊天。主动消息的排期在"我的 → 主动消息"里看，这里不提，免得出戏 */
const shown = computed(() => chars.list.slice(0, 2));
const more = computed(() => chars.list.length - shown.value.length);
/** 她在自己小世界里的哪儿；被你带出门时写"在你那边" */
function whereOf(c: Character) {
  const loc = getLocation(c.locationId);
  if (!loc) return '';
  return isRealPlace(loc) ? '在你那边' : loc.name;
}
const today = `${weekday(Date.now())} · ${weather.city} ${weather.text} ${weather.tempC}°C`;
</script>

<template>
  <div class="page" data-page="chats">
    <header class="gutter pt-[calc(var(--safe-top)+14px)] pb-1 flex items-end gap-2">
      <div class="flex-1 min-w-0">
        <h1 class="m-0 text-[28px] font-700 leading-tight">消息</h1>
        <div class="flex items-center gap-1 text-[12.5px] text-ink-3 mt-0.5 whitespace-nowrap">
          <span :class="weather.icon" class="shrink-0" /><span class="truncate">{{ today }}</span>
          <span class="i-lucide-cloud-check text-good shrink-0 ml-0.5" role="img" aria-label="已同步" title="已同步" />
        </div>
      </div>
      <div class="flex shrink-0">
        <button class="icon-btn" aria-label="搜索聊天记录"><span class="i-lucide-search text-[20px]" /></button>
        <RouterLink to="/import" class="icon-btn" aria-label="导入角色卡"><span class="i-lucide-user-plus text-[20px]" /></RouterLink>
      </div>
    </header>

    <div class="page-scroll">
      <!-- 她们在哪：每人一行（各自小世界里的位置），点开进地图 -->
      <RouterLink to="/map" class="where-card press" aria-label="打开地图，看她们在哪">
        <span class="thumb"><span class="i-lucide-map" /></span>
        <div class="flex-1 min-w-0 grid gap-1.5">
          <div v-for="c in shown" :key="c.id" class="flex items-center gap-1.5 min-w-0 text-[13px] leading-tight">
            <Avatar :character="c" :size="20" />
            <span class="truncate"
              ><b class="font-600">{{ c.name }}</b><span class="text-ink-3"> · {{ whereOf(c) }} · {{ c.status }}</span></span
            >
          </div>
        </div>
        <span v-if="more > 0" class="text-[12px] text-ink-3 shrink-0">+{{ more }}</span>
        <span class="i-lucide-chevron-right text-ink-3 shrink-0" />
      </RouterLink>

      <div class="mt-1">
        <ChatListItem
          v-for="c in chat.sortedChats"
          :key="c.id"
          :chat="c"
          :character="chars.byId(c.characterId)!"
          :last="chat.list(c.id).at(-1)"
          :unread="chat.unread(c.id)"
          :typing="!!chat.streams[c.id]"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.where-card {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 10px 16px 4px;
  padding: 7px 10px 7px 7px;
  border-radius: 16px;
  background: var(--surface);
  border: 1px solid var(--border);
  color: inherit;
  text-decoration: none;
}
.thumb {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: 12px;
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: 22px;
  flex-shrink: 0;
}
</style>
