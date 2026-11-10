<script setup lang="ts">
import { getLocation, type Character, type Chat, type Message } from '@app/shared';
import { computed } from 'vue';
import Avatar from '@/components/common/Avatar.vue';
import { listTime } from '@/utils/time';

const props = defineProps<{ chat: Chat; character: Character; last?: Message; unread: number; typing?: boolean }>();

const PART_LABEL: Record<string, string> = {
  voice: '[语音]',
  image: '[图片]',
  music: '[歌曲]',
  poke: '[拍一拍]',
  'call-log': '[语音通话]',
  workout: '[运动记录]',
  meal: '[饭照]',
  study: '[学习记录]',
  date: '[约会邀请]',
  gift: '[礼物]',
};

/** 她此刻在哪；你们正在一起时写"你们在…" */
const where = computed(() => {
  const loc = getLocation(props.chat.togetherAt ?? props.character.locationId);
  if (!loc) return '';
  return props.chat.togetherAt ? `你们在${loc.name}` : loc.name;
});

const preview = computed(() => {
  const m = props.last;
  if (!m) return props.character.card.firstMes;
  if (m.text) return m.text;
  const p = m.parts[0];
  if (p?.type === 'poke') return p.actor === 'char' ? `${props.character.name}拍了拍你` : `你拍了拍${props.character.name}的${p.target}`;
  if (p?.type === 'scene') return `[${p.event === 'enter' ? '来到' : '离开'}] ${p.title.replace(/^和.+?来到|^离开/, '')}`;
  return p ? (PART_LABEL[p.type] ?? '') : '';
});
</script>

<template>
  <RouterLink :to="`/chat/${chat.id}`" class="row press" :data-test="`chat-${chat.id}`">
    <Avatar :character="character" :size="52" :ring="unread > 0" />
    <div class="flex-1 min-w-0">
      <div class="flex items-center gap-2">
        <span class="font-600 text-[16px] truncate">{{ chat.title }}</span>
        <span v-if="where" class="where"><span class="i-lucide-map-pin" /><span class="truncate">{{ where }}</span></span>
        <span v-if="chat.pinned" class="i-lucide-pin text-[13px] text-ink-3 shrink-0" aria-label="置顶" />
        <span class="ml-auto text-[12px] text-ink-3 num shrink-0">{{ last ? listTime(last.createdAt) : '' }}</span>
      </div>
      <div class="flex items-center gap-2 mt-1">
        <span v-if="typing" class="text-[13.5px] text-accent-ink">对方正在输入…</span>
        <span v-else class="flex-1 min-w-0 text-[13.5px] text-ink-2 truncate">
          <span v-if="last?.proactive && !last.read" class="text-accent-ink">[主动] </span>{{ preview }}
        </span>
        <span v-if="unread" class="unread num">{{ unread }}</span>
      </div>
    </div>
  </RouterLink>
</template>

<style scoped>
.row {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 16px;
  color: inherit;
  text-decoration: none;
}
.row:active {
  background: var(--panel);
}
.where {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
  max-width: 40%;
  color: var(--ink-3);
  font-size: 12px;
}
.where > span:first-child {
  flex-shrink: 0;
}
.unread {
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  border-radius: 99px;
  background: var(--bad);
  color: #fff;
  font-size: 11.5px;
  line-height: 20px;
  text-align: center;
  flex-shrink: 0;
}
</style>
