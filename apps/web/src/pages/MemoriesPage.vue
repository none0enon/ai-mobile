<script setup lang="ts">
import { isAbortError } from '@app/ai';
import type { Memory, MemoryType } from '@app/shared';
import { closeToast, showConfirmDialog, showLoadingToast, showToast } from 'vant';
import { computed, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Avatar from '@/components/common/Avatar.vue';
import HScroll from '@/components/common/HScroll.vue';
import Segmented from '@/components/common/Segmented.vue';
import CgArt from '@/components/figure/CgArt.vue';
import { album, diaries, MEMORY_TYPE_META, timeline, type AlbumItem } from '@/mock/memories';
import { services } from '@/services';
import { consolidateNow } from '@/services/consolidate';
import { backfillChat, pendingForSummary } from '@/services/summary';
import { useAiStore } from '@/stores/ai';
import { useAppStore } from '@/stores/app';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';
import { memKey, useMemoryStore } from '@/stores/memory';
import { useMessageSettingsStore } from '@/stores/messageSettings';
import { showErrorDialog } from '@/utils/errors';
import { daysBetween, monthDay } from '@/utils/time';

type Tab = 'timeline' | 'diary' | 'album' | 'book';
const route = useRoute();
const router = useRouter();
const app = useAppStore();
const chars = useCharacterStore();
const chats = useChatStore();
const mem = useMemoryStore();
const ai = useAiStore();
const msgSettings = useMessageSettingsStore();
/**
 * 回忆按人分：上面一排头像切换看谁的回忆（?char=），默认是当前陪着你的角色。
 * 换人时点缀色也跟着换（App.vue 读 ?char）。
 */
const character = computed(() => chars.byId(route.query.char as string | undefined) ?? chars.byId(app.activeCharacterId) ?? chars.list[0]!);
function pick(id: string) {
  void router.replace({ query: { ...route.query, char: id } });
}
const chat = computed(() => chats.chatOfCharacter(character.value.id));
const myDiaries = computed(() => diaries.filter((d) => d.characterId === character.value.id));
const myAlbum = computed(() => album.filter((a) => a.characterId === character.value.id));
const rel = computed(() => character.value.relationship);
const metDays = computed(() => daysBetween(rel.value.metAt, Date.now()));

const tab = ref<Tab>((['timeline', 'diary', 'album', 'book'] as Tab[]).includes(route.query.tab as Tab) ? (route.query.tab as Tab) : 'timeline');
watch(tab, (t) => void router.replace({ query: { ...route.query, tab: t } }));
// 已经在回忆页时从别处跳到"记忆本"（?tab=book）：跟着切过去
watch(
  () => route.query.tab,
  (t) => {
    if ((['timeline', 'diary', 'album', 'book'] as Tab[]).includes(t as Tab) && t !== tab.value) tab.value = t as Tab;
  },
);

// —— 时间线：总结写的梗概（各层还没合并的段，越早越概括）和故事片段 ——
const segments = computed(() => (chat.value ? [...mem.timelineOf(chat.value.id)].reverse() : []));
const slices = computed(() => [...mem.slicesOf(character.value.id)].sort((a, b) => b.startAt - a.startAt));
const sliceLimit = ref(30);
watch(character, () => (sliceLimit.value = 30));
/** 还没总结过：先显示演示时间线 */
const demoTimeline = computed(() => (segments.value.length || slices.value.length ? [] : timeline.filter((t) => t.characterId === character.value.id)));
function span(a: number, b: number) {
  const x = monthDay(a);
  const y = monthDay(b);
  return x === y ? x : `${x} ~ ${y}`;
}
const LEVEL_NOTE = ['', '合并了 4 段', '合并了 16 段', '合并了 64 段', '合并了 256 段'];

// —— 画像卡 ——
const profile = computed(() => mem.profileOf(character.value.id));
const profileGroups = computed(() => {
  const groups = new Map<string, { id: string; text: string }[]>();
  for (const l of profile.value?.lines ?? []) groups.set(l.section, [...(groups.get(l.section) ?? []), { id: l.id, text: l.text }]);
  return [...groups.entries()];
});
const lineEdit = reactive({ open: false, id: '', section: '', text: '' });
function editLine(id?: string) {
  const l = profile.value?.lines.find((x) => x.id === id);
  Object.assign(lineEdit, { open: true, id: l?.id ?? '', section: l?.section ?? '基本', text: l?.text ?? '' });
}
function saveLine() {
  const text = lineEdit.text.trim();
  if (!text) return;
  if (lineEdit.id) mem.editProfileLine(character.value.id, lineEdit.id, { section: lineEdit.section.trim() || '其他', text });
  else mem.addProfileLine(character.value.id, lineEdit.section, text);
  lineEdit.open = false;
}
function removeLine() {
  if (lineEdit.id) mem.removeProfileLine(character.value.id, lineEdit.id);
  lineEdit.open = false;
}
const SECTIONS = ['基本', '学习工作', '作息身体', '喜好', '雷区', '重要的人', '最近', '我们这一路'];

// —— 记忆本 ——
type Filter = MemoryType | 'all' | 'pinned' | 'review' | 'dup' | 'past';
const filter = ref<Filter>('all');
const keyword = ref('');
const all = computed(() => mem.memoriesOf(character.value.id));
const shown = computed(() => {
  const k = keyword.value.trim();
  let list = all.value.filter((m) => {
    if (filter.value === 'past') return m.status !== 'active';
    if (m.status !== 'active') return false;
    if (filter.value === 'all') return true;
    if (filter.value === 'pinned') return m.pinned;
    if (filter.value === 'review') return !!m.sourceChanged;
    if (filter.value === 'dup') return !!m.dupOf;
    return m.type === filter.value;
  });
  if (k) {
    // 按字面搜（单字 + 两字），也算上直接包含的
    const allow = new Set(list.map((m) => memKey(m.id)));
    const score = new Map(mem.lexical.search(k, 400, allow).map((h) => [h.key, h.score]));
    list = list.filter((m) => m.content.includes(k) || (score.get(memKey(m.id)) ?? 0) > 0).sort((a, b) => (score.get(memKey(b.id)) ?? 0) - (score.get(memKey(a.id)) ?? 0));
    return list;
  }
  return list.sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.happenedAt ?? b.createdAt) - (a.happenedAt ?? a.createdAt));
});
const counts = computed(() => ({
  review: all.value.filter((m) => m.status === 'active' && m.sourceChanged).length,
  dup: all.value.filter((m) => m.status === 'active' && m.dupOf).length,
  past: all.value.filter((m) => m.status !== 'active').length,
}));
const FILTERS = computed((): { value: Filter; label: string }[] => [
  { value: 'all', label: '全部' },
  { value: 'pinned', label: '置顶' },
  ...(Object.keys(MEMORY_TYPE_META) as MemoryType[]).map((k) => ({ value: k, label: MEMORY_TYPE_META[k].label })),
  ...(counts.value.review ? [{ value: 'review' as const, label: `待复核 ${counts.value.review}` }] : []),
  ...(counts.value.dup ? [{ value: 'dup' as const, label: `可能重复 ${counts.value.dup}` }] : []),
  ...(counts.value.past ? [{ value: 'past' as const, label: `以前的 ${counts.value.past}` }] : []),
]);

