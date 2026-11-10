<script setup lang="ts">
import { AREA_LABEL, defaultLocationFor, getLocation, LOCATIONS, SCENES, timeOfDay, type Character, type LocationActivity, type MapLocation, type SceneId } from '@app/shared';
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Avatar from '@/components/common/Avatar.vue';
import WorldMap from '@/components/map/WorldMap.vue';
import { mockToday, weather } from '@/mock/activity';
import { useAppStore } from '@/stores/app';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';
import { hhmm } from '@/utils/time';

/**
 * 地图（原"一起"）：场景不再是一格格入口，而是地图上的地点。
 * 她们按作息出现在各自的地方；点地点 → 看在这里能做什么、和谁一起去；点头像 → 去找她 / 发消息。
 * "一起去"会在你们的那条聊天里插一条"来到…"的分隔，离开时插"离开…"。
 */
const route = useRoute();
const router = useRouter();
const app = useAppStore();
const chars = useCharacterStore();
const chat = useChatStore();
const today = mockToday();
const now = new Date();

const active = computed(() => chars.byId(app.activeCharacterId) ?? chars.list[0]!);

function locOf(c: Character) {
  return getLocation(c.locationId) ?? (LOCATIONS[0] as MapLocation);
}

// —— 此刻的建议：她在外面就去找她；在家就按时段建议 ——
const TIME_SUGGEST: Record<string, { scene: SceneId; text: string }> = {
  dawn: { scene: 'exercise', text: '早上空气好好，一起去跑两圈？' },
  morning: { scene: 'meal', text: '早饭吃了没？我陪你吃。' },
  noon: { scene: 'meal', text: '到饭点啦……我有点饿了。' },
  afternoon: { scene: 'study', text: '下午一起自习吧。' },
  dusk: { scene: 'meal', text: '晚饭想吃什么？我请客～' },
  night: { scene: 'music', text: '下雨天，一起听首歌吗？' },
  late: { scene: 'sleep', text: '已经很晚了……早点躺下，我给你讲故事？' },
};
const suggestion = computed(() => {
  const c = active.value;
  const here = locOf(c);
  if (here.id !== 'home' && here.activities[0]) {
    return { character: c, loc: here, activity: here.activities[0], text: `${c.name}在${here.name}${c.status}，去陪她？` };
  }
  const t = TIME_SUGGEST[timeOfDay(now.getHours())] ?? TIME_SUGGEST.night!;
  const loc = defaultLocationFor(t.scene);
  const activity = loc.activities.find((a) => a.sceneId === t.scene) ?? loc.activities[0]!;
  return { character: c, loc, activity, text: `「${t.text}」` };
});

// —— 和她一起去 ——
function go(loc: MapLocation, activity: LocationActivity, characterId: string) {
  app.activeCharacterId = characterId;
  locOpen.value = false;
  charOpen.value = false;
  void router.push({ path: `/scene/${activity.sceneId}`, query: { at: loc.id } });
}

// —— 地点面板 ——
const selectedLoc = ref<MapLocation | null>(null);
const locOpen = ref(false);
const companionId = ref(app.activeCharacterId);
const here = computed(() => chars.list.filter((c) => c.locationId === selectedLoc.value?.id));
function openLoc(l: MapLocation) {
  selectedLoc.value = l;
  companionId.value = chars.list.find((c) => c.locationId === l.id)?.id ?? app.activeCharacterId;
  locOpen.value = true;
}
const companion = computed(() => chars.byId(companionId.value) ?? active.value);

// —— 角色面板 ——
const selectedChar = ref<Character | null>(null);
const charOpen = ref(false);
function openChar(c: Character) {
  selectedChar.value = c;
  charOpen.value = true;
}

/** 能一起做的事：点一下打开最常去的那个地点 */
const ACTIVITY_CHIPS = SCENES.map((s) => ({ id: s.id, name: s.name, icon: s.icon, tint: s.tint }));
function openActivity(sceneId: SceneId) {
  openLoc(defaultLocationFor(sceneId));
}

onMounted(() => {
  const focus = getLocation(route.query.focus as string);
  if (focus) openLoc(focus);
});
</script>

