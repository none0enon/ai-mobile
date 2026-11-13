<script setup lang="ts">
import { errorText, parseJsonLoose } from '@app/ai';
import { getLocation, IMAGE_MOMENTS, MEAL_LABEL, mealOfStatus, toMinutes, wallDate, worldOf, type MealSlot, type MessagePart, type PlanMeal } from '@app/shared';
import { showConfirmDialog, showImagePreview, showToast } from 'vant';
import { computed, inject, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import CameraSheet from '@/components/chat/CameraSheet.vue';
import AssetImg from '@/components/common/AssetImg.vue';
import Avatar from '@/components/common/Avatar.vue';
import ImagePick from '@/components/common/ImagePick.vue';
import PersonaAvatar from '@/components/common/PersonaAvatar.vue';
import Segmented from '@/components/common/Segmented.vue';
import MealCard from '@/components/health/MealCard.vue';
import { SCENE_LOCATION } from '@/components/scene/location';
import SceneShell from '@/components/scene/SceneShell.vue';
import StudyBubble from '@/components/scene/study/StudyBubble.vue';
import { assetUrl, services } from '@/services';
import { putAsset } from '@/services/assets';
import { distanceText } from '@/services/maps';
import { lookWith } from '@/services/photos';
import { personaOf } from '@/services/prompt';
import { useAiStore } from '@/stores/ai';
import { useAppStore } from '@/stores/app';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';
import { useEnvironmentStore } from '@/stores/environment';
import { shapeOf, useGalleryStore, type GalleryItem, type ImageShape } from '@/stores/gallery';
import { useHealthStore } from '@/stores/health';
import { seedBlockContent, useLibraryStore } from '@/stores/library';
import { useRealWorldStore } from '@/stores/realworld';
import { useRhythmStore } from '@/stores/rhythm';
import { cameraSupported } from '@/utils/camera';
import { uid } from '@/utils/id';
import { compressPhoto } from '@/utils/image';
import { clock, hhmm } from '@/utils/time';

/**
 * 一起吃饭（设计文档 §9.2）：照陪伴学习的样子分两种。
 * - 共同吃饭：只在她今天的作息里正好是吃饭的时候能选（带她出门吃时也能）。背景是生图画的整屏竖图：她坐在桌子对面吃她那份（"生图 · 一起吃饭"的"对面"）。
 *   照健身的样子分两种吃法：
 *   - 按计划吃：照今天健康计划里的这顿，先引导你准备——自己做的一步一步照着做，外食的告诉你去哪家、点什么（能开地图），带便当的提醒怎么热；
 *     准备好了开吃，可以拍一张或从相册选一张（可以不拍）；
 *   - 随便吃点：写一句吃了什么，或者拍一张 / 从相册选一张，交给识图认出是什么。
 * - 各吃各的：上下分屏。上半屏是生图画的她那边（她在作息里的地方做自己的事，正好在吃饭就吃她那份；按半屏画方图或横图），
 *   下半屏是你这边（拍了饭照就放饭照）。可以碰杯：画一张她举杯朝你伸过来的样子，她也回一句。
 * 识图看饭照的说明在"一起吃饭"功能预设的"识图看饭照"一块里；照片发进聊天（带着识图看到的），之后的每一轮、总结都知道你吃了什么。
 * 她说的每句话都来自「陪伴 · 快速」（"一起吃饭"功能预设 + 这一次的场景任务），存进聊天；吃完发一张饭卡（吃了什么、怎么吃的、照片、这次画的她）。
 * 没接通时不出演示台词，界面写明原因。
 */
type Phase = 'setup' | 'prep' | 'eat' | 'done';
type How = 'together' | 'solo';
type Mode = 'plan' | 'free';
type Way = 'cook' | 'buy' | 'bento';
type Moment = 'table' | 'side' | 'cheers';

const SLOTS: MealSlot[] = ['breakfast', 'lunch', 'dinner', 'snack'];
const MODE_OPTIONS: { value: Mode; label: string; icon: string }[] = [
  { value: 'plan', label: '按计划吃', icon: 'i-lucide-list-checks' },
  { value: 'free', label: '随便吃点', icon: 'i-lucide-cookie' },
];
const WAY_LABEL: Record<Way, { go: string; ready: string; done: string; icon: string }> = {
  cook: { go: '开始做饭', ready: '做好了，开吃', done: '做好了', icon: 'i-lucide-chef-hat' },
  buy: { go: '去买饭', ready: '买到了，开吃', done: '买到了', icon: 'i-lucide-shopping-bag' },
  bento: { go: '热便当', ready: '热好了，开吃', done: '把便当热好了', icon: 'i-lucide-package' },
};
const WAY_SHORT: Record<Way, string> = { cook: '自己做', buy: '去买', bento: '带便当' };
const SAVE_KEY = 'ai-mobile:meal';
const DAY = 86_400_000;

const app = useAppStore();
const ai = useAiStore();
const chars = useCharacterStore();
const chat = useChatStore();
const env = useEnvironmentStore();
const gallery = useGalleryStore();
const health = useHealthStore();
const lib = useLibraryStore();
const real = useRealWorldStore();
const rhythm = useRhythmStore();
const router = useRouter();
const location = inject(SCENE_LOCATION, ref(null));

const her = computed(() => chars.byId(app.activeCharacterId) ?? chars.list[0]!);
const chatId = computed(() => chat.chatOfCharacter(her.value.id)?.id ?? '');
const persona = computed(() => personaOf(chat.chatById(chatId.value)));
const userName = computed(() => persona.value.name);
/** 连线（你在你那儿）/ 去她那 / 带她来（她在你这边真实的地方） */
const together = computed(() => chat.chatOfCharacter(her.value.id)?.togetherMode ?? 'remote');
const yourPlace = computed(() => (together.value === 'bring' ? (location.value?.name ?? '') : (real.places.find((p) => p.id === real.hereId)?.name ?? '家')));

// —— 时间：每秒走一下（准备了多久；过了饭点、她的作息换了一段，界面跟着变） ——
const now = ref(Date.now());
const wallMin = computed(() => {
  const d = wallDate(now.value, env.settings.timezone);
  return d.getHours() * 60 + d.getMinutes();
});
const dayKey = (t: number) => {
  const d = wallDate(t, env.settings.timezone);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};

// —— 她那边：今天的作息此刻是不是在吃饭 ——
const herSlot = computed(() => rhythm.slotNow(her.value.id, new Date(now.value)));
const herMealSlot = computed(() => (herSlot.value ? mealOfStatus(herSlot.value.status, herSlot.value.from) : null));
/** 能不能共同吃饭：她作息里正好在吃饭；带她出门吃（她就在你对面）也行 */
const canTogether = computed(() => !!herMealSlot.value || together.value === 'bring');
/** 她在哪：带她来时是这家店，否则按她的作息（没有作息时用地图上点进来的地方） */
const herLocId = computed(() => (together.value === 'bring' ? (location.value?.id ?? null) : (herSlot.value?.locationId ?? location.value?.id ?? null)));
const herPlace = computed(() => getLocation(herLocId.value)?.name ?? location.value?.name ?? '');
/** "在家看书"本身带"在"，"自习中"不带：拼成"在…"时不重复 */
const doing = (status: string) => (status.startsWith('在') ? status : `在${status}`);
function herFoodOf(s: MealSlot): string {
  if (s === 'snack') return '';
  return rhythm.mealsOf(her.value.id)?.[s] || (rhythm.hasWorld(her.value.id) ? worldOf(her.value.id).life.meals[s] : '');
}
/** 她这顿吃的：她正在吃饭时是节律里这顿的饭；带她出门时是在这家店点的 */
const herMeal = computed(() => {
  if (together.value === 'bring') return `在${location.value?.name ?? '这家店'}点的`;
  return herMealSlot.value ? herFoodOf(herMealSlot.value) : '';
});
/** 她今天接下来哪一段在吃饭（不能共同吃饭时告诉你什么时候能） */
const herNextMeal = computed(() => {
  const day = rhythm.todayOf(her.value.id);
  if (!day) return null;
  const cur = herSlot.value;
  // 按模板的今天每次读出来都是新的一份：按时间段找，不按对象找
  const i = cur ? day.schedule.findIndex((s) => s.from === cur.from && s.to === cur.to) : -1;
  return day.schedule.slice(i + 1).find((s) => mealOfStatus(s.status, s.from)) ?? null;
});
const togetherHint = computed(() => {
  const p = her.value.pronoun;
  if (together.value === 'bring') return `${p}来${herPlace.value || '你这边'}陪你吃，坐在你对面；背景画${p}在对面吃饭的样子`;
  if (herMealSlot.value) return `${p}现在正好在${herSlot.value?.status}（${herPlace.value}），像坐在一张桌子两边一起吃；背景画${p}在对面吃饭的样子`;
  if (!herSlot.value) return `${p}今天还没有作息，不知道${p}什么时候吃饭，先各吃各的（作息在"我的 → 节律"里）`;
  const next = herNextMeal.value;
  return `${p}现在${doing(herSlot.value.status)}，不在吃饭，只能各吃各的${next ? `；${next.from} ${p}${next.status}，到时候再来共同吃饭` : ''}`;
});

// —— 怎么吃：共同吃饭 / 各吃各的；共同吃饭时按计划吃 / 随便吃点（吃法记在本机） ——
function loadSaved(): { mode?: Mode } {
  try {
    const v = JSON.parse(localStorage.getItem(SAVE_KEY) ?? '{}') as unknown;
    return v && typeof v === 'object' ? (v as { mode?: Mode }) : {};
  } catch {
    return {};
  }
}
const mode = ref<Mode>(loadSaved().mode === 'free' ? 'free' : 'plan');
watch(mode, (m) => {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({ mode: m }));
  } catch {
    // 存不下就算了
  }
});
const how = ref<How>(canTogether.value ? 'together' : 'solo');
// 开始前她的作息换了一段、不在吃饭了：换回各吃各的
watch(canTogether, (ok) => {
  if (!ok && how.value === 'together' && phase.value === 'setup') how.value = 'solo';
});
const howOptions = computed(() => [
  { value: 'together' as How, label: '共同吃饭', icon: 'i-lucide-utensils-crossed', disabled: !canTogether.value },
  { value: 'solo' as How, label: '各吃各的', icon: 'i-lucide-rows-2' },
]);
/** 准备到一半说不照计划了（只这一顿，不改记住的吃法） */
const offPlan = ref(false);
/** 按计划吃（只在共同吃饭时） */
const planned = computed(() => how.value === 'together' && mode.value === 'plan' && !offPlan.value);

