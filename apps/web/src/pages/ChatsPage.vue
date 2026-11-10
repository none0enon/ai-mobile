<script setup lang="ts">
import { getLocation } from '@app/shared';
import { computed } from 'vue';
import ChatListItem from '@/components/chat/ChatListItem.vue';
import Avatar from '@/components/common/Avatar.vue';
import WorldMap from '@/components/map/WorldMap.vue';
import { weather } from '@/mock/activity';
import { todayTouchpoints } from '@/mock/settings';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';
import { hhmm, weekday } from '@/utils/time';

const chat = useChatStore();
const chars = useCharacterStore();

const upcoming = computed(() => todayTouchpoints().filter((t) => t.status === 'planned'));
const RULE_LABEL: Record<string, string> = {
  'wake-call': '叫醒来电',
  morning: '早安',
  lunch: '午饭',
  sedentary: '久坐提醒',
  dinner: '晚饭',
  'miss-you': '想你了',
  bedtime: '催睡',
};
const today = `${weekday(Date.now())} · ${weather.city} ${weather.text} ${weather.tempC}°C`;
</script>

<template>
  <div class="page" data-page="chats">
    <header class="gutter pt-[calc(var(--safe-top)+14px)] pb-1 flex items-end gap-2">
      <div class="min-w-0">
        <h1 class="m-0 text-[28px] font-700 leading-tight">消息</h1>
        <div class="flex items-center gap-1 text-[12.5px] text-ink-3 mt-0.5">
          <span :class="weather.icon" />{{ today }}
          <span class="ml-1 inline-flex items-center gap-0.5 text-good"><span class="i-lucide-cloud-check" />已同步</span>
        </div>
      </div>
      <div class="ml-auto flex">
        <button class="icon-btn" aria-label="搜索聊天记录"><span class="i-lucide-search text-[20px]" /></button>
        <RouterLink to="/import" class="icon-btn" aria-label="导入角色卡"><span class="i-lucide-user-plus text-[20px]" /></RouterLink>
      </div>
    </header>

    <div class="page-scroll">
      <!-- 小地图：她们此刻在哪（模拟作息），点开进完整地图 -->
      <RouterLink to="/map" class="where-card press" aria-label="打开地图，看她们在哪">
        <div class="thumb"><WorldMap :characters="chars.list" :you-at="chat.youAt" compact /></div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center text-[12.5px] text-ink-3">
            她们在哪<span class="ml-auto inline-flex items-center">地图<span class="i-lucide-chevron-right" /></span>
          </div>
          <div v-for="c in chars.list.slice(0, 3)" :key="c.id" class="flex items-center gap-2 mt-2 min-w-0">
            <Avatar :character="c" :size="26" live />
            <div class="min-w-0 leading-tight">
              <div class="text-[13.5px] truncate"><b class="font-600">{{ c.name }}</b> · {{ getLocation(c.locationId)?.name ?? '家' }}</div>
              <div class="text-[12px] text-ink-3 truncate">{{ c.status }}</div>
            </div>
          </div>
        </div>
      </RouterLink>

      <!-- 今天的主动计划 -->
      <RouterLink v-if="upcoming.length" to="/me/proactive" class="plan press">
        <span class="plan-icon"><span class="i-lucide-bell-ring" /></span>
        <div class="flex-1 min-w-0">
          <div class="text-[14px] font-600">苏晚今天还会主动找你 {{ upcoming.length }} 次</div>
          <div class="text-[12.5px] text-ink-3 truncate">
            下一次 {{ hhmm(upcoming[0]?.dueAt ?? 0) }}「{{ RULE_LABEL[upcoming[0]?.ruleId ?? ''] }}」· {{ upcoming[0]?.action === 'call' ? '可能直接打电话' : '发消息' }}
          </div>
        </div>
        <span class="i-lucide-chevron-right text-ink-3" />
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
      <p class="text-center text-[12px] text-ink-3 px-8 py-6 leading-relaxed">
        App 关着时，她的主动消息会通过推送送达；<br />打开 App 时会把没收到的补齐。
      </p>
    </div>
  </div>
</template>

<style scoped>
.where-card {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 12px 16px 6px;
  padding: 10px 12px 10px 10px;
  border-radius: 20px;
  background: var(--surface);
  border: 1px solid var(--border);
  color: inherit;
  text-decoration: none;
}
.thumb {
  width: 132px;
  flex-shrink: 0;
}
.plan {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 6px 16px 4px;
  padding: 12px 14px;
  border-radius: 18px;
  background: var(--accent-soft);
  border: 1px solid var(--accent-line);
  color: inherit;
  text-decoration: none;
}
.plan-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border-radius: 12px;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 19px;
  flex-shrink: 0;
}
</style>