<template>
  <div class="page" data-page="map">
    <header class="gutter pt-[calc(var(--safe-top)+14px)] pb-2 flex items-end gap-2">
      <div>
        <h1 class="m-0 text-[28px] font-700 leading-tight">地图</h1>
        <div class="text-[12.5px] text-ink-3 mt-0.5 num">
          <span :class="weather.icon" /> {{ hhmm(now.getTime()) }} · {{ weather.city }} {{ weather.text }} {{ weather.tempC }}°C
        </div>
      </div>
    </header>

    <div class="page-scroll pb-6">
      <!-- 此刻的建议 -->
      <button class="suggest mx-4 press" @click="go(suggestion.loc, suggestion.activity, suggestion.character.id)">
        <Avatar :character="suggestion.character" :size="40" live />
        <div class="flex-1 min-w-0 text-left">
          <div class="text-[14px] leading-snug">{{ suggestion.text }}</div>
          <div class="text-[12px] text-ink-3 mt-0.5"><span class="i-lucide-map-pin" /> {{ suggestion.loc.name }} · {{ suggestion.activity.label }}</div>
        </div>
        <span class="go">一起去</span>
      </button>

      <!-- 小地图 -->
      <div class="mx-4 mt-3">
        <WorldMap :characters="chars.list" :you-at="chat.youAt" :focus="selectedLoc?.id ?? null" @select-location="openLoc" @select-character="openChar" />
      </div>
      <p class="text-[12px] text-ink-3 text-center mt-2 mb-0">点地点：在那里能做什么、和谁一起去 · 点头像：去找她</p>

      <!-- 能一起做的事 -->
      <div class="flex gap-2 overflow-x-auto hide-scrollbar px-4 pt-3">
        <button v-for="a in ACTIVITY_CHIPS" :key="a.id" class="act press" :style="{ '--tone': a.tint }" @click="openActivity(a.id)">
          <span :class="a.icon" />{{ a.name }}
        </button>
      </div>

      <!-- 她们在哪 -->
      <div class="group-title">她们在哪</div>
      <div class="px-4 grid gap-2">
        <div v-for="c in chars.list" :key="c.id" class="person">
          <Avatar :character="c" :size="40" live />
          <div class="flex-1 min-w-0">
            <div class="text-[15px] font-600">{{ c.name }}</div>
            <div class="text-[12.5px] text-ink-3 truncate"><span class="i-lucide-map-pin" /> {{ locOf(c).name }} · {{ c.status }}</div>
          </div>
          <RouterLink :to="`/chat/${chat.chatOfCharacter(c.id)?.id}`" class="mini-btn">发消息</RouterLink>
          <button class="mini-btn primary" @click="go(locOf(c), locOf(c).activities[0]!, c.id)">去找她</button>
        </div>
      </div>

      <!-- 今天的你 -->
      <div class="group-title">今天的你</div>
      <div class="grid grid-cols-4 gap-2 px-4">
        <div class="stat"><span class="i-lucide-footprints" /><b class="num">{{ (today.steps / 1000).toFixed(1) }}k</b><small>步数</small></div>
        <div class="stat"><span class="i-lucide-utensils" /><b>{{ [today.meals.breakfast, today.meals.lunch, today.meals.dinner].filter(Boolean).length }}/3</b><small>三餐</small></div>
        <div class="stat"><span class="i-lucide-book-open" /><b class="num">{{ today.studyMin }}′</b><small>学习</small></div>
        <div class="stat"><span class="i-lucide-moon-star" /><b class="num">{{ today.lastSleep.hours }}h</b><small>睡眠</small></div>
      </div>
    </div>

    <!-- 地点面板 -->
    <van-popup v-model:show="locOpen" position="bottom" round>
      <div v-if="selectedLoc" class="sheet">
        <div class="flex items-center gap-3">
          <span class="loc-icon"><span :class="selectedLoc.icon" /></span>
          <div class="flex-1 min-w-0">
            <div class="sheet-title">{{ selectedLoc.name }}</div>
            <div class="text-[12.5px] text-ink-3">{{ AREA_LABEL[selectedLoc.area] }} · {{ selectedLoc.blurb }}</div>
          </div>
          <div class="flex -space-x-2">
            <Avatar v-for="c in here" :key="c.id" :character="c" :size="30" live />
          </div>
        </div>
        <div class="text-[12.5px] text-ink-2 mt-3">
          {{ here.length ? `${here.map((c) => c.name).join('、')}现在在这里` : '现在没人在这里' }}
        </div>
        <label class="field-label">和谁一起</label>
        <div class="flex gap-2">
          <button v-for="c in chars.list" :key="c.id" class="with" :class="{ on: companionId === c.id }" @click="companionId = c.id">
            <Avatar :character="c" :size="24" />{{ c.name }}
          </button>
        </div>
        <label class="field-label">在这里能做</label>
        <div class="grid gap-2">
          <button v-for="a in selectedLoc.activities" :key="a.label" class="activity press" @click="go(selectedLoc, a, companion.id)">
            <span class="flex-1 text-left">{{ a.sceneId === 'date' ? `约${companion.name}来这里约会` : `和${companion.name}一起 · ${a.label}` }}</span>
            <span class="i-lucide-chevron-right text-ink-3" />
          </button>
        </div>
      </div>
    </van-popup>

    <!-- 角色面板 -->
    <van-popup v-model:show="charOpen" position="bottom" round>
      <div v-if="selectedChar" class="sheet">
        <div class="flex items-center gap-3">
          <Avatar :character="selectedChar" :size="52" live />
          <div class="flex-1 min-w-0">
            <div class="sheet-title">{{ selectedChar.name }}</div>
            <div class="text-[13px] text-ink-2"><span class="i-lucide-map-pin text-accent-ink" /> {{ locOf(selectedChar).name }} · {{ selectedChar.status }}</div>
          </div>
        </div>
        <div class="grid grid-cols-3 gap-2 mt-4">
          <button class="big-btn primary" @click="go(locOf(selectedChar), locOf(selectedChar).activities[0]!, selectedChar.id)">
            <span class="i-lucide-footprints" />去找她
          </button>
          <RouterLink :to="`/chat/${chat.chatOfCharacter(selectedChar.id)?.id}`" class="big-btn"><span class="i-lucide-message-circle" />发消息</RouterLink>
          <RouterLink :to="`/call/${selectedChar.id}`" class="big-btn"><span class="i-lucide-phone" />打电话</RouterLink>
        </div>
      </div>
    </van-popup>
  </div>
