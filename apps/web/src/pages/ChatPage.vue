<script setup lang="ts">
import { getLocation, isRainy, isRealPlace, worldOf, type ImageMode, type MapLocation, type MessagePart } from '@app/shared';
import { isAbortError } from '@app/ai';
import { closeToast, showConfirmDialog, showLoadingToast, showToast } from 'vant';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import CameraSheet from '@/components/chat/CameraSheet.vue';
import Composer from '@/components/chat/Composer.vue';
import PhotoSendSheet from '@/components/chat/PhotoSendSheet.vue';
import DrawSheet from '@/components/chat/DrawSheet.vue';
import MessageItem from '@/components/chat/MessageItem.vue';
import Avatar from '@/components/common/Avatar.vue';
import ErrorDetails from '@/components/common/ErrorDetails.vue';
import GenImage from '@/components/figure/GenImage.vue';
import DialogBox from '@/components/stage/DialogBox.vue';
import Wallpaper from '@/components/common/Wallpaper.vue';
import BackgroundEditor from '@/components/settings/BackgroundEditor.vue';
import PresetPicker from '@/components/settings/PresetPicker.vue';
import StageView from '@/components/stage/StageView.vue';
import { usePoke } from '@/composables/usePoke';
import PageHeader from '@/layouts/PageHeader.vue';
import { mockToday } from '@/mock/activity';
import { goBack } from '@/router';
import { services } from '@/services';
import { assetUrl, putAsset } from '@/services/assets';
import type { VoiceRecording } from '@/services/recorder';
import { personaOf, presetFor } from '@/services/prompt';
import { pendingForSummary, type SummaryOutcome } from '@/services/summary';
import { useAiStore } from '@/stores/ai';
import { useAppStore } from '@/stores/app';
import { useAppearanceStore } from '@/stores/appearance';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';
import { useMemoryStore } from '@/stores/memory';
import { useMessageSettingsStore } from '@/stores/messageSettings';
import { useWeatherStore } from '@/stores/weather';
import { dividerTime, hhmm } from '@/utils/time';
import { copyWithToast, showErrorDialog } from '@/utils/errors';
import { cameraSupported } from '@/utils/camera';
import { uid } from '@/utils/id';
import { compressPhoto } from '@/utils/image';

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

// —— 消息设置 → 显示条数：只显示最近的消息；顶部按钮每次再展开同样条数，切换聊天后复原 ——
const msgSettings = useMessageSettingsStore();
const earlier = ref(0);
watch(chatId, () => (earlier.value = 0));
// 打开聊天时还没有取过记忆就在后台取一次（之后每次她回复完都会取下一轮的）
const memoryStore = useMemoryStore();
watch(
  [chatId, () => memoryStore.ready],
  ([id, ready]) => {
    if (id && ready) chatStore.ensureRecall(id);
  },
  { immediate: true },
);
/** 从第几条开始显示：显示条数的限制，和"自动隐藏已总结的消息"（总结覆盖到的那条之后才显示） */
const shownFrom = computed(() => {
  const s = msgSettings.settings;
  const limitFrom = s.showLimit ? messages.value.length - s.showLast : 0;
  const summarized = s.hideSummarized && chat.value?.summaryUntilMessageId ? messages.value.findIndex((m) => m.id === chat.value?.summaryUntilMessageId) + 1 : 0;
  return Math.max(0, Math.max(limitFrom, summarized) - earlier.value);
});
async function showEarlier() {
  const el = scroller.value;
  const before = el ? el.scrollHeight - el.scrollTop : 0;
  earlier.value += msgSettings.settings.showLast;
  // 上面多出来的消息不把你正在看的那条顶走
  await nextTick();
  if (el) el.scrollTop = el.scrollHeight - before;
}

/** 两条消息间隔超过 20 分钟插一条时间分隔 */
const rows = computed(() => {
  const out: ({ kind: 'divider'; id: string; ts: number } | { kind: 'msg'; id: string })[] = [];
  let prev = 0;
  for (const m of messages.value.slice(shownFrom.value)) {
    if (m.createdAt - prev > 20 * 60_000) out.push({ kind: 'divider', id: `d-${m.id}`, ts: m.createdAt });
    out.push({ kind: 'msg', id: m.id });
    prev = m.createdAt;
  }
  return out;
});
const byId = computed(() => new Map(messages.value.map((m) => [m.id, m])));
/** 每条是第几条（正则按深度、HTML 界面只在最后几条里运行；酒馆助手的"第几楼"） */
const indexOf = computed(() => new Map(messages.value.map((m, i) => [m.id, i])));
/** 显示时跑的正则：这个角色的对话预设里"只改显示"的 */
const displayRegex = computed(() => (preset.value?.regex ?? []).filter((r) => r.markdownOnly && r.enabled));
const regexNames = computed(() => ({ char: character.value?.name ?? '', user: personaOf(chat.value).name }));