// —— 今天吃了哪几顿：从聊天里的饭卡算（真实记录） ——
const mealCards = computed(() =>
  chat.list(chatId.value).flatMap((m) => m.parts.filter((p): p is Extract<MessagePart, { type: 'meal' }> => p.type === 'meal').map((p) => ({ at: m.createdAt, p }))),
);
const eaten = computed(() => {
  const out: Partial<Record<MealSlot, { food: string; at: string }>> = {};
  const today = dayKey(now.value);
  for (const c of mealCards.value) if (dayKey(c.at) === today) out[c.p.meal] = { food: c.p.food, at: hhmm(c.at) };
  return out;
});
const week = computed(() =>
  Array.from({ length: 7 }, (_, i) => {
    const t = now.value - (6 - i) * DAY;
    const k = dayKey(t);
    return { key: k, label: ['日', '一', '二', '三', '四', '五', '六'][wallDate(t, env.settings.timezone).getDay()] as string, on: mealCards.value.some((c) => dayKey(c.at) === k) };
  }),
);
const weekCount = computed(() => mealCards.value.filter((c) => c.at > now.value - 7 * DAY).length);

// —— 哪一顿：按"环境与作息"里的饭点；共同吃饭时跟她这顿；可以自己改 ——
const windowText = (s: MealSlot) => (s === 'snack' ? '饭点以外' : `${env.settings.meals[s].start}–${env.settings.meals[s].end}`);
function slotByClock(): MealSlot {
  const m = wallMin.value;
  const w = env.settings.meals;
  const spans = (['breakfast', 'lunch', 'dinner'] as const).map((k) => ({ k, a: toMinutes(w[k].start) ?? 0, b: toMinutes(w[k].end) ?? 0 }));
  const inside = spans.find((s) => m >= s.a && m < s.b);
  if (inside) return inside.k;
  if (m < spans[0].a - 90 || m >= spans[2].b + 120) return 'snack';
  const dist = (s: (typeof spans)[number]) => (m < s.a ? s.a - m : m - s.b);
  const sorted = [...spans].sort((x, y) => dist(x) - dist(y));
  return (sorted.find((s) => !eaten.value[s.k]) ?? sorted[0]!).k;
}
const pickedSlot = ref<MealSlot | null>(null);
const slot = computed<MealSlot>(() => pickedSlot.value ?? (how.value === 'together' && herMealSlot.value ? herMealSlot.value : slotByClock()));
const label = computed(() => MEAL_LABEL[slot.value]);

// —— 今天健康计划里的这顿 ——
const hs = computed(() => (persona.value.health?.enabled ? persona.value.health : null));
const plan = computed(() => health.dayOf(persona.value.id));
const planMeal = computed<PlanMeal | null>(() => plan.value?.meals[slot.value] ?? null);
const way = computed<Way>(() => (planMeal.value?.cook ? 'cook' : planMeal.value?.bento ? 'bento' : 'buy'));
const planBusy = computed(() => health.busy[persona.value.id]);
const planError = computed(() => health.errors[persona.value.id]);
const healthStatus = computed(() => ai.status('health'));
async function makePlan() {
  const r = await health.planDay(persona.value);
  if (!r.ok && !r.notConnected) showToast(r.reason);
}
const canBegin = computed(() => !!chatId.value && (!planned.value || !!planMeal.value));

// —— 画面：开始前、吃完是上下分屏；共同吃饭整屏竖图；各吃各的上下两屏 ——
const phase = ref<Phase>('setup');
const view = computed<'split' | How>(() => (phase.value === 'setup' || phase.value === 'done' ? 'split' : how.value));
const viewport = reactive({ w: window.innerWidth, h: window.innerHeight });
function onResize() {
  viewport.w = window.innerWidth;
  viewport.h = window.innerHeight;
}
/** 半屏的画幅：手机竖着时半屏接近方形画方图，宽出不少时画横图 */
const halfShape = computed<ImageShape>(() => (Math.min(viewport.w, 480) / Math.max(1, viewport.h / 2) >= 1.25 ? 'landscape' : 'square'));

