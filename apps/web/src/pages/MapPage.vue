<script setup lang="ts">
import {
  areaLabel,
  defaultLocationFor,
  getLocation,
  isRealPlace,
  SCENES,
  timeOfDay,
  worldOf,
  hasOwnWorld,
  type Character,
  type LocationActivity,
  type MapLocation,
  type SceneDef,
  type SceneId,
} from '@app/shared';
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Avatar from '@/components/common/Avatar.vue';
import HScroll from '@/components/common/HScroll.vue';
import RealMap from '@/components/map/RealMap.vue';
import WorldMap from '@/components/map/WorldMap.vue';
import { mockToday } from '@/mock/activity';
import { useAppStore } from '@/stores/app';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';
import { useRealWorldStore } from '@/stores/realworld';
import { useServicesStore } from '@/stores/services';
import { distanceText } from '@/services/maps';
import { useRhythmStore } from '@/stores/rhythm';
import { useHomeStore } from '@/stores/home';
import { useToyStore } from '@/stores/toys';
import { usePersonaStore } from '@/stores/personas';
import { useWeatherStore } from '@/stores/weather';
import { hhmm, listTime } from '@/utils/time';

/**
 * 地图：每个角色有自己的小世界，你在真实世界（Google 地图）。
 * 上面一排切换看谁的世界（?world=角色 id；me = 我的世界）。
 * - 她的世界：她按作息出现在某个地方。点地点 → 在那里能和她做什么；点头像 → 去找她。
 * - 我的世界：家、你在哪、附近可以带她去的地方。选一个地方、选带谁，她就"来你这边"陪你，离开后回到她的世界。
 */
const route = useRoute();
const router = useRouter();
const app = useAppStore();
const chars = useCharacterStore();
const chat = useChatStore();
const real = useRealWorldStore();
const today = mockToday();
const now = new Date();

/** "建世界"生成的世界登记在 @app/shared 里（不是响应式的）：读一下节律里的世界，建好以后地图跟着更新 */
const rhythm = useRhythmStore();
/** 有自己小世界的角色（导入的角色"建世界"之前没有） */
const worldOwners = computed(() => (void Object.keys(rhythm.worlds).length, chars.list.filter((c) => hasOwnWorld(c.id))));
const worldKey = computed(() => {
  void Object.keys(rhythm.worlds).length;
  const q = route.query.world as string | undefined;
  if (q === 'me' || (q && hasOwnWorld(q))) return q;
  if (hasOwnWorld(app.activeCharacterId)) return app.activeCharacterId;
  return worldOwners.value[0]?.id ?? 'me';
});
const owner = computed(() => (worldKey.value === 'me' ? null : (chars.byId(worldKey.value) ?? chars.list[0]!)));
const world = computed(() => (owner.value ? worldOf(owner.value.id) : real.world));
function switchWorld(key: string) {
  locOpen.value = false;
  actOpen.value = false;
  charOpen.value = false;
  selectedLoc.value = null;
  void router.replace({ query: { world: key } });
}

/** 顶上的天气：看她的世界时是她那边的（她住在别的城市时是那里的），看我的世界时是你这边的 */
const weatherStore = useWeatherStore();
const shownWeather = computed(() => (owner.value ? weatherStore.forCharacter(owner.value) : weatherStore.mine));
const weatherText = computed(() => {
  const w = shownWeather.value;
  if (!w) return '';
  const where = owner.value ? (weatherStore.hasOwnCity(owner.value) ? `${owner.value.name}那边 ${w.place} ` : '') : `${w.place} `;
  return `${where}${weatherStore.short(w)}`;
});

// —— 我的世界的真地图（填了 Google 地图的 Key、知道家或你在哪时）——
const svc = useServicesStore();
const mapError = ref('');
/** 有坐标可画：家的地址换成了坐标，或者定位到了你 */
const canDrawReal = computed(() => !!real.homeGeo || !!real.here);
const showRealMap = computed(() => svc.mapsReady && canDrawReal.value && !mapError.value);
const footprintIds = computed(() => chat.footprints.map((f) => f.placeId));
/** 离家多远（附近的地方、地点面板里写） */
function farText(l: MapLocation): string {
  return l.distanceKm != null ? `离家 ${distanceText(l.distanceKm)}` : '';
}