function togglePin(m: Memory) {
  mem.updateMemory(m.id, { pinned: !m.pinned });
}
async function forget(m: Memory) {
  const ok = await showConfirmDialog({ title: '忘掉这件事？', message: `${character.value.pronoun}之后不会再想起"${m.content.slice(0, 40)}"，之后的总结写出一样的事也不会再记。`, confirmButtonText: '忘掉' }).catch(() => false);
  if (!ok) return;
  mem.forgetMemory(m.id);
  showToast(`${character.value.pronoun}已经忘了这件事`);
}
function restore(m: Memory) {
  mem.updateMemory(m.id, { status: 'active', supersededBy: null });
  showToast('放回去了');
}
/** 回到原话：打开聊天，滚到这条记忆最早的那条来源消息 */
function openSource(m: Memory) {
  const c = chat.value;
  const first = m.sourceMessageIds[0];
  if (!c || !first) return;
  void router.push({ path: `/chat/${c.id}`, query: { at: first } });
}
const statusLabel = (m: Memory) => (m.status === 'superseded' ? '已被新的取代' : m.status === 'archived' ? '已归档' : '');

const edit = reactive({ open: false, id: '', content: '', importance: 5, type: 'fact' as MemoryType });
function openEdit(m: Memory) {
  Object.assign(edit, { open: true, id: m.id, content: m.content, importance: m.importance, type: m.type });
}
async function saveEdit() {
  const content = edit.content.trim();
  if (!content) return;
  const before = mem.memoryById(edit.id);
  const changed = before?.content !== content;
  mem.updateMemory(edit.id, { content, importance: edit.importance, type: edit.type, sourceChanged: false, ...(changed ? { vector: null } : {}) });
  edit.open = false;
  if (changed && services.embedding.live) {
    try {
      const [v] = await services.embedding.embed([content]);
      if (v) mem.setVector('memory', edit.id, v, services.embedding.model);
    } catch {
      // 之后"重算向量"补上
    }
  }
}

