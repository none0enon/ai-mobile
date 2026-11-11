<script setup lang="ts">
import { getLocation, isRealPlace, worldOf, type MapLocation, type MessagePart } from '@app/shared';
import { isAbortError } from '@app/ai';
import { showConfirmDialog, showToast } from 'vant';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Composer from '@/components/chat/Composer.vue';
import MessageItem from '@/components/chat/MessageItem.vue';
import Avatar from '@/components/common/Avatar.vue';
import ErrorDetails from '@/components/common/ErrorDetails.vue';
import GenImage from '@/components/figure/GenImage.vue';
import DialogBox from '@/components/stage/DialogBox.vue';
import Wallpaper from '@/components/common/Wallpaper.vue';
import { backdropAt } from '@/components/scene/location';
import BackgroundEditor from '@/components/settings/BackgroundEditor.vue';
import PresetPicker from '@/components/settings/PresetPicker.vue';
import StageView from '@/components/stage/StageView.vue';
import { usePoke } from '@/composables/usePoke';
import PageHeader from '@/layouts/PageHeader.vue';
import { mockToday, weather } from '@/mock/activity';
import { goBack } from '@/router';
import { services } from '@/services';
import { putAsset } from '@/services/assets';
import type { VoiceRecording } from '@/services/recorder';
import { presetFor } from '@/services/prompt';
import { useAppStore } from '@/stores/app';
import { useAppearanceStore } from '@/stores/appearance';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';
import { dividerTime, hhmm } from '@/utils/time';
import { copyWithToast, showErrorDialog } from '@/utils/errors';

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
const preset = computed(() => presetFor(character.value));

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
  // 最后一条的正文变了、出错了、配图画好了：都滚到底（离底部不远时）
  () => [messages.value.length, messages.value.at(-1)?.text, messages.value.at(-1)?.meta.error, messages.value.at(-1)?.parts.map((p) => (p.type === 'image' ? p.assetKey : '')).join()],
  () => {
    chatStore.markRead(chatId.value);
    const el = scroller.value;
    if (!el || el.scrollHeight - el.scrollTop - el.clientHeight < 240) void scrollToBottom(true);
  },
);

const voiceCalls = new Set<AbortController>();
const recognizing = ref(0);
function cancelVoiceCalls() {
  for (const ctrl of voiceCalls) ctrl.abort();
  voiceCalls.clear();
  recognizing.value = 0;
}
watch(chatId, cancelVoiceCalls, { flush: 'sync' });
onBeforeUnmount(cancelVoiceCalls);

