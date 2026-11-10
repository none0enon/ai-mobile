<script setup lang="ts">
import type { Character, Message, MessagePart } from '@app/shared';
import { computed } from 'vue';
import PartCard from './PartCard.vue';
import Avatar from '@/components/common/Avatar.vue';
import PersonaAvatar from '@/components/common/PersonaAvatar.vue';
import { personas } from '@/mock/characters';
import { useAppearanceStore } from '@/stores/appearance';
import { useChatStore } from '@/stores/chat';

const props = defineProps<{
  message: Message;
  character: Character;
  isLast: boolean;
  streaming: boolean;
  thinking: boolean;
}>();
const emit = defineEmits<{
  (e: 'swipe', dir: 1 | -1): void;
  (e: 'regenerate'): void;
  (e: 'choose', text: string): void;
  (e: 'open-music'): void;
  (e: 'open-image', part: MessagePart): void;
  (e: 'answer-date', ok: boolean): void;
}>();

const mine = computed(() => props.message.role === 'user');

/** 你上传过头像时，你的消息右边也显示头像（没上传就不占地方） */
const chatStore = useChatStore();
const looks = useAppearanceStore();
const me = computed(() => personas.find((p) => p.id === chatStore.chatById(props.message.chatId)?.personaId) ?? personas[0]);
const showMyAvatar = computed(() => !!me.value && !!looks.imageUrl(looks.avatarKey('persona', me.value.id) ?? me.value.avatar));
const narrator = computed(() => props.message.role === 'narrator' || props.message.role === 'system');
const textParts = computed(() => props.message.parts.filter((p) => p.type === 'text' && p.text));
const pokeParts = computed(() => props.message.parts.filter((p) => p.type === 'poke'));
const cardParts = computed(() => props.message.parts.filter((p) => p.type !== 'text' && p.type !== 'poke'));

/** 把（动作描写）和 *动作* 拆出来，用淡一点的字显示 */
function segments(text: string) {
  return text.split(/(（[^）]*）|\([^)]*\)|\*[^*]+\*)/).filter(Boolean).map((s) => ({
    text: s,
    action: /^（|^\(|^\*/.test(s),
  }));
}
</script>

<template>
  <div class="msg" :class="{ mine, narrator }" :data-role="message.role">
    <!-- 拍一拍：居中的一行提示 -->
    <div v-for="(p, i) in pokeParts" :key="`poke-${i}`" class="center-line">
      <PartCard :part="p" :character="character" :mine="mine" />
    </div>

    <!-- 旁白 / 场景分段 / 场景记录：居中，按顺序显示 -->
    <template v-if="narrator">
      <template v-for="(p, i) in message.parts" :key="i">
        <p v-if="p.type === 'text'" class="narration">{{ p.text }}</p>
        <div v-else-if="p.type !== 'poke'" class="center-line">
          <PartCard :part="p" :character="character" :mine="false" />
        </div>
      </template>
    </template>

    <div v-else-if="textParts.length || cardParts.length || streaming" class="row">
      <Avatar v-if="!mine" :character="character" :size="34" class="mt-0.5" />
      <div class="col">
        <span v-if="message.proactive" class="proactive">
          <span class="i-lucide-bell-ring text-[11px]" />她主动找你
        </span>
        <div v-if="streaming && thinking && !message.text" class="bubble ai">
          <span class="typing-dot" /> <span class="typing-dot" /> <span class="typing-dot" />
        </div>
        <div v-for="(p, i) in textParts" :key="i" class="bubble" :class="[mine ? 'me' : 'ai', { 'stream-caret': streaming && i === textParts.length - 1 }]">
          <template v-for="(s, j) in segments(p.type === 'text' ? p.text : '')" :key="j">
            <span :class="{ action: s.action }">{{ s.text }}</span>
          </template>
        </div>
        <PartCard
          v-for="(p, i) in cardParts"
          :key="`card-${i}`"
          :part="p"
          :character="character"
          :mine="mine"
          @open-music="emit('open-music')"
          @open-image="emit('open-image', p)"
          @answer-date="(ok) => emit('answer-date', ok)"
        />
        <div v-if="!mine && isLast && !streaming && message.swipes.length > 0" class="tools">
          <template v-if="message.swipes.length > 1">
            <button class="tool" aria-label="上一个回复" @click="emit('swipe', -1)"><span class="i-lucide-chevron-left" /></button>
            <span class="num text-[12px] text-ink-3">{{ message.swipeIndex + 1 }}/{{ message.swipes.length }}</span>
            <button class="tool" aria-label="下一个回复" @click="emit('swipe', 1)"><span class="i-lucide-chevron-right" /></button>
          </template>
          <button class="tool" aria-label="重新生成" @click="emit('regenerate')"><span class="i-lucide-refresh-cw text-[14px]" /></button>
        </div>
        <div v-if="!mine && isLast && message.meta.choices?.length" class="choices">
          <button v-for="c in message.meta.choices" :key="c" class="choice press" @click="emit('choose', c)">{{ c }}</button>
        </div>
        <span v-if="message.meta.interrupted" class="text-[12px] text-warn">回复被打断了 · 点重新生成继续</span>
      </div>
      <PersonaAvatar v-if="mine && showMyAvatar && me" :persona="me" :size="34" class="mt-0.5" />
    </div>
  </div>
</template>

<style scoped>
.msg {
  padding: 5px 14px;
}
.row {
  display: flex;
  gap: 8px;
  align-items: flex-start;
}
.mine .row {
  justify-content: flex-end;
}
.col {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  max-width: 78%;
  min-width: 0;
}
.mine .col {
  align-items: flex-end;
}
.bubble {
  padding: 9px 13px;
  border-radius: 18px;
  font-size: 15.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
.bubble.ai {
  background: var(--bubble-ai);
  border: 1px solid var(--border);
  border-top-left-radius: 6px;
  color: var(--ink);
}
.bubble.me {
  background: var(--bubble-me);
  color: var(--on-bubble-me);
  border-top-right-radius: 6px;
}
.action {
  opacity: 0.62;
  font-style: italic;
}
.proactive {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--accent-ink);
}
.tools {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-top: -2px;
}
.tool {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  color: var(--ink-3);
}
.tool:active {
  background: var(--panel);
}
.choices {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.choice {
  padding: 6px 12px;
  border-radius: 99px;
  border: 1px solid var(--accent-line);
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: 13.5px;
}
.center-line {
  display: flex;
  justify-content: center;
  margin: 2px 0;
}
.narration {
  margin: 4px auto;
  max-width: 86%;
  text-align: center;
  font-size: 13px;
  color: var(--ink-3);
  font-style: italic;
}
</style>