// —— 立即整理、补整理 ——
const consolidating = ref(false);
async function runConsolidate() {
  if (consolidating.value) return;
  consolidating.value = true;
  showLoadingToast({ message: '正在整理…', duration: 0, forbidClick: true });
  try {
    const r = await consolidateNow(character.value.id);
    closeToast();
    if (r.nothing) showToast(r.archived ? `现在没有要整理的；归档了 ${r.archived} 件很久没提起的小事` : '现在没有要整理的');
    else showToast(`整理好了：改了 ${r.applied} 处${r.skipped ? `，${r.skipped} 处你改过、跳过了` : ''}${r.archived ? `，归档 ${r.archived} 件` : ''}`);
    if (r.errors.length) showErrorDialog('有几件没整理成', r.errors.join('\n'));
  } catch (e) {
    closeToast();
    showErrorDialog('没整理成', e);
  } finally {
    consolidating.value = false;
  }
}

const pending = computed(() => (chat.value ? pendingForSummary(chat.value, chats.list(chat.value.id)).length : 0));
const backfill = reactive({ running: false, done: 0, remaining: 0 });
let backfillAbort: AbortController | null = null;
async function runBackfill() {
  const c = chat.value;
  if (!c || backfill.running) return;
  if (!ai.isLive('summary')) return showToast('"总结 / 记忆"还没接通 API');
  backfillAbort = new AbortController();
  Object.assign(backfill, { running: true, done: 0, remaining: pending.value });
  try {
    const r = await backfillChat(c, () => chats.list(c.id), (p) => Object.assign(backfill, p), backfillAbort.signal);
    showToast(backfillAbort.signal.aborted ? `暂停了：已整理 ${r.done} 批` : `补整理完了：整理了 ${r.done} 批`);
  } catch (e) {
    if (!isAbortError(e)) showErrorDialog('补整理停下了', e);
  } finally {
    backfill.running = false;
  }
}
function pauseBackfill() {
  backfillAbort?.abort();
}

const expanded = ref<string | null>(null);
watch(character, () => (expanded.value = myDiaries.value[0]?.id ?? null), { immediate: true });
const viewing = ref<AlbumItem | null>(null);
const albumOpen = computed({ get: () => !!viewing.value, set: (v) => (viewing.value = v ? viewing.value : null) });
</script>