const scroller = ref<HTMLElement | null>(null);
async function scrollToBottom(smooth = false) {
  await nextTick();
  const el = scroller.value;
  if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
}

onMounted(() => {
  chatStore.markRead(chatId.value);
  if (route.query.at) void focusMessage(route.query.at as string);
  else void scrollToBottom();
});

/** 从记忆本"回到原话"：展开到那条消息、滚过去、闪一下 */
async function focusMessage(id: string) {
  const idx = messages.value.findIndex((m) => m.id === id);
  if (idx < 0) return void scrollToBottom();
  if (idx < shownFrom.value) earlier.value += shownFrom.value - idx + 3;
  await nextTick();
  setTimeout(() => {
    const el = scroller.value?.querySelector<HTMLElement>(`[data-mid="${CSS.escape(id)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1700);
  }, 60);
}
watch(
  () => route.query.at,
  (id) => {
    if (typeof id === 'string' && id) void focusMessage(id);
  },
);
// 正在看这条聊天：她这时发来的主动消息直接算已读、不弹横幅；"一起""回忆"也跟着换成她
watch(
  chatId,
  (id) => {
    app.viewingChatId = id;
    if (character.value) app.activeCharacterId = character.value.id;
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  if (app.viewingChatId === chatId.value) app.viewingChatId = null;
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
    case 'video-call':
      void router.push(`/call/${c.id}?video=1`);
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
      // 直接调生图：选画什么、写一句画面（可以不写），不经过聊天模型
      drawOpen.value = true;
      break;
    case 'album':
      // 还在这次点击里：直接打开系统的相册 / 文件选择（iPhone 是照片图库，安卓是照片选择器）
      openAlbum();
      break;
    case 'camera':
      openCamera();
      break;
    default:
      showToast('这个还没做');
  }
}

// —— 发照片（＋ → 相册 / 拍照）——
const ai = useAiStore();
const MAX_PHOTOS = 9;
const albumInput = ref<HTMLInputElement | null>(null);
const cameraInput = ref<HTMLInputElement | null>(null);
const cameraOpen = ref(false);
const picked = ref<{ id: string; file: Blob; url: string }[]>([]);
const visionStatus = computed(() => ai.status('vision'));
function openAlbum() {
  albumInput.value?.click();
}
/** 系统相机（<input capture>）：App 里开不了相机、没给权限时用它 */
function openSystemCamera() {
  cameraInput.value?.click();
}
/** App 里开相机（会弹相机权限）；浏览器不支持时直接用系统相机 */
function openCamera() {
  if (cameraSupported()) cameraOpen.value = true;
  else openSystemCamera();
}
function addPicked(files: Blob[]) {
  const room = MAX_PHOTOS - picked.value.length;
  if (files.length > room) showToast(`一次最多发 ${MAX_PHOTOS} 张`);
  for (const f of files.slice(0, Math.max(0, room))) picked.value.push({ id: uid('ph'), file: f, url: URL.createObjectURL(f) });
}
function onPhotoFiles(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = [...(input.files ?? [])].filter((f) => f.type.startsWith('image/') || /\.(heic|heif|jpe?g|png|webp|gif|avif)$/i.test(f.name));
  input.value = '';
  if (!files.length) return;
  cameraOpen.value = false;
  addPicked(files);
}
function onShot(blob: Blob) {
  addPicked([blob]);
}
function removePicked(id: string) {
  const p = picked.value.find((x) => x.id === id);
  if (p) URL.revokeObjectURL(p.url);
  picked.value = picked.value.filter((x) => x.id !== id);
}
function clearPicked() {
  for (const p of picked.value) URL.revokeObjectURL(p.url);
  picked.value = [];
}
const photoSheetOpen = computed({ get: () => picked.value.length > 0 && !cameraOpen.value, set: (v) => !v && clearPicked() });
/** 压缩（长边 1600px 的 JPEG）→ 发出去 → 识图看 → 她回；识图没接通时照样发，告诉你为什么她看不到 */
async function sendPicked(text: string) {
  const list = picked.value.slice();
  const target = chatId.value;
  picked.value = [];
  showLoadingToast({ message: '正在处理照片…', duration: 0, forbidClick: true });
  let photos: Awaited<ReturnType<typeof compressPhoto>>[] = [];
  try {
    photos = await Promise.all(list.map((p) => compressPhoto(p.file)));
  } catch (e) {
    closeToast();
    showErrorDialog('照片读不出来', new Error(`${e instanceof Error ? e.message : String(e)}（HEIC 格式的照片可以在相册里先导出成 JPG 再选）`));
    return;
  } finally {
    for (const p of list) URL.revokeObjectURL(p.url);
  }
  closeToast();
  void scrollToBottom(true);
  const r = await chatStore.sendPhotos(target, photos, text);
  if (r.notConnected) showToast({ message: `识图还没接通，${character.value?.name ?? '她'}看不到照片内容：${r.notConnected}`, duration: 3500 });
}
/** 照片查看器里"重新识图" */
function relook() {
  const p = imagePart.value;
  const m = p?.type === 'image' ? messages.value.find((x) => x.parts.includes(p)) : undefined;
  if (m) void chatStore.lookAt(chatId.value, m.id, true);
}

/** 歌曲卡片"一起听"：去一起听歌，按歌名 + 歌手搜这首放 */
function openMusic(p: MessagePart) {
  const q = p.type === 'music' ? `${p.title} ${p.artist}`.trim() : '';
  void router.push({ path: '/scene/music', query: q ? { q } : {} });
}

function answerDate(messageId: string, ok: boolean) {
  const m = byId.value.get(messageId);
  const part = m?.parts.find((p) => p.type === 'date');
  if (part && part.type === 'date') part.status = ok ? 'accepted' : 'declined';
  void chatStore.send(chatId.value, ok ? '好呀，一言为定！' : '这周可能不太行……下周好不好？');
}

// —— 生成配图（＋ → 生成配图）——
const drawOpen = ref(false);
function onDraw(req: { mode: ImageMode; caption: string }) {
  drawOpen.value = false;
  chatStore.drawImage(chatId.value, req);
  void scrollToBottom(true);
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
/** 保存图片：本机素材库里的存成文件；服务商只给了链接的，新开一页打开 */
async function saveImage() {
  const p = imagePart.value;
  if (p?.type !== 'image' || !p.assetKey) return;
  const name = (p.title || p.caption).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) || 'image';
  if (/^https?:/.test(p.assetKey)) {
    window.open(p.assetKey, '_blank', 'noopener');
    return;
  }
  const url = /^(?:data:|blob:)/.test(p.assetKey) ? p.assetKey : await assetUrl(p.assetKey);
  if (!url) {
    showToast('本机找不到这张图了');
    return;
  }
  const blob = await fetch(url).then((r) => r.blob());
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${name}.${(blob.type.split('/')[1] ?? 'png').replace('jpeg', 'jpg')}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
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
  // 只有一张图的消息（生成配图画的）：重试 = 重新画这张，不是让聊天模型再回一条
  const img = m.role === 'assistant' && !m.text.trim() ? m.parts.find((p) => p.type === 'image') : undefined;
  if (img) {
    toolsFor.value = null;
    chatStore.redraw(chatId.value, img);
    return;
  }
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

const presetLine = computed(() => (preset.value ? `正在用「${preset.value.name}」，点这里换` : '没有可用的预设，点这里看看'));
const pendingSummary = computed(() => (chat.value ? pendingForSummary(chat.value, messages.value).length : 0));

const moreActions = computed(() => [
  { name: '聊天背景', subname: looks.hasOwnBackground(chatId.value) ? '这个聊天单独设置了' : '跟随外观里的通用背景', key: 'background' },
  { name: '查看提示词', subname: '按预设组装后的完整提示（含世界书、记忆、环境）', key: 'inspect' },
  { name: '角色设定', subname: character.value?.name, key: 'character' },
  { name: '记忆本', subname: '她记得的事，可以改', key: 'memory' },
  { name: '世界书', key: 'lore' },
  { name: '预设', subname: presetLine.value, key: 'preset' },
  {
    name: '整理这段聊天',
    subname: chatStore.summarizing[chatId.value] ? '正在整理…' : `用"总结"预设写梗概、故事片段和记忆 · 还有 ${pendingSummary.value} 条没整理（攒够 ${msgSettings.summaryEvery()} 条会自动整理）`,
    key: 'summary',
  },
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
  else if (a.key === 'summary') void summarize();
  else if (target[a.key]) void router.push(target[a.key] as string);
  else showToast('M1 实现');
}

// —— 换预设（这个角色的对话预设）——
const presetOpen = ref(false);
function pickPreset(id: string | null) {
  presetOpen.value = false;
  const c = character.value;
  if (!c || !id || id === preset.value?.id) return;
  chars.setPreset(c.id, id);
  showToast(`换成「${preset.value?.name ?? ''}」了，下一条回复起生效`);
}

// —— 整理这段聊天（总结）——
const summaryResult = ref<SummaryOutcome | null>(null);
const summaryOpen = computed({ get: () => !!summaryResult.value, set: (v) => !v && (summaryResult.value = null) });
async function summarize() {
  const id = chatId.value;
  if (chatStore.summarizing[id]) return;
  showLoadingToast({ message: '正在整理…', duration: 0, forbidClick: true });
  try {
    const r = await chatStore.summarizeNow(id);
    closeToast();
    if (r) summaryResult.value = r;
    else showToast('没有要整理的（最近 4 条先不整理）');
  } catch (e) {
    closeToast();
    showErrorDialog('没整理出来', e);
  }
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
/** 她那边的天气（她在别的城市时是那里的，否则和你一样）；顶栏、剧场的时间条用 */
const weatherStore = useWeatherStore();
const herWeather = computed(() => weatherStore.forCharacter(character.value));
const herWeatherText = computed(() => {
  const w = herWeather.value;
  if (!w) return '';
  return weatherStore.hasOwnCity(character.value) ? `${w.place} ${weatherStore.short(w)}` : weatherStore.short(w);
});
/** 剧场背景所在地点的天气：你真实世界里的地方看你那边的，她小世界里的看她那边的 */
const stageWeather = computed(() => (isRealPlace(stageLoc.value) ? weatherStore.mine : herWeather.value));
const timeChip = computed(() => [hhmm(Date.now()), stageWeather.value ? weatherStore.short(stageWeather.value) : ''].filter(Boolean).join(' · '));

/** 剧场背景：她此刻在的地方（在家时是卧室） */
const stageLoc = computed<MapLocation>(() => getLocation(character.value?.locationId) ?? (worldOf(character.value?.id).locations[0] as MapLocation));
/** 知不知道她在哪：导入的角色还没有自己的小世界时不显示地点（不借用别人的世界） */
const placeKnown = computed(() => !!getLocation(character.value?.locationId));
/** 在地图上看：她世界里的地点去她的世界，你真实世界里的地点去"我的世界" */
const mapLink = computed(() => `/map?world=${isRealPlace(stageLoc.value) ? 'me' : character.value?.id}&focus=${stageLoc.value.id}`);
const stageBackdrop = computed(() => (stageLoc.value.area === 'home' ? 'bedroom' : stageLoc.value.backdrop));
const stageRain = computed(() => isRainy(stageWeather.value?.text) && (!stageLoc.value.indoor || ['bedroom', 'library', 'cafe'].includes(stageBackdrop.value)));
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
                <span class="truncate">{{ stream ? '对方正在输入…' : character.status || '在线' }}{{ herWeatherText ? ` · ${herWeatherText}` : '' }}</span>
              </span>
              <RouterLink v-else :to="mapLink" class="where" aria-label="在地图上看她在哪">
                <span class="i-lucide-map-pin text-accent-ink shrink-0" />
                <span class="truncate">{{ stageLoc.name }} · {{ stream ? '对方正在输入…' : character.status }}{{ herWeatherText ? ` · ${herWeatherText}` : '' }}</span>
              </RouterLink>
            </div>
          </div>
        </template>
        <template #right>
          <RouterLink :to="`/call/${character.id}?video=1`" class="icon-btn" aria-label="视频通话"><span class="i-lucide-video text-[19px]" /></RouterLink>
          <RouterLink :to="`/call/${character.id}`" class="icon-btn" aria-label="语音通话"><span class="i-lucide-phone text-[19px]" /></RouterLink>
          <button class="icon-btn" aria-label="切换到剧场模式" @click="setMode('stage')"><span class="i-lucide-drama text-[20px]" /></button>
          <button class="icon-btn" aria-label="更多" @click="moreOpen = true"><span class="i-lucide-ellipsis text-[20px]" /></button>
        </template>
      </PageHeader>

      <div ref="scroller" class="page-scroll" :class="{ 'chat-bg': !hasWall }" @click="toolsFor = null">
        <div class="py-3">
          <button v-if="shownFrom > 0" type="button" class="earlier press" data-testid="show-earlier" @click.stop="showEarlier">
            <span class="i-lucide-history" />查看更早的消息（{{ shownFrom }}）
          </button>
          <template v-for="r in rows" :key="r.id">
            <div v-if="r.kind === 'divider'" class="divider num">{{ dividerTime(r.ts) }}</div>
            <MessageItem
              v-else-if="byId.get(r.id)"
              :data-mid="r.id"
              :message="byId.get(r.id)!"
              :character="character"
              :is-last="r.id === messages.at(-1)?.id"
              :streaming="stream?.messageId === r.id"
              :thinking="!!stream?.thinking"
              :tools-open="toolsFor === r.id"
              :editing="editingId === r.id"
              :regex="displayRegex"
              :names="regexNames"
              :index="indexOf.get(r.id)"
              :last-index="messages.length - 1"
              @toggle-tools="toggleTools(r.id)"
              @swipe="(d) => chatStore.swipe(chatId, r.id, d)"
              @regenerate="retry(r.id)"
              @edit="startEdit(r.id)"
              @copy="copyMessage"
              @delete="removeMessage(r.id)"
              @save-edit="(t) => saveEdit(r.id, t)"
              @cancel-edit="editingId = null"
              @choose="(t) => chatStore.send(chatId, t)"
              @open-music="openMusic"
              @open-image="openImage"
              @answer-date="(ok) => answerDate(r.id, ok)"
            />
          </template>
        </div>
      </div>
      <Composer :key="chatId" :busy="!!stream" :voice-busy="recognizing > 0" @send="(t) => chatStore.send(chatId, t)" @stop="chatStore.stop(chatId)" @voice="onVoice" @voice-error="(e) => showErrorDialog('录音失败', e)" @action="onAction" />
      <!-- 相册（可以多选）、系统相机：真的系统选择器，选完先预览再发 -->
      <input ref="albumInput" type="file" accept="image/*" multiple class="file-hidden" aria-hidden="true" tabindex="-1" data-testid="album-input" @change="onPhotoFiles" />
      <input ref="cameraInput" type="file" accept="image/*" capture="environment" class="file-hidden" aria-hidden="true" tabindex="-1" data-testid="camera-input" @change="onPhotoFiles" />
      <CameraSheet v-model:show="cameraOpen" @shot="onShot" @system-camera="openSystemCamera" @album="openAlbum" />
      <van-popup v-model:show="photoSheetOpen" position="bottom" round>
        <PhotoSendSheet
          :photos="picked"
          :max="MAX_PHOTOS"
          :vision-live="visionStatus.live"
          :vision-reason="visionStatus.live ? '' : visionStatus.reason"
          :her-name="character.name"
          @send="sendPicked"
          @remove="removePicked"
          @add="openAlbum"
          @camera="openCamera"
          @close="clearPicked"
        />
      </van-popup>
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
        <RouterLink :to="`/call/${character.id}?video=1`" class="chip-btn" aria-label="视频通话"><span class="i-lucide-video text-[18px]" /></RouterLink>
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
        <div class="sheet-title">对话预设 · {{ character.name }}</div>
        <p class="text-[12.5px] text-ink-3 mt-1 mb-3 leading-relaxed">
          聊天（气泡、剧场模式）用这套，下一条回复起生效，聊天记录不变。功能、主动消息、番外、总结、配图的预设在
          <RouterLink to="/me/presets" class="text-accent-ink" @click="presetOpen = false">我的 → 预设</RouterLink> 里选。
        </p>
        <PresetPicker :model-value="preset?.id" category="chat" @update:model-value="pickPreset" @edit="presetOpen = false" />
        <RouterLink to="/import" class="import-link" @click="presetOpen = false"><span class="i-lucide-file-down" />导入预设（SillyTavern 预设或预设文件）</RouterLink>
      </div>
    </van-popup>

    <van-popup v-model:show="summaryOpen" position="bottom" round :style="{ maxHeight: '80%' }">
      <div v-if="summaryResult" class="sheet" data-testid="summary-sheet">
        <div class="sheet-title">整理好了 · {{ summaryResult.covered }} 条 · {{ summaryResult.slices }} 个故事片段</div>
        <p class="story">{{ summaryResult.text }}</p>
        <div v-if="summaryResult.memories.length" class="text-[13px] text-ink-2 leading-relaxed">
          <div class="font-600 mb-1">{{ character.pronoun }}记下了：</div>
          <div v-for="m in summaryResult.memories" :key="m">· {{ m }}</div>
        </div>
        <div class="text-[11.5px] text-ink-3 mt-3">
          预设「{{ summaryResult.presetName }}」· {{ summaryResult.model }}{{ summaryResult.affectionDelta ? ` · 好感 ${summaryResult.affectionDelta > 0 ? '+' : ''}${summaryResult.affectionDelta}` : '' }} · 摘要进了提示词里的"过往摘要"
        </div>
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

    <van-popup v-model:show="drawOpen" position="bottom" round :style="{ maxHeight: '90%' }">
      <DrawSheet v-if="drawOpen" :character="character" @draw="onDraw" @close="drawOpen = false" />
    </van-popup>

    <van-popup v-model:show="imageOpen" round class="w-[88%] max-w-[400px]">
      <div v-if="imagePart && imagePart.type === 'image' && imagePart.photo" class="p-3 max-h-[86vh] overflow-y-auto" data-testid="photo-viewer">
        <GenImage :part="imagePart" :character="character" class="rounded-[16px] overflow-hidden" />
        <div class="mt-3 text-[13px] font-600">识图看到的</div>
        <p v-if="imagePart.seen" class="text-[13.5px] leading-relaxed text-ink-2 mt-1 whitespace-pre-wrap">{{ imagePart.seen }}</p>
        <p v-else-if="imagePart.assetKey && chatStore.lookingKeys.has(imagePart.assetKey)" class="text-[13px] text-ink-3 mt-1">正在看…</p>
        <p v-else class="text-[13px] text-warn mt-1">{{ imagePart.seenError || '还没识图' }}</p>
        <div v-if="imagePart.seenModel" class="text-[12px] text-ink-3 mt-1">{{ imagePart.seenModel }} · 聊天里{{ character.name }}看到的是这段描述</div>
        <div class="flex gap-2 mt-3">
          <van-button v-if="!imagePart.seen" size="small" round block :disabled="!!imagePart.assetKey && chatStore.lookingKeys.has(imagePart.assetKey)" @click="relook">重新识图</van-button>
          <van-button size="small" round block type="primary" :disabled="!imagePart.assetKey" @click="saveImage">保存图片</van-button>
        </div>
      </div>
      <div v-else-if="imagePart && imagePart.type === 'image'" class="p-3 max-h-[86vh] overflow-y-auto" data-testid="image-viewer">
        <GenImage :part="imagePart" :character="character" class="rounded-[16px] overflow-hidden" />
        <div class="mt-3 text-[15px] font-600">{{ imagePart.title || imagePart.caption }}</div>
        <div v-if="imagePart.title" class="text-[12px] text-ink-3 mt-0.5">画的是：{{ imagePart.caption }}</div>
        <ErrorDetails v-if="imagePart.error" :detail="imagePart.errorDetail ?? imagePart.error" :title="imagePart.error" max-height="30vh" />
        <div class="mt-1 text-[12px] text-ink-3 break-all max-h-[96px] overflow-y-auto">提示词：{{ imagePart.prompt ?? (imagePart.error ? '—' : '生成中…') }}</div>
        <div v-if="imagePart.seed || imagePart.model" class="text-[12px] text-ink-3 num">{{ [imagePart.seed ? `种子：${imagePart.seed}` : '', imagePart.model ?? ''].filter(Boolean).join(' · ') }}</div>
        <div class="flex gap-2 mt-3">
          <van-button size="small" round block :disabled="!imagePart.generated && !imagePart.error" @click="redrawImage">重新生成</van-button>
          <van-button size="small" round block type="primary" :disabled="!imagePart.assetKey" @click="saveImage">保存图片</van-button>
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
/* 相册、系统相机的文件框：看不见，但能用 .click() 打开（iPhone 上 display: none 的有时打不开） */
.file-hidden {
  position: fixed;
  left: -9999px;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}
.chat-bg {
  background:
    radial-gradient(120% 60% at 50% -10%, var(--accent-soft), transparent 60%),
    var(--bg);
}
.story {
  margin: 12px 0 10px;
  font-size: 14.5px;
  line-height: 1.8;
  white-space: pre-wrap;
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
.flash {
  animation: flash 1.6s ease-out;
  border-radius: 14px;
}
@keyframes flash {
  0%,
  40% {
    background: var(--accent-soft);
  }
  100% {
    background: transparent;
  }
}
.earlier {
  display: flex;
  align-items: center;
  gap: 5px;
  margin: 2px auto 8px;
  padding: 5px 12px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 12.5px;
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