// —— 生图："生图 · 一起吃饭"的对面、她那边、碰杯 ——
const MOMENTS = IMAGE_MOMENTS.meal ?? {};
/** 共同吃饭的背景（竖图）、各吃各的上半屏（方图或横图）；碰杯画好也放在这两个位置 */
const tableArt = ref<GalleryItem | null>(null);
const sideArt = ref<GalleryItem | null>(null);
/** 这一顿画的图：吃完放进饭卡 */
const sessionArt = ref<GalleryItem[]>([]);
const artIssue = ref<{ text: string; settings: boolean } | null>(null);
const drawingNow = computed(() => gallery.isDrawing(her.value.id, 'meal'));
const drawingText = computed(() => {
  const d = drawingNow.value;
  if (!d) return null;
  const what = MOMENTS[d.moment] ?? '画面';
  return d.stage === 'queued' ? `${what}：排队等前一张画完` : d.stage === 'prompt' ? `${what}：正在写 tags` : `${what}：正在画`;
});
function placeArt(item: GalleryItem) {
  if (shapeOf(item) === 'portrait') tableArt.value = item;
  else sideArt.value = item;
}
function herSideLine(): string {
  const s = herSlot.value;
  return `${her.value.name}在${herPlace.value || '自己那边'}${s ? `，${s.status}` : ''}${herMeal.value ? `，在吃${herMeal.value}` : ''}`;
}
function myFood(): string {
  return food.value.trim() || seen.value?.food || (planned.value && planMeal.value ? planMeal.value.name : '');
}
function captionFor(m: Moment, extra?: string): string {
  const mine = myFood();
  if (m === 'table') {
    return [`${userName.value}和${her.value.name}坐在同一张桌子两边一起吃${label.value}`, herMeal.value ? `${her.value.name}吃的是${herMeal.value}` : '', mine ? `${userName.value}吃的是${mine}` : '', herPlace.value ? `在${herPlace.value}` : '', extra]
      .filter(Boolean)
      .join('；');
  }
  const where = how.value === 'together' ? `两个人坐在同一张桌子两边吃${label.value}${herMeal.value ? `，${her.value.name}吃的是${herMeal.value}` : ''}` : herSideLine();
  if (m === 'side') return [where, `${userName.value}在${yourPlace.value || '自己那边'}吃${label.value}，${her.value.name}隔着屏幕陪着（${userName.value}不在画面里）`, extra].filter(Boolean).join('；');
  return [`${her.value.name}举起手边的杯子和${userName.value}碰杯（第 ${cheers.value} 次）`, where, extra].filter(Boolean).join('；');
}
function cardImage(i: GalleryItem) {
  return { assetKey: i.assetKey, ...(i.url ? { url: i.url } : {}), title: i.title, moment: i.moment };
}
/** 吃完后才画好的（碰杯画得慢）：放进刚发的饭卡 */
let cardRef: { chatId: string; messageId: string } | null = null;
let autoNoted = false;
async function drawMoment(m: Moment, priority: 'user' | 'auto', extra?: string): Promise<void> {
  if (priority === 'auto') {
    const chk = gallery.autoCheck();
    if (!chk.ok) {
      if (!autoNoted) artIssue.value = { text: chk.reason === '自动画关着' ? `自动画关着，画面先用立绘` : `画面先用立绘：${chk.reason}`, settings: /没接通|API 设置/.test(chk.reason) };
      autoNoted = true;
      return;
    }
  }
  const r = await gallery.draw({
    characterId: her.value.id,
    sceneId: 'meal',
    moment: m,
    caption: captionFor(m, extra),
    priority,
    locationId: herLocId.value,
    expression: chars.expression[her.value.id],
    recent: chatId.value ? chat.recentLines(chatId.value, 4) : [],
    size: m === 'table' || (m === 'cheers' && how.value === 'together') ? 'portrait' : halfShape.value,
  });
  if (!r.ok) {
    if (!r.busy) artIssue.value = { text: `没画出来：${r.reason}`, settings: /没接通/.test(r.reason) };
    return;
  }
  artIssue.value = null;
  placeArt(r.item);
  sessionArt.value.push(r.item);
  if (cardRef) {
    const { chatId: cid, messageId } = cardRef;
    const part = chat.list(cid).find((x) => x.id === messageId)?.parts.find((p) => p.type === 'meal');
    if (part?.type === 'meal') part.images = [...(part.images ?? []), cardImage(r.item)];
  }
}
/** 开饭时：这种画面今天同一个地方、同一身衣服、同一顿饭画过的直接用，没有就画一张 */
function ensureArt() {
  const m: Moment = how.value === 'together' ? 'table' : 'side';
  const size: ImageShape = m === 'table' ? 'portrait' : halfShape.value;
  const have = m === 'table' ? tableArt.value : sideArt.value;
  if (have && shapeOf(have) === size && have.caption.includes(label.value)) return;
  const outfit = rhythm.outfitFor(her.value.id, 'meal')?.name ?? null;
  const status = herSlot.value?.status ?? '';
  const found = gallery
    .find(her.value.id, 'meal', { moment: m, today: true, locationId: herLocId.value, outfit, size })
    .find((i) => i.caption.includes(label.value) && (m === 'table' || !status || i.caption.includes(status)));
  if (found) placeArt(found);
  else void drawMoment(m, 'auto');
}
function retryArt() {
  artIssue.value = null;
  void drawMoment(how.value === 'together' ? 'table' : 'side', 'user');
}
function toggleAutoDraw() {
  gallery.autoDraw = !gallery.autoDraw;
  showToast(gallery.autoDraw ? '自动画图开了：开饭时画一张' : '自动画图关了：碰杯、点"画一张"时才画');
  if (gallery.autoDraw && (phase.value === 'prep' || phase.value === 'eat') && !drawingNow.value) {
    autoNoted = false;
    artIssue.value = null;
    ensureArt();
  }
}
async function preview(item: { assetKey: string | null; url?: string } | null) {
  if (!item) return;
  const url = item.assetKey ? await assetUrl(item.assetKey) : (item.url ?? null);
  if (url) showImagePreview({ images: [url], closeable: true, showIndex: false });
  else showToast('本机找不到这张图了');
}
async function previewSession(start: number) {
  const urls = await Promise.all(sessionArt.value.map(async (i) => (i.assetKey ? await assetUrl(i.assetKey) : (i.url ?? null))));
  const images = urls.filter((u): u is string => !!u);
  if (images.length) showImagePreview({ images, startPosition: Math.min(start, images.length - 1), closeable: true });
  else showToast('本机找不到这几张图了');
}

// —— 她说的话：都来自「陪伴 · 快速」，存进聊天 ——
const herLine = ref('');
const notConnected = ref('');
const stream = computed(() => (chatId.value ? chat.streams[chatId.value] : undefined));
const streamingText = computed(() => (stream.value ? (chat.list(chatId.value).find((m) => m.id === stream.value!.messageId)?.text ?? '') : ''));
const shownLine = computed(() => streamingText.value || herLine.value);
const chatLink = computed(() => `/chat/${chatId.value}?mode=stage`);
const cue = computed(() => {
  if (phase.value === 'setup') return '开饭前';
  if (phase.value === 'done') return '吃完';
  if (phase.value === 'prep') return way.value === 'cook' ? '做饭中' : way.value === 'buy' ? '去买饭' : '热便当';
  return `${label.value}中`;
});

function planLine(m: PlanMeal): string {
  if (m.cook) {
    return `按健康计划自己做：${m.name}（约 ${m.minutes} 分钟）；食材：${m.ingredients.join('、') || '没写'}；做法：${m.steps.map((x, i) => `${i + 1}. ${x}`).join(' ') || '没写'}`;
  }
  if (m.bento) return `按健康计划吃带的便当：${m.name}${m.prep ? `；${m.prep}` : ''}`;
  const place = m.spot?.name || m.place;
  const far = typeof m.spot?.distanceKm === 'number' ? `（${distanceText(m.spot.distanceKm)}）` : '';
  return `按健康计划去买：${m.name}${place ? `，去${place}${far}` : ''}${m.order?.length ? `，点${m.order.join('、')}` : ''}${m.note ? `；${m.note}` : ''}`;
}
/** 这一次的场景任务里都带的：哪顿、怎么吃、她吃什么、你吃什么 */
function contextLines(): string[] {
  const s = herSlot.value;
  const lines = [`这一顿：${userName.value}的${label.value}`];
  if (how.value === 'together') {
    lines.push(
      together.value === 'bring'
        ? `共同吃饭：${her.value.name}来${herPlace.value || userName.value + '这边'}陪${userName.value}吃，坐在${userName.value}对面`
        : `共同吃饭：${her.value.name}作息里正好在${s?.status ?? '吃饭'}（在${herPlace.value}），你们像坐在同一张桌子两边一起吃`,
    );
  } else {
    lines.push(`各吃各的：${her.value.name}在${herPlace.value || '自己那边'}${s ? `，${s.status}` : ''}；${userName.value}在${yourPlace.value || '自己那边'}吃饭，你隔着屏幕陪着`);
  }
  if (herMeal.value) lines.push(`${her.value.name}这顿吃：${herMeal.value}`);
  if (planned.value && planMeal.value) lines.push(planLine(planMeal.value));
  else if (how.value === 'together') lines.push('随便吃点（没照计划）');
  const mine = food.value.trim();
  if (mine) lines.push(`${userName.value}这顿吃的：${mine}`);
  if (seen.value) lines.push(`${userName.value}拍的饭照（识图看到的）：${seen.value.desc}`);
  return lines;
}

async function reply(task: string, lines: string[], userText?: string): Promise<void> {
  if (!chatId.value) return;
  // 碰杯、拍照这些是你刚做的事：她上一句还没说完就换成回这个
  if (!userText && chat.streams[chatId.value]) chat.stop(chatId.value);
  const r = await chat.sceneReply(chatId.value, { task, input: lines.filter(Boolean).join('\n'), userText, cue: cue.value, quick: true });
  if (!r.ok) {
    if (r.notConnected) notConnected.value = r.reason;
    else if (!/还在回上一句/.test(r.reason)) showToast(r.reason);
    return;
  }
  notConnected.value = '';
  herLine.value = r.message.text;
}

