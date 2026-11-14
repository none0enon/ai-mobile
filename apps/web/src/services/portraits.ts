import {
  autoExpressionForMood,
  defaultHotspotShapes,
  emptyPortraitSet,
  guessFromFileNames,
  guessOutfitKind,
  guessPoseFits,
  hasPortraits,
  labelId,
  type Character,
  type Expression,
  type PokeHotspot,
  type Portrait,
  type PortraitSet,
} from '@app/shared';
import { assetUrl, dropAsset, putAsset } from './assets';
import { pokeHotspots } from '@/mock/library';
import { uid } from '@/utils/id';
import { compressPortrait } from '@/utils/image';

/**
 * 立绘的导入、删除、显示前的准备（挑哪张见 @app/shared 的 pickPortrait）。
 * 图片压好后存进本机素材库（按内容哈希，同一张图导两次只存一份），角色上只记元数据。
 */

export function ensurePortraitSet(c: Character): PortraitSet {
  c.portraits ??= emptyPortraitSet();
  return c.portraits;
}

/** 她的表情：按名字找，没有就新建（她的第一个表情当默认表情） */
export function ensureExpression(set: PortraitSet, label: string): string {
  const found = set.expressions.find((e) => e.label === label || e.id === label);
  if (found) return found.id;
  const id = labelId(label, set.expressions.map((e) => e.id));
  set.expressions.push({ id, label });
  if (!set.defaultExpression) set.defaultExpression = id;
  return id;
}

export function ensurePose(set: PortraitSet, label: string): string {
  const found = set.poses.find((p) => p.label === label || p.id === label);
  if (found) return found.id;
  const id = labelId(label, set.poses.map((p) => p.id));
  const fits = guessPoseFits(label);
  set.poses.push({ id, label, ...(fits.length ? { fits } : {}) });
  if (!set.defaultPose) set.defaultPose = id;
  return id;
}

export function ensureOutfit(set: PortraitSet, label: string): string {
  const found = set.outfits.find((o) => o.label === label || o.id === label);
  if (found) return found.id;
  const id = labelId(label, set.outfits.map((o) => o.id));
  const kind = guessOutfitKind(label);
  set.outfits.push({ id, label, ...(kind ? { kind } : {}) });
  if (!set.defaultOutfit) set.defaultOutfit = id;
  return id;
}

export interface ImportResult {
  added: Portrait[];
  skipped: string[];
  failed: { name: string; error: string }[];
}

/**
 * 批量导入：按文件名猜表情 / 动作 / 服装（{服装}_{动作}_{表情}、ST 表情文件夹的 joy.png……），猜不出的先空着（未标），导入后自己选。
 * 第一次导入时立绘框的比例按第一张图定。
 */
export async function importPortraits(c: Character, files: File[], progress?: (done: number, total: number) => void): Promise<ImportResult> {
  const set = ensurePortraitSet(c);
  const result: ImportResult = { added: [], skipped: [], failed: [] };
  const images = files.filter((f) => f.type.startsWith('image/') || /\.(png|webp|jpe?g|avif|gif)$/i.test(f.name));
  for (const f of files) if (!images.includes(f)) result.failed.push({ name: f.name, error: '不是图片' });
  const guesses = guessFromFileNames(
    images.map((f) => f.name),
    set,
    [c.name, c.fandom?.characterTag ?? ''],
  );
  const first = !set.portraits.length;
  const hadExpressions = set.expressions.length > 0;
  const hadPoses = set.poses.length > 0;
  const hadOutfits = set.outfits.length > 0;
  for (const [i, file] of images.entries()) {
    try {
      const img = await compressPortrait(file);
      const assetKey = await putAsset(img.bytes, img.mime);
      if (set.portraits.some((p) => p.assetKey === assetKey)) {
        result.skipped.push(file.name);
        continue;
      }
      const g = guesses[i] ?? {};
      const expression = g.expression ? (g.expression.id ?? ensureExpression(set, g.expression.label)) : '';
      const pose = g.pose ? (g.pose.id ?? ensurePose(set, g.pose.label)) : set.defaultPose;
      const outfit = g.outfit ? (g.outfit.id ?? ensureOutfit(set, g.outfit.label)) : set.defaultOutfit;
      const p: Portrait = {
        id: uid('pt'),
        assetKey,
        name: file.name.replace(/\.[a-z0-9]{2,5}$/i, ''),
        width: img.width,
        height: img.height,
        expression,
        pose,
        outfit,
      };
      if (first && !result.added.length) set.aspect = Math.round((img.width / img.height) * 1000) / 1000;
      set.portraits.push(p);
      result.added.push(p);
    } catch (e) {
      result.failed.push({ name: file.name, error: e instanceof Error ? e.message : String(e) });
    } finally {
      progress?.(i + 1, images.length);
    }
  }
  // 第一次分出表情 / 动作 / 服装时，默认的取图最多的那个（文件的先后不算数）；表情有名字是"平静"一类的先用它
  if (!hadExpressions && set.expressions.length) set.defaultExpression = autoExpressionForMood('neutral', set) || mostUsed(set, 'expression') || set.defaultExpression;
  if (!hadPoses && set.poses.length) set.defaultPose = mostUsed(set, 'pose') || set.defaultPose;
  if (!hadOutfits && set.outfits.length) set.defaultOutfit = mostUsed(set, 'outfit') || set.defaultOutfit;
  if (result.added.length) c.updatedAt = Date.now();
  return result;
}