<template>
  <div class="page" data-page="memories">
    <header class="gutter pt-[calc(var(--safe-top)+14px)] pb-1 flex items-center">
      <h1 class="m-0 text-[28px] font-700">回忆</h1>
    </header>
    <!-- 看谁的回忆 -->
    <HScroll :active="character.id" class="gap-2 px-4 pt-1 pb-1" role="tablist" aria-label="看谁的回忆">
      <button
        v-for="c in chars.list"
        :key="c.id"
        role="tab"
        :aria-selected="c.id === character.id"
        class="person-tab press"
        :class="{ on: c.id === character.id }"
        :style="{ '--tone': c.accent }"
        @click="pick(c.id)"
      >
        <Avatar :character="c" :size="26" />{{ c.name }}
      </button>
    </HScroll>

    <div class="page-scroll pb-6">
      <!-- 关系状态（由总结智能体维护） -->
      <div class="rel mx-4 mt-2">
        <Avatar :character="character" :size="54" live />
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2">
            <span class="text-[17px] font-700">{{ character.name }}</span>
            <span class="mood">心情：{{ rel.mood }}</span>
          </div>
          <div class="text-[12.5px] text-ink-3 mt-0.5">相识 {{ metDays }} 天 · {{ character.pronoun }}叫你"{{ rel.userNickname }}"，你叫{{ character.pronoun }}"{{ rel.charNickname }}"</div>
          <div class="flex items-center gap-2 mt-2">
            <span class="i-lucide-heart text-accent text-[14px]" />
            <van-progress :percentage="rel.affection" :show-pivot="false" stroke-width="5" class="flex-1" />
            <span class="num text-[12px] text-ink-2">{{ rel.affection }}</span>
          </div>
        </div>
      </div>
      <HScroll v-if="rel.anniversaries.length" class="gap-2 px-4 mt-2.5">
        <span v-for="a in rel.anniversaries" :key="a.label" class="chip"><span class="i-lucide-calendar-heart text-accent-ink" />{{ a.label }} · {{ a.date }}</span>
      </HScroll>

      <Segmented
        v-model="tab"
        sticky
        class="mt-3"
        :options="[
          { value: 'timeline', label: '时间线' },
          { value: 'diary', label: '日记' },
          { value: 'album', label: '相册' },
          { value: 'book', label: '记忆本' },
        ]"
      />

      <!-- 时间线 -->
      <div v-if="tab === 'timeline'" class="mt-1">
        <template v-if="segments.length">
          <div class="sub-title">你们的时间线<span>越早越概括</span></div>
          <ol class="timeline">
            <li v-for="s in segments" :key="s.id" style="--tone: var(--accent)">
              <span class="dot"><span :class="s.level ? 'i-lucide-layers' : 'i-lucide-notebook-pen'" /></span>
              <div class="flex-1 min-w-0">
                <div class="text-[12px] text-ink-3 num">{{ span(s.fromAt, s.toAt) }}<template v-if="s.level"> · {{ LEVEL_NOTE[s.level] ?? `第 ${s.level} 层` }}</template></div>
                <div class="text-[14px] text-ink leading-relaxed">{{ s.text }}</div>
              </div>
            </li>
          </ol>
        </template>
        <template v-if="slices.length">
          <div class="sub-title">故事片段<span>{{ slices.length }} 段</span></div>
          <div class="px-4 grid gap-2">
            <button v-for="s in slices.slice(0, sliceLimit)" :key="s.id" type="button" class="slice press" :class="{ stale: s.stale }" @click="chat && router.push({ path: `/chat/${chat.id}`, query: { at: s.fromMessageId } })">
              <div class="flex items-center gap-1.5 text-[12px] text-ink-3 num">
                {{ monthDay(s.startAt) }}
                <span v-if="s.tags.important" class="tag-imp">重要</span>
                <span v-for="t in [...s.tags.special, ...s.tags.mood]" :key="t" class="tag-soft">{{ t }}</span>
                <span v-if="s.stale" class="tag-warn">原话改过，待重新整理</span>
              </div>
              <div class="text-[14.5px] font-600 mt-0.5">{{ s.title }}</div>
              <div v-if="s.text !== s.title" class="text-[13px] text-ink-2 leading-relaxed mt-0.5">{{ s.text }}</div>
            </button>
            <van-button v-if="slices.length > sliceLimit" size="small" round block @click="sliceLimit += 30">再显示 30 段</van-button>
          </div>
        </template>
        <ol v-if="demoTimeline.length" class="timeline">
          <li v-for="t in demoTimeline" :key="t.id" :style="{ '--tone': t.tint }">
            <span class="dot"><span :class="t.icon" /></span>
            <div class="flex-1 min-w-0">
              <div class="text-[12px] text-ink-3 num">{{ monthDay(t.when) }}</div>
              <div class="text-[15px] font-600">{{ t.title }}</div>
              <div class="text-[13px] text-ink-2">{{ t.desc }}</div>
            </div>
          </li>
        </ol>
      </div>

      <!-- 日记 -->
      <div v-else-if="tab === 'diary'" class="px-4 grid gap-3 mt-1">
        <p class="text-[12px] text-ink-3 m-0">每晚由总结智能体用{{ character.name }}的口吻写，也是{{ character.pronoun }}的"情景记忆"</p>
        <article v-for="d in myDiaries" :key="d.id" class="diary press" @click="expanded = expanded === d.id ? null : d.id">
          <div class="flex items-center gap-2 text-[12.5px] text-ink-3">
            <span class="text-[15px] font-600 text-ink">{{ d.date }}</span>
            <span class="i-lucide-cloud-rain" v-if="d.weather.includes('雨')" /><span class="i-lucide-cloud-sun" v-else />{{ d.weather }}
            <span class="ml-auto mood-chip">{{ d.mood }}</span>
          </div>
          <p class="serif diary-text" :class="{ clamp: expanded !== d.id }">{{ d.text }}</p>
          <div class="flex flex-wrap gap-1.5">
            <span v-for="h in d.highlights" :key="h" class="chip !h-6">{{ h }}</span>
          </div>
        </article>
      </div>

      <!-- 相册 -->
      <div v-else-if="tab === 'album'" class="px-4 mt-1">
        <p class="text-[12px] text-ink-3 m-0 mb-2.5">聊天、约会、主动"自拍"里生成的 CG，都保存提示词和种子，可以复现</p>
        <div class="grid grid-cols-2 gap-2.5">
          <button v-for="a in myAlbum" :key="a.id" class="tile press" @click="viewing = a">
            <CgArt :character="character" :scene="a.scene" :expression="a.id === 'a3' ? 'laugh' : 'smile'" :outfit="a.scene === 'park' ? 'sport' : a.scene === 'bedroom' ? 'pajama' : a.scene === 'aquarium' || a.scene === 'amusement' ? 'date' : 'daily'" class="rounded-[14px]" />
            <div class="text-[13px] font-600 mt-1.5 truncate">{{ a.caption }}</div>
            <div class="text-[11.5px] text-ink-3 num">{{ monthDay(a.when) }}</div>
          </button>
        </div>
      </div>

      <!-- 记忆本 -->
      <div v-else class="mt-1">
        <!-- 画像卡 -->
        <div class="card mx-4">
          <div class="flex items-center">
            <span class="text-[15px] font-700">{{ character.name }}知道的你</span>
            <span class="text-[11.5px] text-ink-3 ml-2">每次聊天都带上</span>
            <button type="button" class="mini ml-auto" aria-label="加一行" @click="editLine()"><span class="i-lucide-plus" /></button>
          </div>
          <div v-if="profileGroups.length" class="mt-2 grid gap-1.5">
            <div v-for="[section, items] in profileGroups" :key="section" class="text-[13.5px] leading-relaxed">
              <span class="section">{{ section }}</span>
              <button v-for="(l, i) in items" :key="l.id" type="button" class="line" @click="editLine(l.id)">{{ l.text }}<template v-if="i < items.length - 1">；</template></button>
            </div>
          </div>
          <p v-else class="text-[12.5px] text-ink-3 m-0 mt-1.5">还是空的。每天的记忆整理会按新记下的事一行一行补上，也可以自己加。</p>
        </div>

        <div class="flex flex-wrap gap-2 px-4 mt-2.5">
          <van-button size="small" round icon="replay" :loading="consolidating" loading-text="整理中" @click="runConsolidate">立即整理</van-button>
          <van-button v-if="!backfill.running && pending >= msgSettings.summaryEvery()" size="small" round @click="runBackfill">补整理聊天记录（还有 {{ pending }} 条）</van-button>
          <van-button v-if="backfill.running" size="small" round type="warning" @click="pauseBackfill">暂停补整理（已整理 {{ backfill.done }} 批，还剩 {{ backfill.remaining }} 条）</van-button>
        </div>
        <p class="note-line">整理会合并重复的记忆、合并时间线、把过期的事改成过去时、修改画像卡；连了云端时每天凌晨 4 点自动整理。</p>

        <div class="px-4 mt-1">
          <div class="search">
            <span class="i-lucide-search text-ink-3" />
            <input v-model="keyword" :placeholder="`搜${character.pronoun}记得的事`" aria-label="搜索记忆" />
          </div>
        </div>
        <HScroll :active="filter" class="gap-2 px-4 py-2.5" aria-label="按类型筛选">
          <button v-for="f in FILTERS" :key="f.value" type="button" class="filter" :class="{ on: filter === f.value }" :aria-pressed="filter === f.value" @click="filter = f.value">{{ f.label }}</button>
        </HScroll>
        <div class="px-4 grid gap-2">
          <div v-for="m in shown" :key="m.id" class="mem" :class="{ past: m.status !== 'active' }" :style="{ '--tone': MEMORY_TYPE_META[m.type].color }">
            <span class="mem-icon"><span :class="MEMORY_TYPE_META[m.type].icon" /></span>
            <div class="flex-1 min-w-0">
              <button type="button" class="text-left text-[14.5px] leading-snug w-full" @click="openEdit(m)">{{ m.content }}</button>
              <div class="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1.5 text-[11.5px] text-ink-3">
                <span class="type">{{ MEMORY_TYPE_META[m.type].label }}</span>
                <span v-if="m.happenedAt" class="num">{{ monthDay(m.happenedAt) }}</span>
                <span class="num">重要度 {{ m.importance }}</span>
                <span v-if="m.recallCount" class="num">想起过 {{ m.recallCount }} 次</span>
                <span v-if="m.dueAt && m.type === 'followup'" class="due num"><span class="i-lucide-alarm-clock" />{{ monthDay(m.dueAt) }} 到期 · {{ character.pronoun }}会来问</span>
                <span v-if="m.sourceChanged" class="warn">原话改过，看看还对不对</span>
                <span v-if="m.dupOf" class="warn">可能和另一条重复，整理时会合并</span>
                <span v-if="statusLabel(m)">{{ statusLabel(m) }}</span>
                <button v-if="m.sourceMessageIds.length && chat" type="button" class="link" @click="openSource(m)">回到原话</button>
              </div>
            </div>
            <div class="flex flex-col gap-1">
              <template v-if="m.status === 'active'">
                <button class="mini" :class="{ on: m.pinned }" :aria-label="m.pinned ? '取消置顶' : '置顶'" @click="togglePin(m)"><span class="i-lucide-pin" /></button>
                <button class="mini" aria-label="忘掉这件事" @click="forget(m)"><span class="i-lucide-eraser" /></button>
              </template>
              <button v-else class="mini" aria-label="放回去" @click="restore(m)"><span class="i-lucide-undo-2" /></button>
            </div>
          </div>
          <p v-if="!shown.length" class="text-center text-ink-3 text-[13px] py-6">{{ all.length ? '没有找到' : `还没有记忆：聊够 ${msgSettings.summaryEvery()} 条后会自动整理` }}</p>
        </div>
        <RouterLink to="/me/api" class="embed-note">
          <span class="i-lucide-waypoints" />
          向量模型：{{ services.embedding.live ? `${services.embedding.model} · ${services.embedding.dims || '—'} 维` : '没接通，只按字面搜' }} · 检索在本机计算
          <span class="i-lucide-chevron-right ml-auto" />
        </RouterLink>
      </div>
    </div>

    <!-- 改一条记忆 -->
    <van-popup v-model:show="edit.open" position="bottom" round>
      <div class="p-4 grid gap-3">
        <div class="text-[16px] font-600">改这条记忆</div>
        <van-field v-model="edit.content" type="textarea" rows="3" autosize class="field" placeholder="一句话，写清人和事、写具体日期" />
        <HScroll :active="edit.type" class="gap-2">
          <button v-for="k in Object.keys(MEMORY_TYPE_META) as MemoryType[]" :key="k" type="button" class="filter" :class="{ on: edit.type === k }" @click="edit.type = k">{{ MEMORY_TYPE_META[k].label }}</button>
        </HScroll>
        <div class="flex items-center">
          <span class="text-[14px]">重要度</span>
          <van-stepper v-model="edit.importance" :min="1" :max="10" integer class="ml-auto" />
        </div>
        <van-button round block type="primary" @click="saveEdit">保存</van-button>
      </div>
    </van-popup>

    <!-- 画像卡的一行 -->
    <van-popup v-model:show="lineEdit.open" position="bottom" round>
      <div class="p-4 grid gap-3">
        <div class="text-[16px] font-600">{{ lineEdit.id ? '改这一行' : '加一行' }}</div>
        <HScroll :active="lineEdit.section" class="gap-2">
          <button v-for="sec in SECTIONS" :key="sec" type="button" class="filter" :class="{ on: lineEdit.section === sec }" @click="lineEdit.section = sec">{{ sec }}</button>
        </HScroll>
        <van-field v-model="lineEdit.section" label="栏目" class="field" />
        <van-field v-model="lineEdit.text" type="textarea" rows="2" autosize class="field" placeholder="一行只写一件事" />
        <div class="flex gap-2">
          <van-button v-if="lineEdit.id" round block @click="removeLine">删掉这一行</van-button>
          <van-button round block type="primary" @click="saveLine">保存</van-button>
        </div>
      </div>
    </van-popup>

    <van-popup v-model:show="albumOpen" round class="w-[88%] max-w-[400px]">
      <div v-if="viewing" class="p-3">
        <CgArt :character="character" :scene="viewing.scene" expression="smile" class="rounded-[16px]" />
        <div class="mt-3 text-[16px] font-600">{{ viewing.caption }}</div>
        <div class="mt-1 text-[12px] text-ink-3 break-all">提示词：{{ viewing.prompt }}</div>
        <div class="text-[12px] text-ink-3 num">种子：{{ viewing.seed }} · NovelAI V4.5 · 832×1216</div>
        <div class="flex gap-2 mt-3">
          <van-button size="small" round block @click="showToast('M5 接入 NovelAI')">用同样参数重画</van-button>
          <van-button size="small" round block type="primary" @click="showToast('M5：出了真图就能一键设为聊天背景')">设为聊天背景</van-button>
        </div>
      </div>
    </van-popup>
  </div>