/** 和她正在一起的真实地点（她来你这边了） */
function realTogether(c: Character): MapLocation | undefined {
  const loc = getLocation(chat.chatOfCharacter(c.id)?.togetherAt);
  return isRealPlace(loc) ? loc : undefined;
}
/** 你此刻在哪：带谁出门了就在那儿，否则在家（演示；正式版来自定位） */
const youAtReal = computed(() => chars.list.map(realTogether).find(Boolean)?.id ?? real.hereId);
const youAtRealLoc = computed(() => getLocation(youAtReal.value));
/** 真实世界里跟着你的人 */
const withYou = computed(() => chars.list.filter((c) => realTogether(c)));
/** 在她的世界里，你和她正一起在哪 */
const youInHerWorld = computed(() => {
  const at = owner.value ? chat.chatOfCharacter(owner.value.id)?.togetherAt : null;
  return at && world.value.locations.some((l) => l.id === at) ? at : null;
});
/** 她来你这边了吗 */
const away = computed(() => (owner.value ? realTogether(owner.value) : undefined));

function locOf(c: Character): MapLocation {
  return getLocation(c.locationId) ?? (worldOf(c.id).locations[0] as MapLocation);
}

// —— 她的世界：此刻的建议（按她的口吻） ——
type Suggest = Record<string, { scene: SceneId; text: string }>;
const SUGGEST: Record<string, Suggest> = {
  suwan: {
    dawn: { scene: 'exercise', text: '早上空气好好，一起去跑两圈？' },
    morning: { scene: 'meal', text: '早饭吃了没？我陪你吃。' },
    noon: { scene: 'meal', text: '到饭点啦……我有点饿了。' },
    afternoon: { scene: 'study', text: '下午一起自习吧。' },
    dusk: { scene: 'meal', text: '晚饭想吃什么？我请客～' },
    night: { scene: 'music', text: '下雨天，一起听首歌吗？' },
    late: { scene: 'sleep', text: '已经很晚了……早点躺下，我给你讲故事？' },
  },
  jiangyu: {
    dawn: { scene: 'exercise', text: '六点。操场。' },
    morning: { scene: 'meal', text: '早饭吃了没？没吃就来食堂。' },
    noon: { scene: 'meal', text: '中午来运动员食堂，管饱。' },
    afternoon: { scene: 'study', text: '你学你的，我看录像。' },
    dusk: { scene: 'exercise', text: '晚上江边夜跑，来不来。' },
    night: { scene: 'music', text: '……睡不着？那听首歌。' },
    late: { scene: 'sleep', text: '几点了还不睡。躺下。' },
  },
};
const suggestion = computed(() => {
  const c = owner.value;
  if (!c) return null;
  const here = locOf(c);
  if (here.id !== world.value.homeId && !isRealPlace(here) && here.activities[0]) {
    return { loc: here, activity: here.activities[0], text: `${c.name}在${here.name}${c.status}，去陪${c.pronoun}？` };
  }
  const table = SUGGEST[c.id] ?? SUGGEST.suwan!;
  const t = table[timeOfDay(now.getHours())] ?? table.night!;
  const loc = defaultLocationFor(t.scene, c.id);
  const activity = loc.activities.find((a) => a.sceneId === t.scene) ?? loc.activities[0]!;
  return { loc, activity, text: `「${t.text}」` };
});

// —— 共同的家：她的世界"一起做点什么"里，紧挨着打电话，一直在（地点是你的家） ——
const homeStore = useHomeStore();
const me = computed(() => usePersonaStore().defaultPersona);
const chores = computed(() => homeStore.itemsFor(me.value));
/** 格子里的小字要短：开了家务写"家务 2/5"，没开写"和她" */
function homeTileWhere(name: string): string {
  const n = chores.value.length;
  return me.value.housework?.enabled && n ? `家务 ${chores.value.filter((c) => c.mark.status === 'done').length}/${n}` : `和${name}`;
}
function goHome(characterId: string) {
  app.activeCharacterId = characterId;
  void router.push({ path: '/scene/home', query: { at: 'real:home' } });
}

// —— 心跳：也一直在，紧挨着共同的家（在她那边，默认连线） ——
const toys = useToyStore();
function goHeart(characterId: string) {
  app.activeCharacterId = characterId;
  void router.push('/scene/heart');
}

