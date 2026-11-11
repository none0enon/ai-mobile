<script setup lang="ts">
import type { MemoryType } from '@app/shared';
import { showToast } from 'vant';
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Avatar from '@/components/common/Avatar.vue';
import HScroll from '@/components/common/HScroll.vue';
import Segmented from '@/components/common/Segmented.vue';
import CgArt from '@/components/figure/CgArt.vue';
import { album, diaries, memories, MEMORY_TYPE_META, timeline, type AlbumItem } from '@/mock/memories';
import { services } from '@/services';
import { useAppStore } from '@/stores/app';
import { useCharacterStore } from '@/stores/characters';
import { daysBetween, monthDay } from '@/utils/time';

type Tab = 'timeline' | 'diary' | 'album' | 'book';
const route = useRoute();
const router = useRouter();
const app = useAppStore();
const chars = useCharacterStore();
/**
 * 回忆按人分：上面一排头像切换看谁的回忆（?char=），默认是当前陪着你的角色。
 * 换人时点缀色也跟着换（App.vue 读 ?char）。
 */
const character = computed(() => chars.byId(route.query.char as string | undefined) ?? chars.byId(app.activeCharacterId) ?? chars.list[0]!);
function pick(id: string) {
  void router.replace({ query: { ...route.query, char: id } });
}
const myTimeline = computed(() => timeline.filter((t) => t.characterId === character.value.id));
const myDiaries = computed(() => diaries.filter((d) => d.characterId === character.value.id));
const myAlbum = computed(() => album.filter((a) => a.characterId === character.value.id));
const rel = computed(() => character.value.relationship);
const metDays = computed(() => daysBetween(rel.value.metAt, Date.now()));

const tab = ref<Tab>((['timeline', 'diary', 'album', 'book'] as Tab[]).includes(route.query.tab as Tab) ? (route.query.tab as Tab) : 'timeline');
watch(tab, (t) => void router.replace({ query: { ...route.query, tab: t } }));

// 记忆本
const items = ref(memories.map((m) => ({ ...m })));
const filter = ref<MemoryType | 'all' | 'pinned'>('all');
const keyword = ref('');
const shown = computed(() =>
  items.value
    .filter((m) => m.characterId === character.value.id)
    .filter((m) => (filter.value === 'all' ? true : filter.value === 'pinned' ? m.pinned : m.type === filter.value))
    .filter((m) => !keyword.value || m.content.includes(keyword.value))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.importance - a.importance),
);

const FILTERS: { value: MemoryType | 'all' | 'pinned'; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'pinned', label: '置顶' },
  ...(Object.keys(MEMORY_TYPE_META) as MemoryType[]).map((k) => ({ value: k, label: MEMORY_TYPE_META[k].label })),
];
function forget(id: string) {
  items.value = items.value.filter((m) => m.id !== id);
  showToast(`${character.value.pronoun}已经忘了这件事`);
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
      <ol v-if="tab === 'timeline'" class="timeline">
        <li v-for="t in myTimeline" :key="t.id" :style="{ '--tone': t.tint }">
          <span class="dot"><span :class="t.icon" /></span>
          <div class="flex-1 min-w-0">
            <div class="text-[12px] text-ink-3 num">{{ monthDay(t.when) }}</div>
            <div class="text-[15px] font-600">{{ t.title }}</div>
            <div class="text-[13px] text-ink-2">{{ t.desc }}</div>
          </div>
        </li>
      </ol>

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
        <div class="px-4">
          <div class="search">
            <span class="i-lucide-search text-ink-3" />
            <input v-model="keyword" :placeholder="`搜${character.pronoun}记得的事（本机向量检索）`" aria-label="搜索记忆" />
          </div>
        </div>
        <HScroll :active="filter" class="gap-2 px-4 py-2.5" aria-label="按类型筛选">
          <button v-for="f in FILTERS" :key="f.value" type="button" class="filter" :class="{ on: filter === f.value }" :aria-pressed="filter === f.value" @click="filter = f.value">{{ f.label }}</button>
        </HScroll>
        <div class="px-4 grid gap-2">
          <div v-for="m in shown" :key="m.id" class="mem" :style="{ '--tone': MEMORY_TYPE_META[m.type].color }">
            <span class="mem-icon"><span :class="MEMORY_TYPE_META[m.type].icon" /></span>
            <div class="flex-1 min-w-0">
              <div class="text-[14.5px] leading-snug">{{ m.content }}</div>
              <div class="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1.5 text-[11.5px] text-ink-3">
                <span class="type">{{ MEMORY_TYPE_META[m.type].label }}</span>
                <span class="num">重要度 {{ m.importance }}</span>
                <span v-if="m.recallCount" class="num">想起过 {{ m.recallCount }} 次</span>
                <span v-if="m.dueAt" class="due num"><span class="i-lucide-alarm-clock" />{{ monthDay(m.dueAt) }} 到期 · {{ character.pronoun }}会来问</span>
              </div>
            </div>
            <div class="flex flex-col gap-1">
              <button class="mini" :class="{ on: m.pinned }" :aria-label="m.pinned ? '取消置顶' : '置顶'" @click="m.pinned = !m.pinned"><span class="i-lucide-pin" /></button>
              <button class="mini" aria-label="忘掉这件事" @click="forget(m.id)"><span class="i-lucide-eraser" /></button>
            </div>
          </div>
          <p v-if="!shown.length" class="text-center text-ink-3 text-[13px] py-6">没有找到</p>
        </div>
        <RouterLink to="/me/api" class="embed-note">
          <span class="i-lucide-waypoints" />
          向量模型：{{ services.embedding.live ? `${services.embedding.model} · ${services.embedding.dims || '—'} 维` : '演示用假向量' }} · 检索在本机计算
          <span class="i-lucide-chevron-right ml-auto" />
        </RouterLink>
      </div>
    </div>

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