// —— 你这顿吃的：写一句，或者拍一张 / 从相册选，识图认出是什么 ——
const food = ref('');
/** 你自己改过"吃的什么"：识图认出来的不再覆盖 */
let foodTouched = false;
const photo = ref<string | null>(null);
const looking = ref(false);
const seen = ref<{ food: string; desc: string } | null>(null);
const lookIssue = ref<{ text: string; settings: boolean } | null>(null);
const cameraOpen = ref(false);
const cameraInput = ref<HTMLInputElement | null>(null);
const albumInput = ref<HTMLInputElement | null>(null);
function openCamera() {
  if (cameraSupported()) cameraOpen.value = true;
  else cameraInput.value?.click();
}
function onPickedFile(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  cameraOpen.value = false;
  if (file) void addPhoto(file);
}
/** 识图看饭照的说明：在"一起吃饭"功能预设里（导入、复制的预设没有这一块时用自带预设文件里的） */
function lookInstruction(): string {
  const own = lib.presetForUse('scene:meal', her.value)?.blocks.find((b) => b.identifier === 'mealLook')?.content.trim();
  const text = own || seedBlockContent('mealLook');
  if (!text) throw new Error('"一起吃饭"预设里没有"识图看饭照"这一块');
  return text;
}
/** 识图按 JSON 写了菜名和看到的内容；没按格式写时整段当描述、第一句当菜名 */
function parseLook(text: string): { food: string; desc: string } {
  const v = parseJsonLoose(text);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const f = typeof o.food === 'string' ? o.food.trim().slice(0, 20) : '';
    const d = typeof o.desc === 'string' ? o.desc.trim() : '';
    if (f || d) return { food: f, desc: d || f };
  }
  const t = text.trim();
  return { food: (t.split(/[，。,.;；\n]/)[0] ?? '').trim().slice(0, 16), desc: t };
}
async function addPhoto(file: Blob) {
  if (!chatId.value || looking.value) return;
  let key: string;
  try {
    const { bytes, mime } = await compressPhoto(file);
    key = await putAsset(bytes, mime);
  } catch {
    showToast('这张图读不出来，换一张试试');
    return;
  }
  photo.value = key;
  seen.value = null;
  lookIssue.value = null;
  let model = '';
  const st = ai.status('vision');
  if (!st.live) lookIssue.value = { text: `识图还没接通：${st.reason}`, settings: true };
  else {
    looking.value = true;
    try {
      const r = await lookWith(key, lookInstruction());
      seen.value = parseLook(r.text);
      model = r.model;
      if (seen.value.food && (!food.value.trim() || (!foodTouched && !planned.value))) food.value = seen.value.food;
    } catch (e) {
      lookIssue.value = { text: `识图没看成：${errorText(e)}`, settings: false };
    } finally {
      looking.value = false;
    }
  }
  // 照片发进聊天，识图看到的跟着照片（之后的每一轮、总结都知道）；没看成也发，她知道你发了照片但看不清
  chat.push(
    chatId.value,
    'user',
    [{ type: 'image', assetKey: key, caption: '', generated: true, photo: true, ...(seen.value ? { seen: seen.value.desc, seenModel: model } : { seenError: lookIssue.value?.text ?? '识图没看成' }) }],
    { meta: { scene: 'meal', cue: cue.value } },
  );
  chars.setExpression(her.value.id, 'surprised');
  await reply('meal-food', [...contextLines(), seen.value ? '' : `${userName.value}发来一张饭照，但识图没看成（${lookIssue.value?.text ?? ''}），你看不清照片里是什么`]);
}
/** 只写了字：告诉她（你写的那句进聊天） */
async function tellFood() {
  const t = food.value.trim();
  if (!t) {
    showToast('先写这顿吃的什么');
    return;
  }
  if (stream.value) return;
  await reply('meal-food', contextLines(), t);
}

// —— 碰杯：画一张她举杯朝你伸过来的样子，她也回一句 ——
const cheers = ref(0);
async function clink() {
  cheers.value += 1;
  services.native.vibrate(20);
  chars.setExpression(her.value.id, 'laugh');
  if (drawingNow.value?.priority !== 'user') void drawMoment('cheers', 'user');
  await reply('meal-cheers', [...contextLines(), `${userName.value}举杯和${her.value.name}碰了一下（这是第 ${cheers.value} 次）`]);
}

// —— 边吃边聊 ——
const chatText = ref('');
async function sendChat() {
  const t = chatText.value.trim();
  if (!t || stream.value) return;
  chatText.value = '';
  await reply('meal-chat', [...contextLines(), phase.value === 'prep' ? `${userName.value}还在准备（${cue.value}）` : ''], t);
}

// —— 按计划：准备（自己做一步一步、去买告诉去哪点什么、便当怎么热） ——
const prepStartedAt = ref(0);
const stepsDone = ref<boolean[]>([]);
const curStep = computed(() => stepsDone.value.findIndex((d) => !d));
const prepSec = computed(() => (prepStartedAt.value ? Math.max(0, Math.floor((now.value - prepStartedAt.value) / 1000)) : 0));
const placeName = computed(() => planMeal.value?.spot?.name || planMeal.value?.place || '');
function toggleStep(i: number) {
  stepsDone.value[i] = !stepsDone.value[i];
  if (stepsDone.value[i]) services.native.vibrate(10);
}
let prepMinutes = 0;
async function ready() {
  if (phase.value !== 'prep') return;
  prepMinutes = Math.max(1, Math.round(prepSec.value / 60));
  phase.value = 'eat';
  chars.setExpression(her.value.id, 'laugh');
  const done = stepsDone.value.filter(Boolean).length;
  await reply('meal-ready', [
    ...contextLines(),
    `${userName.value}${WAY_LABEL[way.value].done}，花了 ${prepMinutes} 分钟${way.value === 'cook' && stepsDone.value.length ? `（做法勾了 ${done} / ${stepsDone.value.length} 步）` : ''}`,
  ]);
}

/** 准备到一半不照计划了：这一顿改成随便吃点，直接开吃 */
async function skipPlan() {
  if (phase.value !== 'prep') return;
  offPlan.value = true;
  if (!foodTouched) food.value = '';
  phase.value = 'eat';
  await reply('meal-start', [...contextLines(), `${userName.value}本来要按计划${WAY_SHORT[way.value]}，现在说不照计划了，随便吃点`]);
}

// —— 开饭、吃完 ——
/** 这次进来记了哪几顿（离开时那一段写"吃了……"） */
const visitMeals = ref<string[]>([]);
async function begin() {
  if (!canBegin.value) return;
  if (how.value === 'together' && !canTogether.value) how.value = 'solo';
  offPlan.value = false;
  pickedSlot.value = slot.value;
  food.value = planned.value && planMeal.value ? planMeal.value.name : '';
  foodTouched = false;
  photo.value = null;
  seen.value = null;
  lookIssue.value = null;
  cheers.value = 0;
  herLine.value = '';
  sessionArt.value = [];
  cardRef = null;
  ensureArt();
  if (planned.value && planMeal.value) {
    stepsDone.value = planMeal.value.steps.map(() => false);
    prepStartedAt.value = Date.now();
    prepMinutes = 0;
    phase.value = 'prep';
    chars.setExpression(her.value.id, 'smile');
    await reply('meal-prep', contextLines());
  } else {
    phase.value = 'eat';
    chars.setExpression(her.value.id, 'smile');
    await reply('meal-start', contextLines());
  }
}
async function finish() {
  if (!chatId.value || phase.value !== 'eat') return;
  const f = myFood();
  if (!f) {
    showToast('先写一句这顿吃了什么，或者拍一张');
    return;
  }
  try {
    await showConfirmDialog({ title: `${label.value}吃完了？`, message: `记下来：${f}`, confirmButtonText: '吃完了', cancelButtonText: '还在吃' });
  } catch {
    return;
  }
  food.value = f;
  phase.value = 'done';
  const part: MessagePart = {
    type: 'meal',
    logId: uid('meal'),
    meal: slot.value,
    food: f,
    photo: photo.value,
    how: how.value,
    ...(how.value === 'together' ? { mode: mode.value } : {}),
    ...(planned.value && planMeal.value ? { plan: { name: planMeal.value.name, way: way.value } } : {}),
    ...(herMeal.value ? { herMeal: herMeal.value } : {}),
    ...(cheers.value ? { cheers: cheers.value } : {}),
    ...(sessionArt.value.length ? { images: sessionArt.value.map(cardImage) } : {}),
  };
  const msg = chat.postCard(chatId.value, 'user', part);
  cardRef = { chatId: chatId.value, messageId: msg.id };
  visitMeals.value.push(`${label.value}（${f}）`);
  herLine.value = '';
  chars.setExpression(her.value.id, 'smile');
  await reply('meal-end', [
    ...contextLines(),
    prepMinutes ? `准备（${WAY_SHORT[way.value]}）花了 ${prepMinutes} 分钟` : '',
    cheers.value ? `一共碰了 ${cheers.value} 次杯` : '',
    photo.value ? `${userName.value}拍了饭照` : '',
  ]);
}
function again() {
  phase.value = 'setup';
  offPlan.value = false;
  pickedSlot.value = null;
  prepMinutes = 0;
  food.value = '';
  photo.value = null;
  seen.value = null;
  lookIssue.value = null;
  cheers.value = 0;
  herLine.value = '';
  sessionArt.value = [];
  cardRef = null;
  how.value = canTogether.value ? 'together' : 'solo';
}
const doneArt = computed(() => sessionArt.value.at(-1) ?? null);
const howText = computed(() => {
  if (how.value === 'solo') return '各吃各的';
  return planned.value && planMeal.value ? `共同吃饭 · 按计划${WAY_SHORT[way.value]}` : '共同吃饭 · 随便吃点';
});

