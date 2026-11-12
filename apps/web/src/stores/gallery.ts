import { errorReport, errorText, isAbortError } from '@app/ai';
import { getLocation, momentLabel, rhythmDate, sceneImageUse } from '@app/shared';
import { defineStore } from 'pinia';
import { reactive, ref } from 'vue';
import { useAiStore } from './ai';
import { useCharacterStore } from './characters';
import { useRhythmStore } from './rhythm';
import { autoSave, getAll, getOne, write } from '@/db/idb';
import { services } from '@/services';
import { uid } from '@/utils/id';

/**
 * 图库（设计文档 §10.6 的第一步）：一起做事时画的图都记下来——哪个角色、哪个场景、哪个时刻、在哪、穿的什么、哪天。
 * - 进场景时先在图库里找今天同一个地方、同一身衣服画过的，有就直接用，不重新画；
 * - 画图排队（所有出图一次一张，你点的排在自动的前面，见 services/ai.ts）；
 * - 自动画可以关（场景右上角）。NovelAI 只在不花点的设置下自动画（§10.2）。
 * 图片本身存在本机素材库（按内容哈希），这里只记索引。
 */

export interface GalleryItem {
  id: string;
  characterId: string;
  sceneId: string;
  /** 时刻：seat / peek / reward…… */
  moment: string;
  /** 要画的画面（中文） */
  caption: string;
  /** 生图提示词智能体起的标题 */
  title: string;
  assetKey: string | null;
  url?: string;
  prompt: string;
  negative: string;
  seed: number | null;
  model: string;
  locationId: string | null;
  outfit: string | null;
  /** 节律日 */
  day: string;
  at: number;
}

export interface SceneDrawRequest {
  characterId: string;
  sceneId: string;
  moment: string;
  caption: string;
  /** user：你点的（排在前面）；auto：场景自己画的 */
  priority: 'user' | 'auto';
  locationId?: string | null;
  expression?: string | null;
  recent?: string[];
}

/** 一个场景此刻在画什么 */
export interface DrawingState {
  moment: string;
  stage: 'queued' | 'prompt' | 'image';
  priority: 'user' | 'auto';
}

const KEEP = 400;

