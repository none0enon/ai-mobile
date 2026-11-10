<script setup lang="ts">
import type { MessagePart } from '@app/shared';
import { showToast } from 'vant';
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Composer from '@/components/chat/Composer.vue';
import MessageItem from '@/components/chat/MessageItem.vue';
import Avatar from '@/components/common/Avatar.vue';
import CgArt from '@/components/figure/CgArt.vue';
import DialogBox from '@/components/stage/DialogBox.vue';
import StageView from '@/components/stage/StageView.vue';
import { usePoke } from '@/composables/usePoke';
import PageHeader from '@/layouts/PageHeader.vue';
import { mockToday, weather } from '@/mock/activity';
import { presets } from '@/mock/library';
import { goBack } from '@/router';
import { services } from '@/services';
import { useAppStore } from '@/stores/app';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';
import { dividerTime, hhmm } from '@/utils/time';

const route = useRoute();
const router = useRouter();
const chatStore = useChatStore();
const chars = useCharacterStore();
const app = useAppStore();

const chatId = computed(() => route.params.id as string);
const chat = computed(() => chatStore.chatById(chatId.value));
const character = computed(() => chars.byId(chat.value?.characterId));
const mode = computed<'im' | 'stage'>(() => {
  const q = route.query.mode;
  if (q === 'stage' || q === 'im') return q;
  return chat.value?.mode ?? 'im';
});
const messages = computed(() => chatStore.list(chatId.value));
const stream = computed(() => chatStore.streams[chatId.value]);
const expression = computed(() => chars.expression[character.value?.id ?? ''] ?? 'neutral');
const lastAi = computed(() => [...messages.value].reverse().find((m) => m.role === 'assistant'));
const preset = computed(() => presets.find((p) => p.id === chat.value?.presetId));

function setMode(m: 'im' | 'stage') {
  if (chat.value) chat.value.mode = m;
  void router.replace({ query: { ...route.query, mode: m } });
}

/** 两条消息间隔超过 20 分钟插一条时间分隔 */
const rows = computed(() => {
  const out: ({ kind: 'divider'; id: string; ts: number } | { kind: 'msg'; id: string })[] = [];
  let prev = 0;
  for (const m of messages.value) {
    if (m.createdAt - prev > 20 * 60_000) out.push({ kind: 'divider', id: `d-${m.id}`, ts: m.createdAt });
    out.push({ kind: 'msg', id: m.id });
    prev = m.createdAt;
  }
  return out;
});
const byId = computed(() => new Map(messages.value.map((m) => [m.id, m])));

const scroller = ref<HTMLElement | null>(null);
async function scrollToBottom(smooth = false) {
  await nextTick();
  const el = scroller.value;
  if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
}

onMounted(() => {
  chatStore.markRead(chatId.value);
  if (character.value) app.activeCharacterId = character.value.id;
  void scrollToBottom();
});
watch(
  () => [messages.value.length, messages.value.at(-1)?.text],
  () => {
    chatStore.markRead(chatId.value);
    const el = scroller.value;
    if (!el || el.scrollHeight - el.scrollTop - el.clientHeight < 240) void scrollToBottom(true);
  },
);

async function onVoice(ms: number) {
  const transcript = await services.stt.transcribe(new Blob());
  chatStore.push(chatId.value, 'user', [{ type: 'voice', assetKey: null, durationMs: ms, transcript }]);
  await chatStore.generate(chatId.value);
}

function onAction(id: string) {
  const c = character.value;
  if (!c) return;
  switch (id) {
    case 'music':
      void router.push('/scene/music');
      break;
    case 'meal':
      void router.push('/scene/meal');
      break;
    case 'scenes':
      void router.push('/together');
      break;
    case 'call':
      void router.push(`/call/${c.id}`);
      break;
    case 'poke':
      void chatStore.poke(chatId.value, '头');
      break;
    case 'date':
      chatStore.postCard(chatId.value, 'user', { type: 'date', place: '游乐园', when: '周日 15:00', status: 'invite' }, '周日一起去游乐园吗？');
      void chatStore.generate(chatId.value);
      break;
    case 'workout': {
      const w = mockToday().workout ?? { sport: '步行', distanceKm: 2.1, durationSec: 1500, pace: `11'54"` };
      chatStore.postCard(chatId.value, 'user', { type: 'workout', logId: 'w-new', sport: w.sport, distanceKm: w.distanceKm, durationSec: w.durationSec, pace: w.pace });
      void chatStore.generate(chatId.value);
      break;
    }
    case 'cg':
      void chatStore.send(chatId.value, '画一张你现在的样子给我看看');
      break;
    default:
      showToast('M1 接入：选图后交给视觉模型看');
  }
}

function answerDate(messageId: string, ok: boolean) {
  const m = byId.value.get(messageId);
  const part = m?.parts.find((p) => p.type === 'date');
  if (part && part.type === 'date') part.status = ok ? 'accepted' : 'declined';
  void chatStore.send(chatId.value, ok ? '好呀，一言为定！' : '这周可能不太行……下周好不好？');
}