let ticker: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  window.addEventListener('resize', onResize);
  ticker = setInterval(() => (now.value = Date.now()), 1000);
  chat.setLeaveSummary(her.value.id, () => (visitMeals.value.length ? `吃了${visitMeals.value.join('、')}` : undefined));
  if (how.value === 'together' && mode.value === 'plan' && hs.value && !plan.value && healthStatus.value.live && !planBusy.value) void makePlan();
});
onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize);
  clearInterval(ticker);
  chat.setLeaveSummary(her.value.id, null);
});

/** 立绘放哪：分屏时在上半屏；共同吃饭没图时坐在下面（像隔着桌子坐你对面）；各吃各的没图时在上半屏右边 */
const figureLayout = computed(() => {
  if (view.value === 'split') return { left: 50, bottom: 50, height: 46 };
  if (view.value === 'together') return { left: 50, bottom: 24, height: 62 };
  return { left: 72, bottom: 50, height: 40 };
});
const figureHidden = computed(() => {
  if (view.value === 'together') return !!tableArt.value;
  if (view.value === 'solo') return !!sideArt.value;
  return phase.value === 'done' && !!doneArt.value;
});
</script>

<template>
  <SceneShell scene-id="meal" bare :pose="phase === 'eat' ? 'eat' : 'sit'" :layout="figureLayout" :hide-figure="figureHidden" :drawing="drawingText">
    <template #actions>
      <button
        type="button"
        class="pill-btn"
        :class="{ off: !gallery.autoDraw }"
        :aria-pressed="gallery.autoDraw"
        :aria-label="gallery.autoDraw ? '自动画图：开（点一下关掉）' : '自动画图：关（点一下打开）'"
        @click="toggleAutoDraw"
      >
        <span :class="gallery.autoDraw ? 'i-lucide-image' : 'i-lucide-image-off'" />
      </button>
    </template>

    <template #overlay>
      <div class="meal" :class="`v-${view}`" :data-view="view">
        <!-- ============ 开始前 / 吃完：上下各一半 ============ -->
        <template v-if="view === 'split'">
          <Transition name="fade">
            <button v-if="phase === 'done' && doneArt" :key="doneArt.id" type="button" class="half-art top" :aria-label="`看大图：${doneArt.title}`" @click="preview(doneArt)">
              <AssetImg :asset-key="doneArt.assetKey" :url="doneArt.url" :alt="doneArt.title" />
            </button>
          </Transition>

          <!-- 她那边：此刻在干什么、吃不吃饭 -->
          <div v-if="phase === 'setup'" class="plan" data-testid="her-side">
            <div class="flex items-center gap-2.5">
              <Avatar :character="her" :size="34" live />
              <div class="flex-1 min-w-0">
                <div class="text-[12px] text-ink-2 truncate">{{ her.pronoun }}那边{{ herPlace ? ` · ${herPlace}` : '' }}</div>
                <div class="text-[14.5px] leading-snug mt-0.5">
                  <template v-if="together === 'bring'">{{ her.pronoun }}来陪你吃饭了，坐在你对面</template>
                  <template v-else-if="herMealSlot">{{ her.pronoun }}正在{{ herSlot?.status }}<template v-if="herMeal"><span class="text-ink-2">：</span>{{ herMeal }}</template></template>
                  <template v-else-if="herSlot">{{ her.pronoun }}{{ doing(herSlot.status) }}，不在吃饭</template>
                  <template v-else>不知道{{ her.pronoun }}现在在干什么</template>
                </div>
              </div>
            </div>
            <div v-if="herSlot && together !== 'bring'" class="plan-slots">
              <span class="slot now"><span class="num">{{ herSlot.from }}–{{ herSlot.to }}</span>{{ herSlot.status }}</span>
              <span v-if="!herMealSlot && herNextMeal" class="slot"><span class="num">{{ herNextMeal.from }}</span>{{ herNextMeal.status }}</span>
            </div>
          </div>
          <div v-else-if="shownLine || stream" class="done-say">
            <StudyBubble side="her" :text="shownLine" :typing="!!stream && !streamingText" :to="chatLink" :label="`去和${her.name}聊天`" />
          </div>

          <section class="split-panel" :aria-label="phase === 'setup' ? '这顿怎么吃' : '吃完了'">
            <div class="split-scroll">
              <div v-if="notConnected" class="notice">
                <span class="i-lucide-plug-zap shrink-0" />
                <span class="flex-1 min-w-0">{{ notConnected }}</span>
                <button class="text-accent-ink shrink-0" @click="router.push('/me/api?feature=companion')">去设置</button>
              </div>

              <!-- 开始前 -->
              <template v-if="phase === 'setup'">
                <div class="label first">怎么吃</div>
                <Segmented v-model="how" :options="howOptions" data-testid="meal-how" />
                <p class="hint" data-testid="together-hint">{{ how === 'together' || !canTogether ? togetherHint : `上半屏画${her.pronoun}那边（${her.pronoun}在做自己的事），下半屏是你的饭；吃的时候写一句、拍一张，能碰杯` }}</p>

                <template v-if="how === 'together'">
                  <div class="label">怎么准备</div>
                  <Segmented v-model="mode" :options="MODE_OPTIONS" />
                  <template v-if="mode === 'plan'">
                    <div v-if="!hs" class="notice mt-2.5">
                      <span class="i-lucide-heart-pulse shrink-0" />
                      <span class="flex-1 min-w-0">健康系统没开，没有饮食计划可以照着吃：先在人设里打开，或者选"随便吃点"</span>
                      <button class="text-accent-ink shrink-0" @click="router.push(`/me/personas/${persona.id}/health`)">去打开</button>
                    </div>
                    <template v-else-if="planMeal">
                      <MealCard :key="slot" :meal="planMeal" :which="slot" open class="mt-2.5" data-testid="meal-plan" />
                      <p class="hint">
                        {{ way === 'cook' ? '开始后照着做法一步一步做，做好了再开吃' : way === 'buy' ? '开始后告诉你去哪、点什么，买到了再开吃' : '开始后提醒你怎么热，热好了再开吃' }}；吃的时候可以拍一张（不拍也行）
                      </p>
                    </template>
                    <div v-else-if="plan" class="notice mt-2.5">
                      <span class="i-lucide-calendar-x shrink-0" />
                      <span class="flex-1 min-w-0">今天的计划里没有{{ label }}，换一顿，或者选"随便吃点"</span>
                    </div>
                    <div v-else class="plan-box text-center">
                      <div class="text-[14px]">今天的饮食计划还没排</div>
                      <p v-if="!healthStatus.live" class="hint !text-center">「健康计划」还没接通：<RouterLink to="/me/api?feature=health" class="text-accent-ink">去设置</RouterLink></p>
                      <p v-else-if="planError" class="hint !text-center text-bad">{{ planError.reason }}</p>
                      <van-button
                        class="!mt-2"
                        size="small"
                        round
                        type="primary"
                        :loading="!!planBusy"
                        :loading-text="planBusy === 'week' ? '在排这周…' : '在排今天…'"
                        :disabled="!healthStatus.live"
                        data-testid="meal-make-plan"
                        @click="makePlan"
                      >
                        排今天的计划
                      </van-button>
                    </div>
                  </template>
                  <p v-else class="hint">吃的时候写一句吃了什么，或者拍一张、从相册选一张，识图会认出是什么</p>
                </template>

                <div class="label">哪一顿</div>
              </template>

              <!-- 吃完 -->
              <template v-else>
                <div class="flex gap-3 items-start">
                  <button v-if="photo" type="button" class="done-photo" aria-label="看大图：你的饭" @click="preview({ assetKey: photo })">
                    <AssetImg :asset-key="photo" alt="你的饭" />
                  </button>
                  <div class="flex-1 min-w-0">
                    <div class="text-[16px] font-700">{{ label }} · {{ food }}</div>
                    <div class="text-[12.5px] text-ink-3 mt-1">
                      {{ howText }}<template v-if="herMeal"> · {{ her.pronoun }}吃的{{ herMeal }}</template><template v-if="cheers"> · 碰了 {{ cheers }} 次杯</template>
                    </div>
                  </div>
                </div>
                <div v-if="sessionArt.length" class="shots" aria-label="这次画的图">
                  <button v-for="(i, n) in sessionArt" :key="i.id" type="button" class="shot" :aria-label="`看大图：${i.title}`" @click="previewSession(n)">
                    <AssetImg :asset-key="i.assetKey" :url="i.url" :alt="i.title" />
                  </button>
                </div>
                <div class="label">今天</div>
              </template>

              <!-- 今天的几顿：开始前点一下选这一顿 -->
              <div class="slots4" role="group" aria-label="今天的几顿">
                <button
                  v-for="s in SLOTS"
                  :key="s"
                  type="button"
                  class="mslot"
                  :class="{ on: phase === 'setup' && slot === s, done: !!eaten[s] }"
                  :disabled="phase !== 'setup'"
                  :aria-pressed="phase === 'setup' ? slot === s : undefined"
                  :data-slot="s"
                  @click="pickedSlot = s"
                >
                  <span class="flex items-center gap-1 text-[13px] font-600"><span :class="eaten[s] ? 'i-lucide-circle-check' : 'i-lucide-circle-dashed'" />{{ MEAL_LABEL[s] }}</span>
                  <span class="text-[12px] text-ink-2 truncate mt-0.5">{{ eaten[s]?.food ?? (phase === 'setup' && slot === s ? '这一顿' : '—') }}</span>
                  <span class="text-[11px] text-ink-3 num">{{ eaten[s]?.at ?? windowText(s) }}</span>
                </button>
              </div>

              <div class="stamps" aria-label="这周记过饭的日子">
                <div v-for="d in week" :key="d.key" class="stamp" :class="{ on: d.on }">
                  <span v-if="d.on" class="i-lucide-check" />
                  <span class="text-[11px]">{{ d.label }}</span>
                </div>
              </div>
              <div class="stats num">
                今天记了 {{ Object.keys(eaten).length }} 顿<template v-if="weekCount"> · 这周 {{ weekCount }} 顿</template> · 饭点在<RouterLink to="/me/environment" class="text-accent-ink">环境与作息</RouterLink>里改
              </div>
            </div>
            <div class="split-foot">
              <van-button v-if="phase === 'setup'" type="primary" round block data-testid="meal-begin" :disabled="!canBegin" @click="begin">
                {{ planned && planMeal ? WAY_LABEL[way].go : how === 'together' ? `一起吃${label}` : `开饭 · ${label}` }}
              </van-button>
              <div v-else class="flex gap-2.5">
                <van-button round block @click="again">再记一顿</van-button>
                <van-button type="primary" round block @click="router.push(`/chat/${chatId}`)">回聊天</van-button>
              </div>
            </div>
          </section>
        </template>

        <!-- ============ 准备 / 吃饭 ============ -->
        <template v-else>
          <!-- 画面层：共同吃饭整屏竖图；各吃各的上半屏她那边、下半屏你这边 -->
          <template v-if="view === 'together'">
            <Transition name="fade">
              <button v-if="tableArt" :key="tableArt.id" type="button" class="full-art" :aria-label="`看大图：${tableArt.title}`" @click="preview(tableArt)">
                <AssetImg :asset-key="tableArt.assetKey" :url="tableArt.url" :alt="tableArt.title" />
              </button>
            </Transition>
          </template>
          <template v-else>
            <Transition name="fade">
              <button v-if="sideArt" :key="sideArt.id" type="button" class="half-art top" :aria-label="`看大图：${sideArt.title}`" @click="preview(sideArt)">
                <AssetImg :asset-key="sideArt.assetKey" :url="sideArt.url" :alt="sideArt.title" />
              </button>
            </Transition>
            <div class="half bottom" data-testid="my-half">
              <button v-if="photo" type="button" class="my-photo" aria-label="看大图：你的饭" @click="preview({ assetKey: photo })">
                <AssetImg :asset-key="photo" alt="你的饭" />
              </button>
              <div v-else class="my-empty">
                <PersonaAvatar :persona="persona" :size="44" />
                <span class="text-[13px] text-ink-2 mt-2">你这边 · {{ yourPlace || '自己那边' }}</span>
                <button type="button" class="set" @click="openCamera"><span class="i-lucide-camera" />拍你的饭给{{ her.pronoun }}看</button>
              </div>
            </div>
            <div class="midline" aria-hidden="true" />
          </template>
          <div class="shade top" aria-hidden="true" />
          <div class="shade bottom" aria-hidden="true" />

          <!-- 左上：她在吃什么，下面是她说的话 -->
          <div class="her-col">
            <div class="her-card" data-testid="her-card">
              <div class="flex items-center gap-2">
                <Avatar :character="her" :size="24" live />
                <span class="flex-1 min-w-0 text-[12px] text-ink-2 truncate">{{ her.name }}{{ herPlace ? ` · ${herPlace}` : '' }}</span>
              </div>
              <div class="card-task">
                <template v-if="herMeal">在吃：{{ herMeal }}</template>
                <template v-else-if="herSlot">{{ herSlot.status }}，陪你吃</template>
                <template v-else>陪你吃饭</template>
              </div>
            </div>
            <StudyBubble v-if="shownLine || stream" side="her" :text="shownLine" :typing="!!stream && !streamingText" :to="chatLink" :label="`去和${her.name}聊天`" />
            <div v-if="notConnected" class="mini-notice">
              <span class="i-lucide-plug-zap shrink-0" /><span class="flex-1 min-w-0">{{ notConnected }}</span>
              <button class="text-accent-ink shrink-0" @click="router.push('/me/api?feature=companion')">去设置</button>
            </div>
            <div v-if="artIssue" class="mini-notice" data-testid="art-issue">
              <span class="i-lucide-image-off shrink-0" /><span class="flex-1 min-w-0">{{ artIssue.text }}</span>
              <button v-if="artIssue.settings" class="text-accent-ink shrink-0" @click="router.push('/me/api?feature=image')">去设置</button>
              <button v-else class="text-accent-ink shrink-0" :disabled="!!drawingNow" @click="retryArt">画一张</button>
            </div>
          </div>

          <!-- 按计划：准备（做饭 / 去买 / 热便当） -->
          <section v-if="phase === 'prep' && planMeal" class="guide" data-testid="meal-guide" :aria-label="WAY_LABEL[way].go">
            <div class="flex items-center gap-2">
              <span :class="WAY_LABEL[way].icon" class="text-accent-ink shrink-0" />
              <span class="flex-1 min-w-0 text-[15px] font-700 truncate">{{ planMeal.name }}</span>
              <span class="num text-[12px] text-ink-3 shrink-0">{{ clock(prepSec) }}<template v-if="planMeal.minutes"> / 约 {{ planMeal.minutes }} 分钟</template></span>
            </div>
            <div class="guide-scroll">
              <!-- 自己做：食材、一步一步 -->
              <template v-if="way === 'cook'">
                <div v-if="planMeal.ingredients.length" class="flex flex-wrap gap-1.5 mt-2">
                  <span v-for="(it, i) in planMeal.ingredients" :key="i" class="ing">{{ it }}</span>
                </div>
                <ol v-if="planMeal.steps.length" class="steps">
                  <li v-for="(s, i) in planMeal.steps" :key="i">
                    <button type="button" class="step" :class="{ done: stepsDone[i], cur: i === curStep }" :aria-pressed="!!stepsDone[i]" @click="toggleStep(i)">
                      <span class="no num">{{ stepsDone[i] ? '' : i + 1 }}<span v-if="stepsDone[i]" class="i-lucide-check" /></span>
                      <span class="flex-1 min-w-0 text-left">{{ s }}</span>
                    </button>
                  </li>
                </ol>
                <p v-else class="hint">计划里没写做法，照你习惯的做</p>
              </template>
              <!-- 去买：去哪家、点什么 -->
              <template v-else-if="way === 'buy'">
                <div v-if="placeName" class="spot mt-2">
                  <span class="i-lucide-map-pin text-accent-ink shrink-0" />
                  <span class="flex-1 min-w-0">
                    <span class="font-600">{{ placeName }}</span>
                    <span v-if="planMeal.spot?.type || typeof planMeal.spot?.distanceKm === 'number'" class="text-ink-3 num">
                      · {{ [planMeal.spot?.type, typeof planMeal.spot?.distanceKm === 'number' ? distanceText(planMeal.spot.distanceKm) : ''].filter(Boolean).join(' · ') }}
                    </span>
                    <span v-if="!planMeal.spot" class="block text-[12px] text-ink-3">附近搜到的店里没有这一家，去之前查一下</span>
                  </span>
                  <a v-if="planMeal.spot?.mapsUri" :href="planMeal.spot.mapsUri" target="_blank" rel="noopener noreferrer" class="text-accent-ink shrink-0">地图</a>
                </div>
                <div v-if="planMeal.order?.length" class="flex flex-wrap items-center gap-1.5 mt-2">
                  <span class="text-[12px] text-ink-3">点</span>
                  <span v-for="(it, i) in planMeal.order" :key="i" class="ing">{{ it }}</span>
                </div>
              </template>
              <!-- 带的便当：怎么热、没带成的备案 -->
              <template v-else>
                <p v-if="planMeal.prep" class="prep"><span class="i-lucide-package text-accent-ink shrink-0" /><span>{{ planMeal.prep }}</span></p>
                <p v-if="planMeal.backup" class="hint">没带成的话：{{ planMeal.backup }}</p>
              </template>
              <p v-if="planMeal.note" class="hint">{{ planMeal.note }}</p>
            </div>
            <div class="flex gap-2 mt-2.5">
              <button type="button" class="act" @click="skipPlan">不照计划了</button>
              <button type="button" class="act primary" data-testid="meal-ready" @click="ready"><span class="i-lucide-check" />{{ WAY_LABEL[way].ready }}</button>
            </div>
          </section>

          <!-- 吃饭：你这顿吃的、拍照、碰杯、吃完了 -->
          <section v-else class="dock" data-testid="meal-dock" aria-label="你这顿吃的">
            <div class="my-card">
              <div class="flex items-center gap-2">
                <button type="button" class="thumb" :aria-label="photo ? '看大图：你的饭' : '拍一张'" @click="photo ? preview({ assetKey: photo }) : openCamera()">
                  <AssetImg v-if="photo" :asset-key="photo" alt="你的饭" />
                  <span v-else class="i-lucide-camera text-[20px] text-ink-2" />
                </button>
                <form class="flex-1 min-w-0 flex gap-1.5" @submit.prevent="tellFood">
                  <input
                    v-model="food"
                    class="field"
                    :placeholder="planned ? '吃的什么（照计划的话不用改）' : '这顿吃的什么？'"
                    aria-label="这顿吃的什么"
                    enterkeyhint="send"
                    @input="foodTouched = true"
                  />
                  <button type="submit" class="tell" :disabled="!food.trim() || !!stream" :aria-label="`告诉${her.pronoun}`">告诉{{ her.pronoun }}</button>
                </form>
              </div>
              <div class="look-line" role="status">
                <template v-if="looking"><span class="i-lucide-loader-circle spin shrink-0" />识图在看你的饭…</template>
                <template v-else-if="seen"><span class="i-lucide-scan-eye shrink-0 text-accent-ink" /><span class="truncate">识图：{{ seen.food || seen.desc }}</span></template>
                <template v-else-if="lookIssue">
                  <span class="i-lucide-image-off shrink-0" /><span class="flex-1 min-w-0 truncate">{{ lookIssue.text }}</span>
                  <button v-if="lookIssue.settings" type="button" class="text-accent-ink shrink-0" @click="router.push('/me/api?feature=vision')">去设置</button>
                </template>
                <template v-else>写一句，或者拍一张 / 从相册选一张（识图认出是什么）<template v-if="planned">，不拍也行</template></template>
              </div>
              <div class="flex items-center gap-2 mt-2">
                <button type="button" class="chip" :disabled="looking" data-testid="meal-camera" @click="openCamera"><span class="i-lucide-camera" />拍照</button>
                <ImagePick class="chip" :class="{ 'pointer-events-none opacity-50': looking }" data-upload="meal-photo" @pick="addPhoto"><span class="i-lucide-image-plus" />相册</ImagePick>
                <span class="flex-1" />
                <button type="button" class="clink" aria-label="碰杯" data-testid="meal-clink" @click="clink">
                  <span class="i-lucide-cup-soda" />碰杯<span v-if="cheers" class="num"> ×{{ cheers }}</span>
                </button>
                <button type="button" class="chip primary" data-testid="meal-finish" @click="finish"><span class="i-lucide-check" />吃完了</button>
              </div>
            </div>
          </section>

          <nav class="bottom-bar" aria-label="边吃边聊">
            <form class="chat-form" @submit.prevent="sendChat">
              <input v-model="chatText" class="chat-input" :placeholder="phase === 'prep' ? `边${way === 'cook' ? '做' : '走'}边和${her.pronoun}说` : `边吃边和${her.pronoun}聊`" aria-label="边吃边聊" enterkeyhint="send" />
              <button type="submit" class="pill icon" :disabled="!!stream || !chatText.trim()" aria-label="发送"><span class="i-lucide-send" /></button>
            </form>
          </nav>
        </template>

        <input ref="cameraInput" type="file" accept="image/*" capture="environment" class="file-hidden" aria-hidden="true" tabindex="-1" @change="onPickedFile" />
        <input ref="albumInput" type="file" accept="image/*" class="file-hidden" aria-hidden="true" tabindex="-1" @change="onPickedFile" />
        <CameraSheet v-model:show="cameraOpen" @shot="addPhoto" @system-camera="cameraInput?.click()" @album="albumInput?.click()" />
      </div>
    </template>
  </SceneShell>