// —— 一起去 ——
function go(loc: MapLocation, activity: LocationActivity, characterId: string) {
  app.activeCharacterId = characterId;
  locOpen.value = false;
  charOpen.value = false;
  actOpen.value = false;
  void router.push({ path: `/scene/${activity.sceneId}`, query: { at: loc.id } });
}

// —— 地点面板：她的世界里就是和她；真实世界里选带谁 ——
const selectedLoc = ref<MapLocation | null>(null);
const locOpen = ref(false);
const companionId = ref(app.activeCharacterId);
const here = computed(() => chars.list.filter((c) => c.locationId === selectedLoc.value?.id));
const sheetIsReal = computed(() => isRealPlace(selectedLoc.value));
function openLoc(l: MapLocation) {
  selectedLoc.value = l;
  companionId.value = owner.value?.id ?? chars.list.find((c) => c.locationId === l.id)?.id ?? app.activeCharacterId;
  locOpen.value = true;
}
const companion = computed(() => chars.byId(companionId.value) ?? chars.list[0]!);
/** 真实地点：带她来；她的世界：约会、戳戳乐是去她那儿，其余是连线（你在你那儿，她在这里） */
function activityText(a: LocationActivity, c: Character) {
  if (sheetIsReal.value) return a.sceneId === 'date' ? `带${c.name}来这里约会` : `带${c.name}一起 · ${a.label}`;
  if (a.sceneId === 'date') return `去${c.pronoun}那儿约会`;
  if (a.sceneId === 'poke') return `去${c.pronoun}那儿 · ${a.label}`;
  return `和${c.name}连线 · ${a.label}`;
}

// —— 角色面板 ——
const selectedChar = ref<Character | null>(null);
const charOpen = ref(false);
function openChar(c: Character) {
  selectedChar.value = c;
  charOpen.value = true;
}

// —— 一起做点什么：她的世界里有哪些事、在哪做 ——
function placesFor(sceneId: SceneId) {
  return world.value.locations.filter((l) => l.activities.some((a) => a.sceneId === sceneId));
}
const tiles = computed(() =>
  SCENES.map((s) => {
    const places = placesFor(s.id);
    return { scene: s, count: places.length, where: places.length > 1 ? `${places.length} 个地方` : (places[0]?.name ?? '') };
  }).filter((t) => t.count > 0),
);
const selectedScene = ref<SceneDef | null>(null);
const actOpen = ref(false);
const places = computed(() => (selectedScene.value ? placesFor(selectedScene.value.id) : []));
function openActivity(s: SceneDef) {
  selectedScene.value = s;
  actOpen.value = true;
}
function activityAt(l: MapLocation, sceneId: SceneId): LocationActivity {
  return l.activities.find((a) => a.sceneId === sceneId) ?? (l.activities[0] as LocationActivity);
}
function whoAt(l: MapLocation) {
  const list = chars.list.filter((c) => c.locationId === l.id);
  return list.length ? `${list.map((c) => c.name).join('、')}在这里` : '';
}

// 换了世界（包括从别的页面带着 ?world= 跳过来）就收起面板
watch(worldKey, () => {
  locOpen.value = false;
  actOpen.value = false;
  charOpen.value = false;
  selectedLoc.value = null;
});

/** ?focus= 打开那个地点（例如从聊天顶栏点过来） */
function openFocus() {
  const focus = getLocation(route.query.focus as string | undefined);
  if (focus && world.value.locations.some((l) => l.id === focus.id)) openLoc(focus);
}
onMounted(openFocus);
watch(
  () => route.query.focus,
  () => void nextTick(openFocus),
);
</script>