function mostUsed(set: PortraitSet, k: 'expression' | 'pose' | 'outfit'): string {
  const n = new Map<string, number>();
  for (const p of set.portraits) if (p[k]) n.set(p[k], (n.get(p[k]) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
}

/** 删一张；别的角色都没用这张图时，本机素材库里的文件也删掉 */
export async function removePortrait(c: Character, id: string, everyone: Character[]): Promise<void> {
  const set = c.portraits;
  const p = set?.portraits.find((x) => x.id === id);
  if (!set || !p) return;
  set.portraits = set.portraits.filter((x) => x.id !== id);
  c.updatedAt = Date.now();
  if (!everyone.some((o) => o.portraits?.portraits.some((x) => x.assetKey === p.assetKey))) await dropAsset(p.assetKey);
}

/**
 * 改名字：id 跟着名字走（模型写的是 id，[expr:坏笑] 比 [expr:新表情] 好懂），用着它的图、默认值、热区一起改过来。返回新的 id
 */
export function renameLabel(c: Character, kind: 'expression' | 'pose' | 'outfit', id: string, label: string): string {
  const set = c.portraits;
  const name = label.trim();
  if (!set || !name) return id;
  const list: { id: string; label: string }[] = kind === 'expression' ? set.expressions : kind === 'pose' ? set.poses : set.outfits;
  const item = list.find((x) => x.id === id);
  if (!item) return id;
  item.label = name;
  const next = labelId(name, list.filter((x) => x !== item).map((x) => x.id));
  if (next !== id) {
    item.id = next;
    for (const p of set.portraits) if (p[kind] === id) p[kind] = next;
    if (kind === 'pose' && set.defaultPose === id) set.defaultPose = next;
    if (kind === 'outfit' && set.defaultOutfit === id) set.defaultOutfit = next;
    if (kind === 'expression') {
      if (set.defaultExpression === id) set.defaultExpression = next;
      const moments = set.moments ?? {};
      for (const m of Object.keys(moments) as Expression[]) if (moments[m] === id) moments[m] = next;
      for (const h of set.hotspots ?? []) {
        if (h.tap.expression === id) h.tap.expression = next;
        if (h.longPress?.expression === id) h.longPress.expression = next;
      }
    }
  }
  c.updatedAt = Date.now();
  return next;
}

/** 删一个表情 / 动作 / 服装：用着它的图改成未标 / 默认动作 / 默认服装；图不删 */
export function removeLabel(c: Character, kind: 'expression' | 'pose' | 'outfit', id: string): void {
  const set = c.portraits;
  if (!set) return;
  if (kind === 'expression') {
    set.expressions = set.expressions.filter((e) => e.id !== id);
    if (set.defaultExpression === id) set.defaultExpression = set.expressions[0]?.id ?? '';
    const moments = set.moments ?? {};
    for (const m of Object.keys(moments) as Expression[]) if (moments[m] === id) delete moments[m];
    for (const p of set.portraits) if (p.expression === id) p.expression = '';
  } else if (kind === 'pose') {
    set.poses = set.poses.filter((x) => x.id !== id);
    if (set.defaultPose === id) set.defaultPose = set.poses[0]?.id ?? '';
    for (const p of set.portraits) if (p.pose === id) p.pose = set.defaultPose;
  } else {
    set.outfits = set.outfits.filter((x) => x.id !== id);
    if (set.defaultOutfit === id) set.defaultOutfit = set.outfits[0]?.id ?? '';
    for (const p of set.portraits) if (p.outfit === id) p.outfit = set.defaultOutfit;
  }
  c.updatedAt = Date.now();
}

/** 戳戳乐热区：自己画过的 → 有立绘时按脸的位置摆一套 → 占位立绘的那套 */
export function hotspotsOf(c: Character | undefined): PokeHotspot[] {
  const set = c?.portraits;
  if (!hasPortraits(set)) return pokeHotspots;
  if (set.hotspots?.length) return set.hotspots;
  const shapes = defaultHotspotShapes(set);
  return pokeHotspots.map((h) => ({ ...h, shape: shapes[h.id as keyof typeof shapes] ?? h.shape }));
}

const decoded = new Map<string, Promise<string | null>>();

/** 取一张立绘的地址并解码好（切换时先解码再换上，不会闪一下空白） */
export function portraitSrc(assetKey: string): Promise<string | null> {
  let task = decoded.get(assetKey);
  if (!task) {
    task = (async () => {
      const url = await assetUrl(assetKey);
      if (!url) return null;
      const img = new Image();
      img.src = url;
      try {
        await img.decode();
      } catch {
        // 解码失败时照样交给 <img>，显示不出来时由它显示占位
      }
      return url;
    })();
    decoded.set(assetKey, task);
    // 找不到的不缓存：可能是还没写进本机
    void task.then((u) => {
      if (!u) decoded.delete(assetKey);
    });
  }
  return task;
}

/** 立绘框的宽高比：有立绘时按立绘，没有时是占位立绘的 600:1000 */
export function portraitAspect(c: Character | undefined): number {
  const set = c?.portraits;
  return hasPortraits(set) && set.aspect > 0 ? set.aspect : 0.6;
}
