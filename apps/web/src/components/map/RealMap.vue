<script setup lang="ts">
import { SCENES, type Character, type MapLocation } from '@app/shared';
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue';
import Avatar from '@/components/common/Avatar.vue';
import { loadGoogleMaps, onMapsAuthFailure, type GMap, type GMapsNs, type GOverlayView } from '@/services/maps';
import type { LatLng } from '@/services/types';
import { useAppStore } from '@/stores/app';

/**
 * 我的世界的真地图（Google Maps JavaScript API）：家、附近可以带她去的地方、你此刻的位置（打开了定位时的蓝点）、
 * 跟着你出门的她（头像挂在你们在的地方）、一起待过的地方（小心）。
 * 地点用 OverlayView 的一层 DOM 画（不需要 Map ID），内容用 Teleport 放进去，样式和示意图（WorldMap）一样。
 * 脚本加载失败、Key 被拒时发 error，地图页退回示意图并写明原因。
 */
const props = withDefaults(
  defineProps<{
    apiKey: string;
    /** 要画的地点（没有坐标的不画） */
    places: MapLocation[];
    /** 跟着你出门的她们（locationId 是真实地点） */
    characters: Character[];
    /** 你在哪个地点（不知道定位时把"你"标在这里） */
    youAt?: string | null;
    /** 你此刻的定位（蓝点） */
    you?: LatLng | null;
    focus?: string | null;
    marked?: string[];
  }>(),
  { youAt: null, you: null, focus: null, marked: () => [] },
);
const emit = defineEmits<{
  (e: 'select-location', loc: MapLocation): void;
  (e: 'select-character', c: Character): void;
  (e: 'error', message: string): void;
}>();

const box = ref<HTMLElement | null>(null);
const layerEl = shallowRef<HTMLElement | null>(null);
/** 每个点在覆盖层里的像素位置（缩放后重算；拖动时整层跟着地图走，不用算） */
const pos = reactive<Record<string, { x: number; y: number }>>({});
const status = ref<'loading' | 'ready' | 'error'>('loading');
const error = ref('');
let gm: GMapsNs | null = null;
let map: GMap | null = null;
let layer: GOverlayView | null = null;

const drawn = computed(() => props.places.filter((p) => typeof p.lat === 'number' && typeof p.lng === 'number'));
const TINT: Record<string, string> = Object.fromEntries(SCENES.map((s) => [s.id, s.tint]));
function tone(l: MapLocation) {
  if (l.id === 'real:home') return '#f5b8a6';
  if (l.id === 'real:out') return '#8ec5e8';
  return TINT[l.activities[0]?.sceneId ?? ''] ?? '#b9adce';
}

function project() {
  const proj = layer?.getProjection();
  if (!proj || !gm) return;
  const put = (id: string, lat: number, lng: number) => {
    const pt = proj.fromLatLngToDivPixel(new gm!.LatLng(lat, lng));
    if (pt) pos[id] = { x: pt.x, y: pt.y };
  };
  for (const p of drawn.value) put(p.id, p.lat!, p.lng!);
  if (props.you) put('__you', props.you.lat, props.you.lng);
}

/** 让所有点都在画面里（只有一个点时以它为中心、街区级别） */
function fit() {
  if (!map || !gm) return;
  const pts: LatLng[] = drawn.value.map((p) => ({ lat: p.lat!, lng: p.lng! }));
  if (props.you) pts.push(props.you);
  if (!pts.length) return;
  if (pts.length === 1) {
    map.setCenter(pts[0]!);
    map.setZoom(15);
    return;
  }
  const b = new gm.LatLngBounds();
  for (const p of pts) b.extend(p);
  map.fitBounds(b, 44);
}

function fail(message: string) {
  if (status.value === 'error') return;
  status.value = 'error';
  error.value = message;
  emit('error', message);
}

function makeLayer(g: GMapsNs): GOverlayView {
  const Base = g.OverlayView;
  class Layer extends Base {
    readonly div = document.createElement('div');
    onAdd() {
      this.div.className = 'rm-layer';
      this.div.style.position = 'absolute';
      this.div.style.left = '0';
      this.div.style.top = '0';
      this.getPanes()?.overlayMouseTarget.appendChild(this.div);
      // 点地点、点头像时不要让地图当成拖动 / 点地图
      g.OverlayView.preventMapHitsAndGesturesFrom?.(this.div);
      layerEl.value = this.div;
    }
    draw() {
      project();
    }
    onRemove() {
      this.div.remove();
      layerEl.value = null;
    }
  }
  return new Layer();
}