<template>
  <div class="page" data-page="map">
    <header class="gutter pt-[calc(var(--safe-top)+14px)] pb-1 flex items-end gap-2">
      <div class="min-w-0">
        <h1 class="m-0 text-[28px] font-700 leading-tight">地图</h1>
        <div class="text-[12.5px] text-ink-3 mt-0.5 num truncate">
          <span :class="shownWeather?.icon ?? 'i-lucide-clock'" /> {{ hhmm(now.getTime()) }}{{ weatherText ? ` · ${weatherText}` : '' }}
        </div>
      </div>
    </header>

    <!-- 看谁的世界 -->
    <HScroll :active="worldKey" class="gap-2 px-4 pt-1.5 pb-1" role="tablist" aria-label="看谁的世界">
      <button
        v-for="c in worldOwners"
        :key="c.id"
        role="tab"
        :aria-selected="worldKey === c.id"
        class="world-tab press"
        :class="{ on: worldKey === c.id }"
        :data-world="c.id"
        @click="switchWorld(c.id)"
      >
        <Avatar :character="c" :size="24" />{{ c.name }}的世界
      </button>
      <button role="tab" :aria-selected="worldKey === 'me'" class="world-tab press" :class="{ on: worldKey === 'me' }" data-world="me" @click="switchWorld('me')">
        <span class="globe"><span class="i-lucide-earth" /></span>我的世界
      </button>
    </HScroll>

    <div class="page-scroll pb-6">
      <!-- 她的世界 -->
      <template v-if="owner">
        <button v-if="away" class="suggest mx-4 mt-1.5 press" @click="switchWorld('me')">
          <Avatar :character="owner" :size="40" live />
          <div class="flex-1 min-w-0 text-left">
            <div class="text-[14px] leading-snug">{{ owner.name }}现在在你那边</div>
            <div class="text-[12px] text-ink-3 mt-0.5"><span class="i-lucide-map-pin" /> {{ away.name }} · 你们在一起</div>
          </div>
          <span class="go">去看看</span>
        </button>
        <button v-else-if="suggestion" class="suggest mx-4 mt-1.5 press" @click="go(suggestion.loc, suggestion.activity, owner.id)">
          <Avatar :character="owner" :size="40" live />
          <div class="flex-1 min-w-0 text-left">
            <div class="text-[14px] leading-snug">{{ suggestion.text }}</div>
            <div class="text-[12px] text-ink-3 mt-0.5"><span class="i-lucide-map-pin" /> {{ suggestion.loc.name }} · {{ suggestion.activity.label }}</div>
          </div>
          <span class="go">一起去</span>
        </button>

        <div class="mx-4 mt-3">
          <WorldMap :world="world" :characters="[owner]" :you-at="youInHerWorld" :focus="selectedLoc?.id ?? null" @select-location="openLoc" @select-character="openChar" />
        </div>
        <p class="hint">{{ world.blurb }}<br />点地点看能和{{ owner.pronoun }}做什么 · 点头像去找{{ owner.pronoun }}</p>

        <div class="group-title">一起做点什么</div>
        <div class="acts">
          <button v-for="t in tiles" :key="t.scene.id" class="act press" :style="{ '--tone': t.scene.tint }" @click="openActivity(t.scene)">
            <span class="act-icon"><span :class="t.scene.icon" /></span>
            <span class="act-name">{{ t.scene.name }}</span>
            <span class="act-where">{{ t.where }}</span>
          </button>
          <RouterLink :to="`/call/${owner.id}`" class="act press" style="--tone: #e8c26a">
            <span class="act-icon"><span class="i-lucide-phone" /></span>
            <span class="act-name">打电话</span>
            <span class="act-where">给{{ owner.name }}</span>
          </RouterLink>
          <!-- 共同的家：一直在，紧挨着打电话 -->
          <button class="act press" style="--tone: #f2c38b" data-act="home" @click="goHome(owner.id)">
            <span class="act-icon"><span class="i-lucide-house-heart" /></span>
            <span class="act-name">共同的家</span>
            <span class="act-where">{{ homeTileWhere(owner.name) }}</span>
          </button>
          <!-- 心跳：一直在，紧挨着共同的家 -->
          <button class="act press" style="--tone: #ff7a93" data-act="heart" @click="goHeart(owner.id)">
            <span class="act-icon"><span class="i-lucide-heart-pulse" /></span>
            <span class="act-name">心跳</span>
            <span class="act-where">{{ toys.ready ? `玩具连着` : `和${owner.name}` }}</span>
          </button>
        </div>
      </template>

      <!-- 我的世界（真实世界） -->
      <template v-else>
        <div class="home-card mx-4 mt-1.5">
          <span class="home-icon"><span :class="youAtRealLoc?.icon ?? 'i-lucide-house'" /></span>
          <div class="flex-1 min-w-0">
            <div class="text-[15px] font-600 truncate">
              {{ withYou.length ? `你在${youAtRealLoc?.name ?? '外面'}` : real.whereLine }}<template v-if="withYou.length"> · 和{{ withYou.map((c) => c.name).join('、') }}一起</template>
            </div>
            <div class="text-[12.5px] text-ink-3 truncate">{{ real.address ? `家 · ${real.address}` : '还没设置家的地址' }}</div>
          </div>
          <RouterLink to="/me/environment" class="mini-btn">{{ real.address ? '修改' : '设置' }}</RouterLink>
        </div>

        <div class="mx-4 mt-3 relative">
          <RealMap
            v-if="showRealMap"
            :api-key="svc.mapsKey"
            :places="real.world.locations"
            :characters="withYou"
            :you-at="youAtReal"
            :you="real.here"
            :focus="selectedLoc?.id ?? null"
            :marked="footprintIds"
            @select-location="openLoc"
            @select-character="openChar"
            @error="(m) => (mapError = m)"
          />
          <WorldMap
            v-else
            :world="real.world"
            :characters="withYou"
            :you-at="youAtReal"
            :focus="selectedLoc?.id ?? null"
            :marked="footprintIds"
            @select-location="openLoc"
            @select-character="openChar"
          />
          <RouterLink v-if="!real.mapsReady" to="/me/services#maps" class="maps-note"><span class="i-lucide-map shrink-0" />示意图 · 填 Google 地图的 Key 显示真实地图</RouterLink>
          <RouterLink v-else-if="mapError" to="/me/services#maps" class="maps-note bad" :title="mapError"><span class="i-lucide-map-pin-off shrink-0" /><span class="truncate">示意图 · {{ mapError }}</span></RouterLink>
          <RouterLink v-else-if="!canDrawReal" to="/me/environment" class="maps-note"><span class="i-lucide-house shrink-0" />示意图 · 填家的地址（或打开定位）后显示真实地图</RouterLink>
        </div>

        <div class="group-title">
          附近可以一起去
          <span class="text-[11.5px]">{{ real.nearbySource === 'google' ? '· Google 地图' : '· 演示' }}</span>
          <button v-if="real.mapsReady" class="action" :disabled="real.nearbyLoading" @click="real.refreshNearby(true)">{{ real.nearbyLoading ? '正在找…' : '刷新' }}</button>
        </div>
        <p v-if="real.nearbyError" class="note !mt-0 !mb-2 text-bad" role="alert">{{ real.nearbyError }}<template v-if="real.nearbyDetail">（{{ real.nearbyDetail }}）</template></p>
        <div class="px-4 grid gap-2">
          <button v-for="p in real.nearby" :key="p.id" class="near-row press" :data-place="p.id" @click="openLoc(p)">
            <span class="near-icon"><span :class="p.icon" /></span>
            <div class="flex-1 min-w-0 text-left">
              <div class="text-[15px] font-600 truncate">{{ p.name }}</div>
              <div class="text-[12px] text-ink-3 truncate num">{{ [p.distanceKm != null ? distanceText(p.distanceKm) : '', p.activities.map((a) => a.label).join(' / ')].filter(Boolean).join(' · ') }}</div>
            </div>
            <span class="i-lucide-chevron-right text-ink-3" />
          </button>
        </div>
        <p class="note">她们平时在自己的小世界里。你出门时带上谁，谁就"来你这边"陪你；离开后回到自己的世界。</p>

        <div class="group-title">我们的足迹</div>
        <div v-if="chat.footprints.length" class="px-4 grid gap-2">
          <button v-for="f in chat.footprints" :key="f.placeId" class="near-row press" :data-footprint="f.placeId" @click="getLocation(f.placeId) && openLoc(getLocation(f.placeId)!)">
            <span class="near-icon"><span :class="getLocation(f.placeId)?.icon ?? 'i-lucide-map-pin'" /></span>
            <div class="flex-1 min-w-0 text-left">
              <div class="text-[15px] font-600 truncate">{{ getLocation(f.placeId)?.name ?? '某个地方' }}</div>
              <div class="text-[12px] text-ink-3 truncate num">{{ f.titles.at(-1) }} · {{ listTime(f.last) }}</div>
            </div>
            <div class="flex -space-x-2 shrink-0">
              <template v-for="id in f.characterIds" :key="id"><Avatar v-if="chars.byId(id)" :character="chars.byId(id)!" :size="26" /></template>
            </div>
          </button>
        </div>
        <p v-else class="note">还没有足迹。和她们连线一起做事、或者带她们出门之后，你这边的地点会记在这里。</p>

        <div class="group-title">今天的你</div>
        <div class="grid grid-cols-4 gap-2 px-4">
          <div class="stat"><span class="i-lucide-footprints" /><b class="num">{{ (today.steps / 1000).toFixed(1) }}k</b><small>步数</small></div>
          <div class="stat"><span class="i-lucide-utensils" /><b>{{ [today.meals.breakfast, today.meals.lunch, today.meals.dinner].filter(Boolean).length }}/3</b><small>三餐</small></div>
          <div class="stat"><span class="i-lucide-book-open" /><b class="num">{{ today.studyMin }}′</b><small>学习</small></div>
          <div class="stat"><span class="i-lucide-moon-star" /><b class="num">{{ today.lastSleep.hours }}h</b><small>睡眠</small></div>
        </div>
      </template>
    </div>

    <!-- 活动面板：在她的世界里去哪儿 -->
    <van-popup v-model:show="actOpen" position="bottom" round :style="{ maxHeight: '82%' }">
      <div v-if="selectedScene && owner" class="sheet" :style="{ '--tone': selectedScene.tint }">
        <div class="flex items-center gap-3">
          <span class="act-icon"><span :class="selectedScene.icon" /></span>
          <div class="flex-1 min-w-0">
            <div class="sheet-title">和{{ owner.name }} · {{ selectedScene.name }}</div>
            <div class="text-[12.5px] text-ink-3">{{ selectedScene.tagline }}</div>
          </div>
        </div>
        <label class="field-label">在{{ owner.name }}的世界里去哪儿</label>
        <div class="grid gap-2" :class="places.length > 1 ? 'grid-cols-2' : 'grid-cols-1'">
          <button v-for="l in places" :key="l.id" class="place press" :data-place="l.id" @click="go(l, activityAt(l, selectedScene.id), owner.id)">
            <span class="place-icon"><span :class="l.icon" /></span>
            <div class="flex-1 min-w-0 text-left leading-tight">
              <div class="text-[14px] font-600 truncate">{{ l.name }}</div>
              <div class="text-[11.5px] truncate mt-0.5" :class="whoAt(l) ? 'text-accent-ink' : 'text-ink-3'">{{ whoAt(l) || l.blurb }}</div>
            </div>
          </button>
        </div>
      </div>
    </van-popup>

    <!-- 地点面板 -->
    <van-popup v-model:show="locOpen" position="bottom" round>
      <div v-if="selectedLoc" class="sheet">
        <div class="flex items-center gap-3">
          <span class="loc-icon"><span :class="selectedLoc.icon" /></span>
          <div class="flex-1 min-w-0">
            <div class="sheet-title">{{ selectedLoc.name }}</div>
            <div class="text-[12.5px] text-ink-3 truncate">
              <template v-if="sheetIsReal">{{ selectedLoc.id === 'real:home' ? selectedLoc.blurb : [farText(selectedLoc), selectedLoc.blurb].filter(Boolean).join(' · ') }}</template>
              <template v-else>{{ areaLabel(selectedLoc) }} · {{ selectedLoc.blurb }}</template>
            </div>
          </div>
          <div class="flex -space-x-2">
            <Avatar v-for="c in here" :key="c.id" :character="c" :size="30" live />
          </div>
        </div>
        <div v-if="!sheetIsReal" class="text-[12.5px] text-ink-2 mt-3">
          {{ here.length ? `${here.map((c) => c.name).join('、')}现在在这里` : `${companion.name}现在不在这里，约${companion.pronoun}过来` }}
        </div>
        <template v-if="sheetIsReal">
          <label class="field-label">带谁一起</label>
          <div class="flex gap-2 flex-wrap">
            <button v-for="c in chars.list" :key="c.id" class="with" :class="{ on: companionId === c.id }" @click="companionId = c.id">
              <Avatar :character="c" :size="24" />{{ c.name }}
            </button>
          </div>
        </template>
        <label class="field-label">在这里能做</label>
        <div class="grid gap-2">
          <button v-for="a in selectedLoc.activities" :key="a.label" class="activity press" @click="go(selectedLoc, a, companion.id)">
            <span class="flex-1 text-left">{{ activityText(a, companion) }}</span>
            <span class="i-lucide-chevron-right text-ink-3" />
          </button>
        </div>
        <a v-if="selectedLoc.mapsUri" :href="selectedLoc.mapsUri" target="_blank" rel="noopener" class="gmaps-link"><span class="i-lucide-map" />在 Google 地图里看（营业时间、路线）</a>
      </div>
    </van-popup>

    <!-- 角色面板 -->
    <van-popup v-model:show="charOpen" position="bottom" round>
      <div v-if="selectedChar" class="sheet">
        <div class="flex items-center gap-3">
          <Avatar :character="selectedChar" :size="52" live />
          <div class="flex-1 min-w-0">
            <div class="sheet-title">{{ selectedChar.name }}</div>
            <div class="text-[13px] text-ink-2 truncate"><span class="i-lucide-map-pin text-accent-ink" /> {{ locOf(selectedChar).name }} · {{ selectedChar.status }}</div>
          </div>
        </div>
        <div class="grid grid-cols-3 gap-2 mt-4">
          <button class="big-btn primary" @click="go(locOf(selectedChar), locOf(selectedChar).activities[0]!, selectedChar.id)">
            <span class="i-lucide-footprints" />去找{{ selectedChar.pronoun }}
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
.acts {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
  padding: 0 16px;
}
.act {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  min-width: 0;
  padding: 12px 4px 10px;
  border-radius: 18px;
  background: var(--surface);
  border: 1px solid var(--border);
  color: inherit;
  text-decoration: none;
}
.act-icon {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 46px;
  height: 46px;
  border-radius: 50%;
  color: var(--tone);
  font-size: 23px;
  flex-shrink: 0;
}
.act-icon::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: var(--tone);
  opacity: 0.18;
}
.act-icon > span {
  position: relative;
}
/* 窄屏 + 系统大字体时字号跟着屏宽缩一点，四个字的名字也放得下 */
.act-name {
  margin-top: 2px;
  font-size: min(13.5px, 3.4vw);
  font-weight: 600;
  white-space: nowrap;
}
.act-where {
  max-width: 100%;
  overflow: hidden;
  color: var(--ink-3);
  font-size: min(11px, 3vw);
  white-space: nowrap;
  text-overflow: ellipsis;
}
.place {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding: 10px 12px;
  border-radius: 14px;
  background: var(--panel);
}
.place-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 11px;
  background: var(--surface);
  color: var(--tone);
  font-size: 17px;
  flex-shrink: 0;
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
.world-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 36px;
  padding: 0 12px 0 5px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 13.5px;
  white-space: nowrap;
  flex-shrink: 0;
}
.world-tab.on {
  background: var(--accent-soft);
  color: var(--ink);
  font-weight: 600;
  box-shadow: inset 0 0 0 1.5px var(--accent);
}
.globe {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: linear-gradient(135deg, #6fc3e8, #4c8bd6);
  color: #fff;
  font-size: 15px;
}
.hint {
  margin: 8px 16px 0;
  font-size: 12px;
  color: var(--ink-3);
  text-align: center;
}
.home-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border-radius: 20px;
  background: var(--surface);
  border: 1px solid var(--border);
}
.home-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 12px;
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: 20px;
  flex-shrink: 0;
}
.mini-btn {
  height: 30px;
  padding: 0 12px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink);
  font-size: 13px;
  line-height: 30px;
  text-decoration: none;
  white-space: nowrap;
  flex-shrink: 0;
}
.maps-note.bad {
  color: var(--bad);
}
.gmaps-link {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  margin-top: 12px;
  font-size: 13px;
  color: var(--accent-ink);
}
.maps-note {
  position: absolute;
  z-index: 3;
  left: 10px;
  top: 10px;
  right: 10px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  width: fit-content;
  max-width: calc(100% - 20px);
  padding: 4px 10px;
  border-radius: 99px;
  background: var(--glass-strong);
  border: 1px solid var(--glass-line);
  color: var(--ink-2);
  font-size: 12px;
  text-decoration: none;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.near-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 16px;
  background: var(--surface);
  border: 1px solid var(--border);
}
.near-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border-radius: 12px;
  background: var(--panel);
  color: var(--accent-ink);
  font-size: 19px;
  flex-shrink: 0;
}
</style>
