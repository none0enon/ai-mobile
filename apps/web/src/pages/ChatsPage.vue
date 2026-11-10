<script setup lang="ts">
import { computed } from 'vue';
import ChatListItem from '@/components/chat/ChatListItem.vue';
import Avatar from '@/components/common/Avatar.vue';
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
      <!-- 角色此刻在做什么（模拟作息生成的状态） -->
      <div class="flex gap-3 overflow-x-auto hide-scrollbar gutter pt-3 pb-2">
        <RouterLink
          v-for="c in chars.list"
          :key="c.id"
          :to="`/chat/${chat.chatOfCharacter(c.id)?.id}`"
          class="presence press"
          :style="{ '--tone': c.accent }"
        >
          <Avatar :character="c" :size="46" status="online" live />
          <div class="min-w-0">
            <div class="text-[14px] font-600 truncate">{{ c.name }}</div>
            <div class="text-[12px] text-ink-3 truncate">{{ c.status }}</div>
          </div>
        </RouterLink>
        <RouterLink to="/import" class="presence add press">
          <span class="add-icon"><span class="i-lucide-plus text-[20px]" /></span>
          <div class="text-[13px] text-ink-2">导入角色</div>
        </RouterLink>
      </div>

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
.presence {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 168px;
  padding: 10px 12px;
  border-radius: 18px;
  background: var(--surface);
  border: 1px solid var(--border);
  color: inherit;
  text-decoration: none;
  flex-shrink: 0;
}
.presence.add {
  min-width: auto;
  border-style: dashed;
}
.add-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 46px;
  height: 46px;
  border-radius: 50%;
  background: var(--panel);
  color: var(--ink-2);
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