async function onVoice(recording: VoiceRecording) {
  const target = chatId.value;
  const ctrl = new AbortController();
  voiceCalls.add(ctrl);
  recognizing.value = voiceCalls.size;
  try {
    const transcript = await services.stt.transcribe(recording.audio, { signal: ctrl.signal });
    if (ctrl.signal.aborted || chatId.value !== target) return;
    const assetKey = await putAsset(new Uint8Array(await recording.audio.arrayBuffer()), recording.audio.type);
    if (ctrl.signal.aborted || chatId.value !== target) return;
    chatStore.push(target, 'user', [{ type: 'voice', assetKey, durationMs: recording.durationMs, transcript }]);
    void chatStore.generate(target);
  } catch (e) {
    if (!ctrl.signal.aborted && !isAbortError(e)) showErrorDialog('语音识别失败', e);
  } finally {
    voiceCalls.delete(ctrl);
    recognizing.value = voiceCalls.size;
  }
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
      void router.push(placeKnown.value ? mapLink.value : '/map');
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
function redrawImage() {
  if (imagePart.value) chatStore.redraw(chatId.value, imagePart.value);
}

// —— 消息操作：平时藏着，点头像展开（重试 / 编辑 / 复制 / 删除）；点别处收起 ——
const toolsFor = ref<string | null>(null);
const editingId = ref<string | null>(null);
watch(chatId, () => {
  toolsFor.value = null;
  editingId.value = null;
});
function toggleTools(id: string) {
  const el = scroller.value;
  const atBottom = !!el && el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  toolsFor.value = toolsFor.value === id ? null : id;
  // 展开的一排会把最后一条往下顶：本来在底部就跟着滚到底，别让它躲到输入框后面
  if (toolsFor.value && atBottom) void scrollToBottom(true);
}
/** 重试：她的回复再出一个备选（展开的一排留着，好左右对比）；最后一条是你的消息时让她回一条 */
function retry(id: string) {
  const m = byId.value.get(id);
  if (!m || stream.value) return;
  if (m.role === 'user') {
    toolsFor.value = null;
    void chatStore.generate(chatId.value);
  } else void chatStore.regenerate(chatId.value, id);
}
function startEdit(id: string) {
  toolsFor.value = null;
  editingId.value = id;
}
function saveEdit(id: string, text: string) {
  chatStore.editMessage(chatId.value, id, text);
  editingId.value = null;
}
function copyMessage(text: string) {
  toolsFor.value = null;
  void copyWithToast(text);
}
async function removeMessage(id: string) {
  toolsFor.value = null;
  const ok = await showConfirmDialog({
    title: '删除这条消息？',
    message: '删了以后，发给模型的聊天记录里也不会再有它。',
    confirmButtonText: '删除',
    confirmButtonColor: 'var(--bad)',
  }).then(
    () => true,
    () => false,
  );
  if (ok) chatStore.deleteMessage(chatId.value, id);
}

const moreOpen = ref(false);
// —— 聊天背景：这个聊天单独设的 → 外观里的通用背景 ——
const looks = useAppearanceStore();
const wall = computed(() => looks.backgroundOf(chatId.value));
const hasWall = computed(() => !!looks.imageUrl(wall.value?.assetKey));
const wallOpen = ref(false);

const moreActions = computed(() => [
  { name: '聊天背景', subname: looks.hasOwnBackground(chatId.value) ? '这个聊天单独设置了' : '跟随外观里的通用背景', key: 'background' },
  { name: '查看提示词', subname: '按预设组装后的完整提示（含世界书、记忆、环境）', key: 'inspect' },
  { name: '角色设定', subname: character.value?.name, key: 'character' },
  { name: '记忆本', subname: '她记得的事，可以改', key: 'memory' },
  { name: '世界书', key: 'lore' },
  { name: '预设', subname: `正在用「${preset.value?.name ?? ''}」，点这里换`, key: 'preset' },
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
  };
  if (a.key === 'background') wallOpen.value = true;
  else if (a.key === 'preset') presetOpen.value = true;
  else if (target[a.key]) void router.push(target[a.key] as string);
  else showToast('M1 实现');
}

// —— 换预设 ——
const presetOpen = ref(false);
function pickPreset(id: string) {
  presetOpen.value = false;
  const c = character.value;
  if (!c || id === preset.value.id) return;
  chars.setPreset(c.id, id);
  showToast(`换成「${preset.value.name}」了，下一条回复起生效`);
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

/** 剧场背景：你们一起在的地方，否则是她此刻在的地方（家里按正在做的事选房间，平时是卧室） */
const stageLoc = computed<MapLocation>(
  () => getLocation(chat.value?.togetherAt ?? character.value?.locationId) ?? (worldOf(character.value?.id).locations[0] as MapLocation),
);
/** 知不知道她在哪：导入的角色还没有自己的小世界时不显示地点（不借用别人的世界） */
const placeKnown = computed(() => !!getLocation(chat.value?.togetherAt ?? character.value?.locationId));
/** 在地图上看：她世界里的地点去她的世界，你真实世界里的地点去"我的世界" */
const mapLink = computed(() => `/map?world=${isRealPlace(stageLoc.value) ? 'me' : character.value?.id}&focus=${stageLoc.value.id}`);
const stageBackdrop = computed(() =>
  chat.value?.togetherAt && chat.value.currentScene ? backdropAt(stageLoc.value, chat.value.currentScene) : stageLoc.value.area === 'home' ? 'bedroom' : stageLoc.value.backdrop,
);
const stageRain = computed(() => weather.text.includes('雨') && (!stageLoc.value.indoor || ['bedroom', 'library', 'cafe'].includes(stageBackdrop.value)));
</script>

<template>
  <div v-if="chat && character" class="page chat-page" data-page="chat">
    <!-- IM 模式 -->
    <template v-if="mode === 'im'">
      <Wallpaper :background="wall" />
      <PageHeader fallback="/chats">
        <template #title>
          <div class="flex items-center gap-2.5 min-w-0">
            <RouterLink :to="`/me/characters/${character.id}`" class="shrink-0" aria-label="角色设定"><Avatar :character="character" :size="36" live status="online" /></RouterLink>
            <div class="min-w-0">
              <RouterLink :to="`/me/characters/${character.id}`" class="flex items-center gap-1.5 text-inherit no-underline">
                <span class="font-600 text-[16px] truncate min-w-[2.2em]">{{ chat.title }}</span>
                <span class="aff"><span class="i-lucide-heart" />{{ character.relationship.affection }}</span>
              </RouterLink>
              <span v-if="!placeKnown" class="where">
                <span class="truncate">{{ stream ? '对方正在输入…' : character.status || '在线' }} · {{ weather.text }} {{ weather.tempC }}°C</span>
              </span>
              <RouterLink v-else :to="mapLink" class="where" aria-label="在地图上看她在哪">
                <span class="i-lucide-map-pin text-accent-ink shrink-0" />
                <span class="truncate">{{ chat.togetherAt ? `你们在${stageLoc.name}` : stageLoc.name }} · {{ stream ? '对方正在输入…' : character.status }} · {{ weather.text }} {{ weather.tempC }}°C</span>
              </RouterLink>
            </div>
          </div>
        </template>
        <template #right>
          <RouterLink :to="`/call/${character.id}`" class="icon-btn" aria-label="语音通话"><span class="i-lucide-phone text-[19px]" /></RouterLink>
          <button class="icon-btn" aria-label="切换到剧场模式" @click="setMode('stage')"><span class="i-lucide-drama text-[20px]" /></button>
          <button class="icon-btn" aria-label="更多" @click="moreOpen = true"><span class="i-lucide-ellipsis text-[20px]" /></button>
        </template>
      </PageHeader>

      <div ref="scroller" class="page-scroll" :class="{ 'chat-bg': !hasWall }" @click="toolsFor = null">
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
              :tools-open="toolsFor === r.id"
              :editing="editingId === r.id"
              @toggle-tools="toggleTools(r.id)"
              @swipe="(d) => chatStore.swipe(chatId, r.id, d)"
              @regenerate="retry(r.id)"
              @edit="startEdit(r.id)"
              @copy="copyMessage"
              @delete="removeMessage(r.id)"
              @save-edit="(t) => saveEdit(r.id, t)"
              @cancel-edit="editingId = null"
              @choose="(t) => chatStore.send(chatId, t)"
              @open-music="router.push('/scene/music')"
              @open-image="openImage"
              @answer-date="(ok) => answerDate(r.id, ok)"
            />
          </template>
        </div>
      </div>
      <Composer :key="chatId" :busy="!!stream" :voice-busy="recognizing > 0" @send="(t) => chatStore.send(chatId, t)" @stop="chatStore.stop(chatId)" @voice="onVoice" @voice-error="(e) => showErrorDialog('录音失败', e)" @action="onAction" />
    </template>

    <!-- 剧场模式 -->
    <StageView v-else :character="character" :expression="expression" :backdrop="stageBackdrop" :rain="stageRain" pokeable @poke="onPoke">
      <div class="stage-top">
        <button class="chip-btn" aria-label="返回" @click="goBack('/chats')"><span class="i-lucide-chevron-left text-[20px]" /></button>
        <RouterLink v-if="placeKnown" :to="mapLink" class="chip-btn loc-chip !px-3 num"
          ><span class="i-lucide-map-pin shrink-0" /><span class="truncate">{{ stageLoc.name }} · {{ timeChip }}</span></RouterLink
        >
        <span v-else class="chip-btn loc-chip !px-3 num"><span class="truncate">{{ timeChip }}</span></span>
        <span class="chip-btn aff-chip shrink-0 !px-3"><span class="i-lucide-heart text-accent" />{{ character.relationship.affection }}</span>
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
        :error="!stream && lastAi?.meta.error ? (lastAi.meta.errorDetail ?? lastAi.meta.error) : ''"
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

    <van-popup v-model:show="wallOpen" position="bottom" round :style="{ maxHeight: '86%' }">
      <div class="sheet">
        <div class="sheet-title mb-3">聊天背景 · {{ character.name }}</div>
        <BackgroundEditor :scope="chatId" />
      </div>
    </van-popup>

    <van-popup v-model:show="presetOpen" position="bottom" round :style="{ maxHeight: '80%' }">
      <div class="sheet" data-testid="preset-sheet">
        <div class="sheet-title">预设 · {{ character.name }}</div>
        <p class="text-[12.5px] text-ink-3 mt-1 mb-3 leading-relaxed">换了以后，下一条回复起按新预设拼提示词，聊天记录不变。在角色设定 → 预设 里也能换。</p>
        <PresetPicker :model-value="preset.id" @update:model-value="pickPreset" @edit="presetOpen = false" />
        <RouterLink to="/import" class="import-link" @click="presetOpen = false"><span class="i-lucide-file-down" />导入 SillyTavern 预设</RouterLink>
      </div>
    </van-popup>

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
        <GenImage :part="imagePart" :character="character" class="rounded-[16px] overflow-hidden" />
        <div class="mt-3 text-[15px] font-600">{{ imagePart.caption }}</div>
        <ErrorDetails v-if="imagePart.error" :detail="imagePart.errorDetail ?? imagePart.error" title="没画出来" max-height="30vh" />
        <div class="mt-1 text-[12px] text-ink-3 break-all max-h-[96px] overflow-y-auto">提示词：{{ imagePart.prompt ?? (imagePart.error ? '—' : '生成中…') }}</div>
        <div v-if="imagePart.seed" class="text-[12px] text-ink-3 num">种子：{{ imagePart.seed }}{{ imagePart.model ? ` · ${imagePart.model}` : '' }}</div>
        <div class="flex gap-2 mt-3">
          <van-button size="small" round block :disabled="!imagePart.generated && !imagePart.error" @click="redrawImage">重新生成</van-button>
          <van-button size="small" round block type="primary">存进相册</van-button>
        </div>
      </div>
    </van-popup>
  </div>
  <div v-else class="page items-center justify-center text-ink-3" data-page="chat-missing">找不到这个聊天</div>
</template>

<style scoped>
/* 背景图层（Wallpaper，z-index -1）只在这一页里垫在底下 */
.chat-page {
  isolation: isolate;
}
.chat-bg {
  background:
    radial-gradient(120% 60% at 50% -10%, var(--accent-soft), transparent 60%),
    var(--bg);
}
.import-link {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 44px;
  margin-top: 10px;
  border-radius: 14px;
  border: 1.5px dashed var(--border);
  color: var(--ink-2);
  font-size: 13.5px;
  text-decoration: none;
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
.where {
  display: flex;
  align-items: center;
  gap: 3px;
  min-width: 0;
  font-size: 11.5px;
  color: var(--ink-3);
  text-decoration: none;
}
/* 窄屏 + 大字体时先让好感度让位（缩到看不见），再截名字 */
.aff {
  display: inline-flex;
  flex-shrink: 100;
  align-items: center;
  gap: 2px;
  min-width: 0;
  overflow: hidden;
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
  white-space: nowrap;
  text-decoration: none;
}
.loc-chip {
  min-width: 0;
}
/* 窄屏时剧场顶栏把位置让给"她在哪"，好感度在聊天模式的顶栏里还能看到 */
@media (max-width: 360px) {
  .aff-chip {
    display: none;
  }
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
