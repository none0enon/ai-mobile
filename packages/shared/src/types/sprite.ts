import type { SyncMeta } from './common.ts';

/** 一张立绘：服装 × 姿势 × 表情 */
export interface SpriteImage {
  outfit: string;
  pose: string;
  expression: string;
  assetKey: string;
}

/** 坐标都是相对立绘图片框的 0-1 比例，和图片分辨率无关 */
export type HotspotShape =
  | { kind: 'rect'; x: number; y: number; w: number; h: number }
  | { kind: 'polygon'; points: [number, number][] };

export interface PokeReaction {
  expression: string;
  /** 本地台词池：点击后立刻随机出一句（零延迟），AI 反应稍后再来 */
  lines: string[];
}

/** 戳戳乐热区 */
export interface PokeHotspot {
  id: string;
  /** head / cheek / shoulder / hand …，会写进"你拍了拍她的头"和给 AI 的提示 */
  part: string;
  label: string;
  shape: HotspotShape;
  tap: PokeReaction;
  longPress?: PokeReaction;
}

export interface SpriteSet extends SyncMeta {
  characterId: string;
  name: string;
  outfits: string[];
  poses: string[];
  expressions: string[];
  images: SpriteImage[];
  hotspots: PokeHotspot[];
  defaultOutfit: string;
  defaultPose: string;
}

/**
 * 缺图回退顺序：精确匹配 → 同服装同姿势 neutral → 同服装默认姿势 neutral → 默认服装默认姿势 neutral。
 * 立绘按 {服装}_{姿势}_{表情}.webp 批量导入。
 */
export function resolveSprite(
  set: Pick<SpriteSet, 'images' | 'defaultOutfit' | 'defaultPose'>,
  want: { outfit?: string; pose?: string; expression?: string },
): SpriteImage | null {
  const outfit = want.outfit ?? set.defaultOutfit;
  const pose = want.pose ?? set.defaultPose;
  const expression = want.expression ?? 'neutral';
  const find = (o: string, p: string, e: string) =>
    set.images.find((img) => img.outfit === o && img.pose === p && img.expression === e) ?? null;
  return (
    find(outfit, pose, expression) ??
    find(outfit, pose, 'neutral') ??
    find(outfit, set.defaultPose, 'neutral') ??
    find(set.defaultOutfit, set.defaultPose, 'neutral')
  );
}