const imageOpen = ref(false);
const imagePart = ref<MessagePart | null>(null);
function openImage(p: MessagePart) {
  imagePart.value = p;
  imageOpen.value = true;
}

const moreOpen = ref(false);
const moreActions = computed(() => [
  { name: '查看提示词', subname: '按预设组装后的完整提示（含世界书、记忆、环境）', key: 'inspect' },
  { name: '角色设定', subname: character.value?.name, key: 'character' },
  { name: '记忆本', subname: '她记得的事，可以改', key: 'memory' },
  { name: '世界书', key: 'lore' },
  { name: '预设', subname: preset.value?.name, key: 'preset' },
  { name: '导出聊天', subname: 'SillyTavern .jsonl（M1）', key: 'export' },
]);
function onMore(a: { key: string }) {
  moreOpen.value = false;
  const c = character.value;
  const target: Record<string, string> = {
    inspect: `/chat/${chatId.value}/inspect`,
    character: `/me/characters/${c?.id}`,
    memory: '/memories?tab=book',
    lore: `/me/lorebooks/${c?.lorebookIds[0] ?? ''}`,
    preset: `/me/presets/${preset.value?.id ?? 'preset-daily'}`,
  };
  if (target[a.key]) void router.push(target[a.key] as string);
  else showToast('M1 实现');
}

// —— 剧场模式 ——
const { bubble, combo, onPoke } = usePoke(
  () => character.value?.id ?? '',
  () => chatId.value,
);
const firstPoke = ref(true);
watch(combo, () => (firstPoke.value = false));
const logOpen = ref(false);
const autoOn = ref(false);
const voiceOn = ref(true);
const stageText = computed(() => lastAi.value?.text || character.value?.card.firstMes || '');
const timeChip = `${hhmm(Date.now())} · ${weather.text} ${weather.tempC}°`;
</script>

<template>
  <div v-if="chat && character" class="page chat-page" data-page="chat">
    <!-- IM 模式 -->
    <template v-if="mode === 'im'">
      <PageHeader fallback="/chats">
        <template #title>
          <RouterLink :to="`/me/characters/${character.id}`" class="flex items-center gap-2.5 min-w-0 text-inherit no-underline">
            <Avatar :character="character" :size="36" live status="online" />
            <div class="min-w-0">
              <div class="flex items-center gap-1.5">
                <span class="font-600 text-[16px] truncate">{{ chat.title }}</span>
                <span class="aff"><span class="i-lucide-heart" />{{ character.relationship.affection }}</span>
              </div>
              <div class="text-[11.5px] text-ink-3 truncate">
                {{ stream ? '对方正在输入…' : character.status }} · {{ weather.text }} {{ weather.tempC }}°C
              </div>
            </div>
          </RouterLink>
        </template>
        <template #right>
          <RouterLink :to="`/call/${character.id}`" class="icon-btn" aria-label="语音通话"><span class="i-lucide-phone text-[19px]" /></RouterLink>
          <button class="icon-btn" aria-label="切换到剧场模式" @click="setMode('stage')"><span class="i-lucide-drama text-[20px]" /></button>
          <button class="icon-btn" aria-label="更多" @click="moreOpen = true"><span class="i-lucide-ellipsis text-[20px]" /></button>
        </template>
      </PageHeader>

      <div ref="scroller" class="page-scroll chat-bg">
        <div class="py-3">
          <template v-for="r in rows" :key="r.id">
            <div v-if="r.kind === 'divider'" class="divider num">{{ dividerTime(r.ts) }}</div>
            <MessageItem
              v-else-if="byId.get(r.id)"
              :message="byId.get(r.id)!"
              :character="character"
              :is-last="r.id === messages.at(-1)?.id"
              :streaming="stream?.messageId === r.id"
              :thinking="!!stream?.thinking"
              @swipe="(d) => chatStore.swipe(chatId, r.id, d)"
              @regenerate="chatStore.regenerate(chatId, r.id)"
              @choose="(t) => chatStore.send(chatId, t)"
              @open-music="router.push('/scene/music')"
              @open-image="openImage"
              @answer-date="(ok) => answerDate(r.id, ok)"
            />
          </template>
        </div>
      </div>
      <Composer :busy="!!stream" @send="(t) => chatStore.send(chatId, t)" @stop="chatStore.stop(chatId)" @voice="onVoice" @action="onAction" />
    </template>

    <!-- 剧场模式 -->
    <StageView v-else :character="character" :expression="expression" backdrop="bedroom" rain pokeable @poke="onPoke">
      <div class="stage-top">
        <button class="chip-btn" aria-label="返回" @click="goBack('/chats')"><span class="i-lucide-chevron-left text-[20px]" /></button>
        <span class="chip-btn !px-3 num"><span class="i-lucide-cloud-rain" />{{ timeChip }}</span>
        <span class="chip-btn !px-3"><span class="i-lucide-heart text-accent" />{{ character.relationship.affection }}</span>
        <span class="flex-1" />
        <button class="chip-btn" aria-label="切换到聊天模式" @click="setMode('im')"><span class="i-lucide-message-circle text-[19px]" /></button>
        <RouterLink :to="`/call/${character.id}`" class="chip-btn" aria-label="语音通话"><span class="i-lucide-phone text-[18px]" /></RouterLink>
      </div>
      <div v-if="firstPoke" class="hint">点她的头、脸、肩膀试试 · 长按是摸头</div>
      <Transition name="pop">
        <div v-if="bubble" :key="bubble.id" class="poke-bubble">{{ bubble.text }}</div>
      </Transition>
      <div v-if="combo > 1" class="combo num">连击 ×{{ combo }}</div>
      <DialogBox
        :name="character.name"
        :text="stageText"
        :streaming="!!stream"
        :thinking="!!stream?.thinking"
        :choices="lastAi?.meta.choices ?? []"
        :voice-on="voiceOn"
        :auto-on="autoOn"
        @reply="(t) => chatStore.send(chatId, t)"
        @choose="(t) => chatStore.send(chatId, t)"
        @log="logOpen = true"
        @toggle-voice="voiceOn = !voiceOn"
        @toggle-auto="autoOn = !autoOn"
      />
    </StageView>

    <van-action-sheet v-model:show="moreOpen" :actions="moreActions" cancel-text="取消" close-on-click-action @select="onMore" />

    <van-popup v-model:show="logOpen" position="bottom" round :style="{ maxHeight: '72%' }">
      <div class="p-4">
        <div class="text-[15px] font-600 mb-2">对话记录</div>
        <div v-for="m in messages.slice(-12)" :key="m.id" class="py-2 text-[14px] leading-relaxed border-b border-line">
          <span class="font-600" :class="m.role === 'user' ? 'text-ink-2' : 'text-accent-ink'">{{ m.role === 'user' ? '我' : m.role === 'narrator' ? '旁白' : character.name }}：</span>
          {{ m.text || '［卡片］' }}
        </div>
      </div>
    </van-popup>

    <van-popup v-model:show="imageOpen" round class="w-[88%] max-w-[400px]">
      <div v-if="imagePart && imagePart.type === 'image'" class="p-3">
        <CgArt :character="character" scene="library" expression="shy" class="rounded-[16px]" />
        <div class="mt-3 text-[15px] font-600">{{ imagePart.caption }}</div>
        <div class="mt-1 text-[12px] text-ink-3 break-all">提示词：{{ imagePart.prompt ?? '生成中…' }}</div>
        <div v-if="imagePart.seed" class="text-[12px] text-ink-3 num">种子：{{ imagePart.seed }} · NovelAI V4.5</div>
        <div class="flex gap-2 mt-3">
          <van-button size="small" round block>重新生成</van-button>
          <van-button size="small" round block type="primary">存进相册</van-button>
        </div>
      </div>
    </van-popup>
  </div>
  <div v-else class="page items-center justify-center text-ink-3" data-page="chat-missing">找不到这个聊天</div>