</template>

<style scoped>
.person-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 36px;
  padding: 0 12px 0 5px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 14px;
  white-space: nowrap;
  flex-shrink: 0;
}
.person-tab.on {
  background: var(--accent-soft);
  color: var(--ink);
  font-weight: 600;
  box-shadow: inset 0 0 0 1.5px var(--tone);
}
.rel {
  display: flex;
  gap: 12px;
  padding: 14px;
  border-radius: 20px;
  background: linear-gradient(135deg, var(--accent-soft), transparent 70%), var(--surface);
  border: 1px solid var(--border);
}
.mood {
  padding: 1px 8px;
  border-radius: 99px;
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: 11.5px;
}
.sub-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 10px 16px 6px;
  font-size: 15px;
  font-weight: 700;
}
.sub-title span {
  font-size: 11.5px;
  font-weight: 400;
  color: var(--ink-3);
}
.timeline {
  list-style: none;
  margin: 6px 0 0;
  padding: 0 16px 0 18px;
}
.timeline li {
  position: relative;
  display: flex;
  gap: 14px;
  padding: 0 0 18px;
}
.timeline li::before {
  content: '';
  position: absolute;
  left: 15px;
  top: 34px;
  bottom: 0;
  width: 2px;
  background: var(--border);
}
.timeline li:last-child::before {
  display: none;
}
.timeline .dot {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--panel);
  color: var(--tone);
  font-size: 16px;
  flex-shrink: 0;
  box-shadow: 0 0 0 3px var(--bg);
}
.slice {
  display: block;
  text-align: left;
  padding: 12px 14px;
  border-radius: 16px;
  background: var(--surface);
  border: 1px solid var(--border);
}
.slice.stale {
  opacity: 0.6;
}
.tag-imp,
.tag-soft,
.tag-warn {
  padding: 0 6px;
  border-radius: 99px;
  font-size: 11px;
}
.tag-imp {
  background: var(--accent-soft);
  color: var(--accent-ink);
}
.tag-soft {
  background: var(--panel);
  color: var(--ink-2);
}
.tag-warn {
  color: var(--warn);
}
.diary {
  display: block;
  padding: 14px 16px;
  border-radius: 20px;
  background: var(--surface);
  border: 1px solid var(--border);
}
.mood-chip {
  padding: 1px 8px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-2);
}
.diary-text {
  margin: 10px 0;
  font-size: 15px;
  line-height: 1.9;
  color: var(--ink);
}
.diary-text.clamp {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.tile {
  display: block;
  text-align: left;
}
.card {
  padding: 14px;
  border-radius: 18px;
  background: var(--surface);
  border: 1px solid var(--border);
}
.section {
  display: inline-block;
  margin-right: 6px;
  padding: 0 7px;
  border-radius: 99px;
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: 11.5px;
}
.line {
  display: inline;
  text-align: left;
  color: var(--ink);
}
.note-line {
  margin: 6px 16px 4px;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--ink-3);
}
.search {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 40px;
  padding: 0 14px;
  border-radius: 20px;
  background: var(--panel);
}
.search input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: none;
  background: transparent;
}
.filter {
  height: 30px;
  padding: 0 12px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 13px;
  white-space: nowrap;
  flex-shrink: 0;
}
.filter.on {
  background: var(--accent);
  color: var(--on-accent);
  font-weight: 600;
}
.mem {
  display: flex;
  gap: 10px;
  padding: 12px;
  border-radius: 16px;
  background: var(--surface);
  border: 1px solid var(--border);
}
.mem.past {
  opacity: 0.65;
}
.mem-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 10px;
  background: var(--panel);
  color: var(--tone);
  flex-shrink: 0;
}
.type {
  color: var(--tone);
}
.due {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: var(--warn);
}
.warn {
  color: var(--warn);
}
.link {
  color: var(--accent-ink);
  text-decoration: underline;
}
.mini {
  width: 30px;
  height: 30px;
  border-radius: 10px;
  color: var(--ink-3);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.mini.on {
  color: var(--accent-ink);
  background: var(--accent-soft);
}
.field {
  border-radius: 12px;
  background: var(--panel);
}
.embed-note {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 14px 16px 0;
  padding: 10px 12px;
  border-radius: 14px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 12.5px;
  text-decoration: none;
}
</style>