</template>

<style scoped>
.meal {
  position: absolute;
  inset: 0;
  z-index: 6;
  pointer-events: none;
}
.meal > * {
  pointer-events: auto;
}
.meal > .shade,
.meal > .midline {
  pointer-events: none;
}
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.6s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
.file-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}

/* —— 画面层 —— */
.full-art,
.half-art {
  position: absolute;
  left: 0;
  right: 0;
  display: block;
  padding: 0;
  border: 0;
  background: #000;
  cursor: zoom-in;
  overflow: hidden;
}
.full-art {
  top: 0;
  bottom: 0;
}
.half-art.top {
  top: 0;
  height: 50%;
}
.full-art :deep(.asset-img) {
  object-position: 50% 30%;
}
.half-art :deep(.asset-img) {
  object-position: 50% 35%;
}
.half.bottom {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 50%;
  overflow: hidden;
  background:
    radial-gradient(120% 80% at 50% 100%, var(--accent-soft), transparent 70%),
    linear-gradient(180deg, var(--bg-2), var(--surface));
}
.my-photo {
  position: absolute;
  inset: 0;
  display: block;
  width: 100%;
  padding: 0;
  border: 0;
  cursor: zoom-in;
}
.my-empty {
  position: absolute;
  left: 0;
  right: 0;
  top: 18px;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.set {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 30px;
  margin-top: 8px;
  padding: 0 12px;
  border-radius: 99px;
  background: var(--accent-soft);
  border: 1px solid var(--accent-line);
  color: var(--accent-ink);
  font-size: 12.5px;
}
.midline {
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  height: 2px;
  margin-top: -1px;
  background: rgba(255, 255, 255, 0.85);
  box-shadow:
    0 0 0 1px rgba(0, 0, 0, 0.1),
    0 0 8px rgba(0, 0, 0, 0.22);
}
.shade {
  position: absolute;
  left: 0;
  right: 0;
  pointer-events: none;
}
.shade.top {
  top: 0;
  height: 150px;
  background: linear-gradient(to bottom, rgba(0, 0, 0, 0.28), transparent);
}
.shade.bottom {
  bottom: 0;
  height: 220px;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.32), transparent);
}