</template>

<style scoped>
.chat-bg {
  background:
    radial-gradient(120% 60% at 50% -10%, var(--accent-soft), transparent 60%),
    var(--bg);
}
.divider {
  margin: 10px auto 6px;
  width: fit-content;
  padding: 2px 10px;
  border-radius: 99px;
  font-size: 11.5px;
  color: var(--ink-3);
  background: var(--panel);
}
.aff {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  height: 18px;
  padding: 0 6px;
  border-radius: 99px;
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: 11px;
  font-weight: 600;
}
.stage-top {
  position: absolute;
  z-index: 10;
  top: calc(var(--safe-top) + 10px);
  left: 10px;
  right: 10px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.chip-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-width: 38px;
  height: 38px;
  padding: 0 8px;
  border-radius: 99px;
  background: var(--glass);
  border: 1px solid var(--glass-line);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  color: var(--ink);
  font-size: 13px;
  text-decoration: none;
}
.hint {
  position: absolute;
  z-index: 5;
  top: calc(var(--safe-top) + 62px);
  left: 50%;
  transform: translateX(-50%);
  padding: 5px 12px;
  border-radius: 99px;
  background: var(--glass);
  color: var(--ink-2);
  font-size: 12.5px;
  white-space: nowrap;
}
.poke-bubble {
  position: absolute;
  z-index: 6;
  top: 20%;
  left: 50%;
  transform: translateX(-50%);
  max-width: 72%;
  padding: 9px 14px;
  border-radius: 18px;
  background: var(--glass-strong);
  border: 1px solid var(--accent-line);
  box-shadow: var(--shadow-sm);
  font-size: 15px;
  text-align: center;
}
.combo {
  position: absolute;
  z-index: 6;
  top: calc(20% - 34px);
  right: 14%;
  color: var(--accent-ink);
  font-weight: 700;
  font-size: 15px;
  transform: rotate(-8deg);
}
.pop-enter-active {
  transition:
    transform 0.25s var(--ease),
    opacity 0.25s;
}
.pop-leave-active {
  transition: opacity 0.3s;
}
.pop-enter-from {
  opacity: 0;
  transform: translate(-50%, 8px) scale(0.92);
}
.pop-leave-to {
  opacity: 0;
}
</style>
