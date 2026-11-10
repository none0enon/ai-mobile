<script setup lang="ts">
import { getLocation, SCENES, type Character, type MapLocation, type World } from '@app/shared';
import { computed } from 'vue';
import Avatar from '@/components/common/Avatar.vue';

/**
 * 一个角色的小世界：底图按 world.base 画（配色跟随主题），地点是 world.locations，
 * 她的头像标在她此刻所在的地方。你和她正在这个世界里一起做事时，旁边标一个"你"。
 * 点地点 / 点头像由外面决定做什么（打开底部面板、一起去……）。
 * compact：小缩略图，只画底图和小头像，不可点。
 * 地点坐标是 0-100 的百分比，和 400×300 的底图对齐。
 */
const props = withDefaults(
  defineProps<{ world: World; characters: Character[]; youAt?: string | null; compact?: boolean; focus?: string | null }>(),
  { youAt: null, compact: false, focus: null },
);
const emit = defineEmits<{
  (e: 'select-location', loc: MapLocation): void;
  (e: 'select-character', c: Character): void;
}>();

const TINT: Record<string, string> = Object.fromEntries(SCENES.map((s) => [s.id, s.tint]));
function tone(l: MapLocation) {
  return l.area === 'home' || l.id === props.world.homeId ? '#f5b8a6' : (TINT[l.activities[0]?.sceneId ?? ''] ?? '#b9adce');
}

const inWorld = (id: string | null | undefined) => !!id && props.world.locations.some((l) => l.id === id);

/** 每个地点上有谁（只算在这个世界里的） */
const occupants = computed(() => {
  const map = new Map<string, Character[]>();
  for (const c of props.characters) {
    if (c.locationId && inWorld(c.locationId)) map.set(c.locationId, [...(map.get(c.locationId) ?? []), c]);
  }
  return map;
});
const avatarSize = computed(() => (props.compact ? 16 : 34));

/**
 * 地点 = 圆点 + 下面的名字。窄屏、系统大字体时也不让名字被地图边缘裁掉：
 * 靠左 / 靠右的地点名字往里对齐，靠上 / 靠下的地点整体往里收一点。
 */
function pinStyle(l: MapLocation) {
  const tx = l.x < 16 ? '-15px' : l.x > 84 ? 'calc(-100% + 15px)' : '-50%';
  return { left: `${l.x}%`, top: `clamp(25px, ${l.y}%, calc(100% - 27px))`, '--tone': tone(l), transform: `translate(${tx}, -50%)` };
}
function pinClass(l: MapLocation) {
  return { focus: props.focus === l.id, occupied: occupants.value.has(l.id), 'edge-l': l.x < 16, 'edge-r': l.x > 84 };
}

/** 头像挂在地点的右上方；靠近地图边缘时往里收，不被裁掉 */
function whoStyle(locId: string, i: number) {
  const l = getLocation(locId);
  const dx = props.compact ? 4 + i * 10 : 16 + i * 22;
  const dy = props.compact ? 4 : 22;
  const half = avatarSize.value / 2 + 2;
  return {
    left: `clamp(${half}px, calc(${l?.x ?? 0}% + ${dx}px), calc(100% - ${half}px))`,
    top: `clamp(${half}px, calc(${l?.y ?? 0}% - ${dy}px), calc(100% - ${half}px))`,
    transform: 'translate(-50%, -50%)',
  };
}
const you = computed(() => props.world.locations.find((l) => l.id === props.youAt));
</script>