export const useGalleryStore = defineStore('gallery', () => {
  const items = ref<GalleryItem[]>([]);
  /** 场景自动画图（默认开）；关了只在你点"看她一眼"之类时画 */
  const autoDraw = ref(true);
  /** 正在画的：按"角色:场景" */
  const drawing = reactive<Record<string, DrawingState | undefined>>({});
  /** 上一次没画出来：按"角色:场景" */
  const failures = reactive<Record<string, { moment: string; reason: string; detail: string } | undefined>>({});

  const saver = autoSave('gallery', () => items.value.map((i) => ({ key: i.id, value: i })), items);
  const settingSaver = autoSave('settings', () => [{ key: 'sceneAutoDraw', value: autoDraw.value }], autoDraw);

  async function hydrate() {
    const [list, auto] = await Promise.all([getAll<GalleryItem>('gallery'), getOne<boolean>('settings', 'sceneAutoDraw')]);
    items.value = list.filter((i) => i && i.id).sort((a, b) => a.at - b.at);
    if (typeof auto === 'boolean') autoDraw.value = auto;
    // 太多了删最旧的索引（图片还在素材库里）
    if (items.value.length > KEEP) {
      const drop = items.value.slice(0, items.value.length - KEEP);
      items.value = items.value.slice(-KEEP);
      await write('gallery', [], drop.map((d) => d.id));
    }
    saver.start();
    settingSaver.start();
  }

  const key = (characterId: string, sceneId: string) => `${characterId}:${sceneId}`;

  /** 这个角色在这个场景里画过的，最新的在前（today：只要今天的；sameLook：同一个地方、同一身衣服） */
  function find(characterId: string, sceneId: string, opts: { moment?: string; today?: boolean; locationId?: string | null; outfit?: string | null } = {}): GalleryItem[] {
    const day = rhythmDate(new Date());
    return items.value
      .filter(
        (i) =>
          i.characterId === characterId &&
          i.sceneId === sceneId &&
          (!opts.moment || i.moment === opts.moment) &&
          (!opts.today || i.day === day) &&
          (opts.locationId === undefined || i.locationId === opts.locationId) &&
          (opts.outfit === undefined || i.outfit === opts.outfit),
      )
      .sort((a, b) => b.at - a.at);
  }

  /**
   * 能不能自动画：生图接通了、自动画开着；NovelAI 只在不花点的设置下（步数不超过 28、不用 V5；尺寸和张数程序本来就守着）
   */
  function autoCheck(): { ok: true } | { ok: false; reason: string } {
    if (!autoDraw.value) return { ok: false, reason: '自动画关着' };
    const ai = useAiStore();
    const s = ai.status('image');
    if (!s.live) return { ok: false, reason: `生图 API 还没接通：${s.reason}` };
    const route = ai.effectiveRoute('image');
    if (route.api?.channel === 'novelai') {
      const model = route.api.model || 'nai-diffusion-4-5-full';
      if (/nai-diffusion-5/.test(model)) return { ok: false, reason: 'V5 有用量上限，自动画只用 V4.5 或更早的模型（点"看一眼"照样能画）' };
      if ((route.imageStyle?.steps ?? 28) > 28) return { ok: false, reason: '步数超过 28 会扣点，自动画先停着（API 设置 → 生图 → 步数改到 28 以内）' };
    }
    return { ok: true };
  }

  function isDrawing(characterId: string, sceneId: string): DrawingState | undefined {
    return drawing[key(characterId, sceneId)];
  }

  /**
   * 画场景里的一个时刻：用这个场景的生图预设（没单独选就跟随配图），衣服锁成节律里今天这个场景该穿的那套。
   * 同一个场景同时只画一张；画好记进图库
   */
  async function draw(req: SceneDrawRequest): Promise<{ ok: true; item: GalleryItem } | { ok: false; reason: string; detail?: string; busy?: boolean }> {
    const k = key(req.characterId, req.sceneId);
    if (drawing[k]) return { ok: false, reason: '正在画上一张', busy: true };
    const c = useCharacterStore().byId(req.characterId);
    if (!c) return { ok: false, reason: '找不到这个角色' };
    const status = useAiStore().status('image');
    if (!status.live) return { ok: false, reason: `生图 API 还没接通：${status.reason}` };
    const outfit = useRhythmStore().outfitFor(c.id, req.sceneId);
    const locationId = req.locationId ?? c.locationId;
    drawing[k] = { moment: req.moment, stage: 'queued', priority: req.priority };
    delete failures[k];
    try {
      const out = await services.image.illustrate(
        {
          characterId: c.id,
          caption: req.caption,
          use: sceneImageUse(req.sceneId),
          moment: req.moment,
          sceneId: req.sceneId,
          lockOutfit: true,
          place: getLocation(locationId)?.name,
          expression: req.expression,
          recent: req.recent,
        },
        {
          priority: req.priority,
          onStage: (stage) => {
            const d = drawing[k];
            if (d) d.stage = stage;
          },
        },
      );
      const item: GalleryItem = {
        id: uid('gal'),
        characterId: c.id,
        sceneId: req.sceneId,
        moment: req.moment,
        caption: req.caption,
        title: out.caption || momentLabel(req.moment) || '',
        assetKey: out.assetKey,
        url: out.url,
        prompt: out.prompt,
        negative: out.negative,
        seed: out.seed,
        model: out.model,
        locationId: locationId ?? null,
        outfit: outfit?.name ?? null,
        day: rhythmDate(new Date()),
        at: Date.now(),
      };
      items.value.push(item);
      return { ok: true, item: items.value.at(-1) as GalleryItem };
    } catch (e) {
      if (isAbortError(e)) return { ok: false, reason: '取消了' };
      failures[k] = { moment: req.moment, reason: errorText(e), detail: errorReport(e) };
      return { ok: false, reason: errorText(e), detail: errorReport(e) };
    } finally {
      delete drawing[k];
    }
  }

  return { items, autoDraw, drawing, failures, hydrate, find, autoCheck, isDrawing, draw };
});