</template>

<style scoped>
.suggest {
  display: flex;
  align-items: center;
  gap: 12px;
  width: calc(100% - 32px);
  padding: 12px 14px;
  border-radius: 20px;
  background: var(--accent-soft);
  border: 1px solid var(--accent-line);
}
.go {
  height: 32px;
  padding: 0 12px;
  border-radius: 99px;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 13px;
  font-weight: 600;
  line-height: 32px;
  flex-shrink: 0;
}
.act {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 32px;
  padding: 0 12px;
  border-radius: 99px;
  background: var(--surface);
  border: 1px solid var(--border);
  font-size: 13px;
  white-space: nowrap;
  flex-shrink: 0;
}
.act span {
  color: var(--tone);
}
.person {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 16px;
  background: var(--surface);
  border: 1px solid var(--border);
}
.mini-btn {
  height: 30px;
  padding: 0 10px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink);
  font-size: 12.5px;
  line-height: 30px;
  text-decoration: none;
  flex-shrink: 0;
}
.mini-btn.primary {
  background: var(--accent);
  color: var(--on-accent);
  font-weight: 600;
}
.stat {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 12px 4px;
  border-radius: 16px;
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--accent-ink);
}
.stat b {
  color: var(--ink);
  font-size: 16px;
}
.stat small {
  color: var(--ink-3);
  font-size: 11.5px;
}
.loc-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: 14px;
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: 22px;
  flex-shrink: 0;
}
.with {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 36px;
  padding: 0 12px 0 6px;
  border-radius: 99px;
  background: var(--panel);
  font-size: 13.5px;
}
.with.on {
  outline: 1.5px solid var(--accent);
  background: var(--accent-soft);
}
.activity {
  display: flex;
  align-items: center;
  height: 46px;
  padding: 0 14px;
  border-radius: 14px;
  background: var(--panel);
  font-size: 14.5px;
}
.big-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 12px 0;
  border-radius: 16px;
  background: var(--panel);
  color: var(--ink);
  font-size: 13px;
  text-decoration: none;
}
.big-btn span {
  font-size: 20px;
}
.big-btn.primary {
  background: var(--accent);
  color: var(--on-accent);
  font-weight: 600;
}
</style>