<template>
  <div class="world-map" :class="{ compact }" role="group" :aria-label="world.name">
    <svg viewBox="0 0 400 300" class="absolute inset-0 w-full h-full" aria-hidden="true">
      <rect width="400" height="300" class="land" />
      <template v-for="(sh, i) in world.base" :key="i">
        <rect v-if="sh.kind === 'rect'" :x="sh.x" :y="sh.y" :width="sh.w" :height="sh.h" :rx="sh.r" :class="sh.cls" />
        <path v-else-if="sh.kind === 'path'" :d="sh.d" :class="sh.cls" />
        <ellipse v-else-if="sh.kind === 'ellipse'" :cx="sh.cx" :cy="sh.cy" :rx="sh.rx" :ry="sh.ry" :class="sh.cls" />
        <circle v-else :cx="sh.cx" :cy="sh.cy" :r="sh.r" :class="sh.cls" />
      </template>
      <g v-if="!compact" class="area-text">
        <text v-for="t in world.labels" :key="t.text" :x="t.x" :y="t.y">{{ t.text }}</text>
      </g>
    </svg>

    <!-- 地点 -->
    <template v-if="!compact">
      <button
        v-for="l in world.locations"
        :key="l.id"
        class="pin"
        :class="pinClass(l)"
        :style="pinStyle(l)"
        :aria-label="`${l.name}：${l.activities.map((a) => a.label).join('、')}`"
        :data-loc="l.id"
        @click="emit('select-location', l)"
      >
        <span class="pin-dot"><span :class="l.icon" /></span>
        <span class="pin-label">{{ l.name }}</span>
      </button>
    </template>

    <!-- 你（和她一起在这个世界里时） -->
    <span v-if="you && !compact" class="you" :style="{ left: `${you.x}%`, top: `${you.y}%` }">你</span>

    <!-- 她在哪 -->
    <template v-for="[locId, list] in occupants" :key="locId">
      <component
        :is="compact ? 'span' : 'button'"
        v-for="(c, i) in list"
        :key="c.id"
        class="who"
        :style="whoStyle(locId, i)"
        :aria-label="compact ? undefined : `${c.name}在${getLocation(locId)?.name}`"
        @click="!compact && emit('select-character', c)"
      >
        <Avatar :character="c" :size="avatarSize" live />
      </component>
    </template>
  </div>
</template>

<style scoped>
.world-map {
  position: relative;
  width: 100%;
  aspect-ratio: 4 / 3;
  border-radius: 22px;
  overflow: hidden;
  background: var(--map-land);
  isolation: isolate;
}
.land {
  fill: var(--map-land);
}
.home {
  fill: var(--map-home);
}
.campus {
  fill: var(--map-campus);
}
.park {
  fill: var(--map-park);
}
.water,
.pool {
  fill: var(--map-water);
}
.river {
  fill: none;
  stroke: var(--map-water);
  stroke-width: 16;
  stroke-linecap: round;
}
.road {
  fill: none;
  stroke: var(--map-road);
  stroke-width: 8;
  stroke-linecap: round;
}
.road-line {
  fill: none;
  stroke: var(--map-land);
  stroke-width: 1.2;
  stroke-dasharray: 4 6;
  opacity: 0.8;
}
.bldg {
  fill: var(--map-block);
}
.roof {
  fill: var(--map-road);
}
.track {
  fill: var(--map-park);
  stroke: var(--map-road);
  stroke-width: 6;
}
.wheel {
  fill: none;
  stroke: var(--map-block);
  stroke-width: 5;
}
.wheel-spoke {
  stroke: var(--map-block);
  stroke-width: 2.5;
}
.area-text text {
  fill: var(--ink-3);
  font-size: 11px;
  letter-spacing: 0.1em;
}
.pin {
  position: absolute;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  transform: translate(-50%, -50%);
  -webkit-tap-highlight-color: transparent;
}
.pin.edge-l {
  align-items: flex-start;
}
.pin.edge-r {
  align-items: flex-end;
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
.pin:active .pin-dot {
  transform: scale(0.9);
}
.pin.focus .pin-dot {
  box-shadow:
    0 0 0 4px var(--accent-soft),
    var(--shadow-sm);
  animation: breathe 2.4s ease-in-out infinite;
}
.pin-label {
  padding: 0 5px;
  border-radius: 6px;
  background: var(--glass-strong);
  color: var(--ink);
  font-size: 10.5px;
  line-height: 15px;
  white-space: nowrap;
}
.who {
  position: absolute;
  z-index: 2;
  border-radius: 50%;
  box-shadow:
    0 0 0 2px var(--surface),
    0 4px 10px rgba(0, 0, 0, 0.35);
}
.you {
  position: absolute;
  z-index: 2;
  transform: translate(calc(-50% - 18px), calc(-50% - 20px));
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
.compact {
  border-radius: 10px;
}
.compact .who {
  box-shadow:
    0 0 0 1.5px var(--surface),
    0 2px 5px rgba(0, 0, 0, 0.3);
}
</style>