/* —— 开始前 / 吃完：上下各一半 —— */
.plan,
.done-say {
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: calc(50% + 12px);
}
.plan {
  padding: 12px 14px;
  border-radius: 18px;
  background: var(--glass);
  border: 1px solid var(--glass-line);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  box-shadow: var(--shadow-sm);
}
.plan-slots {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 9px;
}
.slot {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  height: 24px;
  padding: 0 9px;
  border-radius: 99px;
  background: var(--glass-line);
  font-size: 12px;
  color: var(--ink-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.slot.now {
  background: var(--accent-soft);
  color: var(--accent-ink);
}
.slot .num {
  font-size: 11.5px;
  opacity: 0.85;
}
.done-say :deep(.bubble) {
  max-height: min(9.6em, calc(50vh - 120px));
}
.split-panel {
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  bottom: 0;
  display: flex;
  flex-direction: column;
  border-radius: 26px 26px 0 0;
  background: var(--glass-strong);
  border-top: 1px solid var(--glass-line);
  backdrop-filter: blur(22px);
  -webkit-backdrop-filter: blur(22px);
}
.split-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 14px 16px 12px;
}
.split-foot {
  flex: none;
  padding: 10px 16px calc(var(--safe-bottom) + 12px);
  border-top: 1px solid var(--glass-line);
}
.label {
  margin: 14px 0 7px;
  font-size: 12.5px;
  color: var(--ink-3);
}
.label.first {
  margin-top: 2px;
}
.hint {
  margin: 7px 2px 0;
  font-size: 12px;
  line-height: 1.55;
  color: var(--ink-3);
}
.notice {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  padding: 8px 12px;
  border-radius: 12px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 12.5px;
}
.plan-box {
  margin-top: 10px;
  padding: 12px;
  border-radius: 16px;
  background: var(--panel);
}
.slots4 {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 6px;
}
.mslot {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  min-width: 0;
  padding: 8px 9px;
  border-radius: 14px;
  background: var(--panel);
  color: var(--ink-3);
  text-align: left;
}
.mslot > span {
  max-width: 100%;
}
.mslot.done {
  color: var(--good);
}
.mslot.on {
  outline: 1.5px solid var(--accent-line);
  color: var(--accent-ink);
}
.mslot:disabled {
  cursor: default;
}
.done-photo {
  flex-shrink: 0;
  width: 64px;
  height: 64px;
  border-radius: 14px;
  overflow: hidden;
  background: var(--panel);
  cursor: zoom-in;
}
.shots {
  display: flex;
  gap: 8px;
  margin-top: 10px;
  overflow-x: auto;
}
.shot {
  flex-shrink: 0;
  width: 64px;
  height: 86px;
  border-radius: 12px;
  overflow: hidden;
  background: var(--panel);
}
.stamps {
  display: flex;
  justify-content: space-between;
  gap: 4px;
  margin-top: 16px;
}
.stamp {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 6px 0;
  border-radius: 10px;
  background: var(--panel);
  color: var(--ink-3);
  font-size: 13px;
}
.stamp.on {
  background: var(--accent-soft);
  color: var(--accent-ink);
}
.stats {
  margin-top: 10px;
  font-size: 12.5px;
  color: var(--ink-3);
  text-align: center;
}

/* —— 准备 / 吃饭：左上她 —— */
.her-col {
  position: absolute;
  top: calc(var(--safe-top) + 58px);
  left: 12px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  width: min(66%, 280px);
}
.v-together .her-col :deep(.bubble) {
  max-height: max(4.8em, min(9.6em, calc(100vh - var(--safe-top) - var(--safe-bottom) - 420px)));
}
.v-solo .her-col :deep(.bubble) {
  max-height: max(3.2em, min(8em, calc(50vh - 190px)));
}
.her-card {
  display: block;
  width: 100%;
  padding: 9px 12px 10px;
  border-radius: 16px;
  background: var(--veil);
  border: 1px solid var(--glass-line);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  box-shadow: var(--shadow-sm);
}
.card-task {
  display: -webkit-box;
  margin-top: 4px;
  font-size: 13.5px;
  line-height: 1.45;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.mini-notice {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 10px;
  border-radius: 12px;
  background: var(--glass);
  border: 1px solid var(--glass-line);
  color: var(--ink-2);
  font-size: 12px;
  line-height: 1.4;
}

/* —— 按计划：准备 —— */
.guide,
.dock {
  position: absolute;
  left: 10px;
  right: 10px;
  bottom: calc(var(--safe-bottom) + 58px);
}
.guide {
  display: flex;
  flex-direction: column;
  max-height: min(56vh, calc(100vh - var(--safe-top) - 250px));
  padding: 12px 14px;
  border-radius: 20px;
  background: var(--glass-strong);
  border: 1px solid var(--glass-line);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  box-shadow: var(--shadow);
}
.guide-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  font-size: 13.5px;
  line-height: 1.6;
  color: var(--ink-2);
}
.ing {
  display: inline-flex;
  align-items: center;
  height: 24px;
  padding: 0 9px;
  border-radius: 99px;
  background: var(--panel);
  font-size: 12px;
}
.steps {
  margin: 10px 0 0;
  padding: 0;
  list-style: none;
}
.steps li + li {
  margin-top: 6px;
}
.step {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  width: 100%;
  padding: 7px 10px;
  border-radius: 12px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 13.5px;
  line-height: 1.55;
}
.step.cur {
  background: var(--accent-soft);
  color: var(--ink);
  outline: 1px solid var(--accent-line);
}
.step.done {
  color: var(--ink-3);
  text-decoration: line-through;
}
.step .no {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  margin-top: 1px;
  border-radius: 50%;
  background: var(--surface);
  font-size: 11.5px;
  text-decoration: none;
}
.step.done .no {
  background: var(--good);
  color: #fff;
}
.spot {
  display: flex;
  align-items: flex-start;
  gap: 6px;
}
.spot > span:first-child {
  margin-top: 4px;
}
.prep {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 8px 0 0;
  padding: 7px 10px;
  border-radius: 12px;
  background: var(--accent-soft);
}
.prep > span:first-child {
  margin-top: 4px;
}
.act {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 38px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 13.5px;
}
.act.primary {
  flex: 2;
  background: var(--accent);
  color: var(--on-accent);
  font-weight: 600;
}

/* —— 吃饭：你这顿吃的 —— */
.my-card {
  padding: 10px 12px;
  border-radius: 20px;
  background: var(--glass-strong);
  border: 1px solid var(--glass-line);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  box-shadow: var(--shadow);
}
.thumb {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 44px;
  height: 44px;
  border-radius: 12px;
  overflow: hidden;
  background: var(--panel);
  border: 1px dashed var(--border);
}
.field {
  flex: 1;
  min-width: 0;
  height: 38px;
  padding: 0 12px;
  border-radius: 19px;
  border: 1px solid var(--border);
  background: var(--panel);
  outline: none;
  font-size: 14px;
}
.tell {
  flex-shrink: 0;
  height: 38px;
  padding: 0 12px;
  border-radius: 19px;
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: 13px;
}
.tell:disabled {
  opacity: 0.5;
}
.look-line {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 20px;
  margin-top: 6px;
  font-size: 12px;
  color: var(--ink-3);
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 32px;
  padding: 0 11px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 13px;
  white-space: nowrap;
  flex-shrink: 0;
}
.chip.primary {
  background: var(--accent);
  color: var(--on-accent);
  font-weight: 600;
}
.chip:disabled {
  opacity: 0.5;
}
.clink {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 32px;
  padding: 0 11px;
  border-radius: 99px;
  background: var(--accent-soft);
  border: 1px solid var(--accent-line);
  color: var(--accent-ink);
  font-size: 13px;
  white-space: nowrap;
  flex-shrink: 0;
}
.clink:active {
  transform: scale(0.94);
}

/* —— 最下面：边吃边聊 —— */
.bottom-bar {
  position: absolute;
  left: 10px;
  right: 10px;
  bottom: calc(var(--safe-bottom) + 10px);
  display: flex;
  align-items: center;
  gap: 6px;
}
.pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  min-width: 38px;
  height: 38px;
  padding: 0 12px;
  border-radius: 99px;
  background: var(--glass);
  border: 1px solid var(--glass-line);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  color: var(--ink);
  font-size: 13.5px;
  white-space: nowrap;
  flex-shrink: 0;
}
.pill.icon {
  padding: 0;
}
.pill:disabled {
  opacity: 0.6;
}
.chat-form {
  flex: 1;
  min-width: 0;
  display: flex;
  gap: 6px;
}
.chat-input {
  flex: 1;
  min-width: 0;
  height: 38px;
  padding: 0 14px;
  border-radius: 99px;
  border: 1px solid var(--glass-line);
  background: var(--glass-strong);
  outline: none;
  font-size: 14px;
}
.spin {
  animation: spin 1s linear infinite;
}

/* —— 顶栏右边的自动画开关 —— */
.pill-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 38px;
  height: 38px;
  border-radius: 99px;
  background: var(--glass);
  border: 1px solid var(--glass-line);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  color: var(--accent-ink);
  font-size: 16px;
}
.pill-btn.off {
  color: var(--ink-3);
}
</style>
