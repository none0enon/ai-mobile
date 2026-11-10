import { getScene, type MapLocation } from '@app/shared';
import type { InjectionKey, Ref } from 'vue';

/** 当前场景发生在地图上的哪个地点：ScenePage 决定，SceneShell 和各场景读取 */
export const SCENE_LOCATION: InjectionKey<Ref<MapLocation | null>> = Symbol('scene-location');

/** 场景背景：家里按房间（卧室、餐桌、客厅……）用场景自己的背景，其他地点用地点的背景 */
export function backdropAt(loc: MapLocation | null | undefined, sceneId: string): string {
  const scene = getScene(sceneId);
  if (!loc || loc.area === 'home') return scene.backdrop;
  return loc.backdrop;
}

/** 场景标题：图书馆 · 陪伴学习；家里只写房间：卧室 · 哄睡 */
export function titleAt(loc: MapLocation | null | undefined, sceneId: string): string {
  const scene = getScene(sceneId);
  const label = loc?.activities.find((a) => a.sceneId === sceneId)?.label;
  if (!loc) return scene.name;
  if (loc.area === 'home') return label ?? scene.name;
  return `${loc.name} · ${label ?? scene.name}`;
}