let offAuth: (() => void) | null = null;
onMounted(async () => {
  offAuth = onMapsAuthFailure(() =>
    fail(`Google 地图拒绝了这个 Key：检查它有没有开通 Maps JavaScript API、绑没绑结算账号，"网站限制"里有没有 ${location.origin}`),
  );
  try {
    gm = await loadGoogleMaps(props.apiKey);
    if (!box.value || status.value === 'error') return;
    const dark = useAppStore().resolvedTheme === 'dark';
    const first = drawn.value[0];
    map = new gm.Map(box.value, {
      center: props.you ?? (first ? { lat: first.lat!, lng: first.lng! } : { lat: 37.7749, lng: -122.4194 }),
      zoom: 15,
      disableDefaultUI: true,
      zoomControl: true,
      gestureHandling: 'greedy',
      clickableIcons: false,
      keyboardShortcuts: false,
      ...(gm.ColorScheme ? { colorScheme: dark ? gm.ColorScheme.DARK : gm.ColorScheme.LIGHT } : {}),
    });
    layer = makeLayer(gm);
    layer.setMap(map);
    fit();
    status.value = 'ready';
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
});
onBeforeUnmount(() => {
  offAuth?.();
  layer?.setMap(null);
  layer = null;
  map = null;
});

// 地点变了（附近搜索的结果到了、定位到了）：重新摆，点的集合变了就重新取景
watch(
  () => [drawn.value.map((p) => p.id).join(','), props.you?.lat, props.you?.lng].join('|'),
  (now, before) => {
    project();
    if (now.split('|')[0] !== before?.split('|')[0] || !before) fit();
  },
);
watch(
  () => props.focus,
  (id) => {
    const p = drawn.value.find((x) => x.id === id);
    if (p && map) map.panTo({ lat: p.lat!, lng: p.lng! });
  },
);

/** 跟着你的她们：挂在你们在的那个地点旁边 */
const companions = computed(() => props.characters.filter((c) => c.locationId && pos[c.locationId]));
/** 没有定位时把"你"标在你在的地点 */
const youBadge = computed(() => (!props.you && props.youAt && pos[props.youAt] ? pos[props.youAt] : null));
const px = (id: string) => pos[id] ?? { x: -9999, y: -9999 };
</script>

<template>
  <div class="real-map" role="group" aria-label="我的世界（Google 地图）" data-testid="real-map">
    <div ref="box" class="gmap" />
    <Teleport v-if="layerEl" :to="layerEl">
      <button
        v-for="l in drawn"
        :key="l.id"
        type="button"
        class="rm-pin"
        :class="{ focus: focus === l.id, marked: marked.includes(l.id), home: l.id === 'real:home' }"
        :style="{ left: `${px(l.id).x}px`, top: `${px(l.id).y}px`, '--tone': tone(l) }"
        :aria-label="`${l.name}：${l.activities.map((a) => a.label).join('、')}`"
        :data-loc="l.id"
        @click.stop="emit('select-location', l)"
      >
        <span class="pin-dot"><span :class="l.icon" /></span>
        <span class="pin-label">{{ l.name }}</span>
      </button>
      <span v-if="you && pos.__you" class="rm-me" :style="{ left: `${pos.__you.x}px`, top: `${pos.__you.y}px` }" aria-label="你在这里" />
      <span v-if="youBadge" class="rm-you" :style="{ left: `${youBadge.x}px`, top: `${youBadge.y}px` }">你</span>
      <button
        v-for="(c, i) in companions"
        :key="c.id"
        type="button"
        class="rm-who"
        :style="{ left: `${px(c.locationId!).x + 18 + i * 22}px`, top: `${px(c.locationId!).y - 22}px` }"
        :aria-label="`${c.name}和你在一起`"
        @click.stop="emit('select-character', c)"
      >
        <Avatar :character="c" :size="32" live />
      </button>
    </Teleport>
    <div v-if="status !== 'ready'" class="rm-state" :class="{ bad: status === 'error' }">
      <span :class="status === 'loading' ? 'i-lucide-loader-circle spin' : 'i-lucide-map-pin-off'" />
      <span>{{ status === 'loading' ? '正在加载 Google 地图…' : error }}</span>
    </div>
  </div>
</template>

<style scoped>
.real-map {
  position: relative;
  width: 100%;
  aspect-ratio: 4 / 3;
  border-radius: 22px;
  overflow: hidden;
  background: var(--map-land);
  isolation: isolate;
}
.gmap {
  position: absolute;
  inset: 0;
}
.rm-state {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 16px;
  text-align: center;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--ink-2);
  background: var(--map-land);
}
.rm-state.bad {
  color: var(--bad);
}
.spin {
  animation: spin 1s linear infinite;
}
.rm-pin {
  position: absolute;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  transform: translate(-50%, -15px);
  -webkit-tap-highlight-color: transparent;
}
.rm-pin.home {
  z-index: 2;
}
.pin-dot {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--surface);
  border: 2px solid var(--tone);
  color: var(--tone);
  font-size: 15px;
  box-shadow: var(--shadow-sm);
  transition: transform 0.2s var(--ease);
}
.rm-pin:active .pin-dot {
  transform: scale(0.9);
}
.rm-pin.focus .pin-dot {
  box-shadow:
    0 0 0 4px var(--accent-soft),
    var(--shadow-sm);
  animation: breathe 2.4s ease-in-out infinite;
}
.rm-pin.marked .pin-dot {
  position: relative;
}
.rm-pin.marked .pin-dot::after {
  content: '';
  position: absolute;
  top: -3px;
  right: -3px;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 2px var(--surface);
}
.pin-label {
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  padding: 0 5px;
  border-radius: 6px;
  background: var(--glass-strong);
  color: var(--ink);
  font-size: 10.5px;
  line-height: 15px;
  white-space: nowrap;
}
/* 你此刻的位置：蓝点 */
.rm-me {
  position: absolute;
  z-index: 3;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #3b82f6;
  border: 2px solid #fff;
  transform: translate(-50%, -50%);
  box-shadow: 0 0 0 6px rgba(59, 130, 246, 0.22);
}
.rm-you {
  position: absolute;
  z-index: 3;
  transform: translate(calc(-50% - 18px), calc(-50% - 26px));
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 11px;
  font-weight: 700;
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.rm-who {
  position: absolute;
  z-index: 4;
  transform: translate(-50%, -50%);
  border-radius: 50%;
  box-shadow:
    0 0 0 2px var(--surface),
    0 4px 10px rgba(0, 0, 0, 0.35);
}
</style>
