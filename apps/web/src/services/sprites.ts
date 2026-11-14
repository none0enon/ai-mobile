import {
  AiError,
  buildSpriteMessages,
  canEditImage,
  kindOf,
  NOVELAI_REFERENCE_CANVASES,
  parseSpriteLabel,
  parseSpriteLooks,
  samplerRequest,
  type ImageRequest,
  type SpriteFill,
  type SpriteLabelTags,
  type SpriteLooks,
} from '@app/ai';
import {
  imageAppearance,
  isFandom,
  isSpritePreset,
  joinTags,
  OUTFIT_KINDS,
  SPRITE_EXPR,
  SPRITE_POSE,
  spriteBaseLabel,
  spriteFramings,
  spriteLabels,
  spriteParams,
  spritePrompt,
  type Character,
  type OutfitKind,
  type Portrait,
  type PortraitGen,
  type Preset,
  type SpriteFraming,
  type SpriteLabel,
  type SpriteParams,
  type SpriteTask,
} from '@app/shared';
import { enqueueImage } from './ai';
import { assetUrl } from './assets';
import { characterLines, sourceLines } from './characterSource';
import { addGeneratedPortrait, ensurePortraitSet, ensureOutfit } from './portraits';
import { useAiStore } from '@/stores/ai';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';
import { useLibraryStore } from '@/stores/library';
import { usePersonaStore } from '@/stores/personas';
import { useRhythmStore } from '@/stores/rhythm';
import { alignFit, alphaInfo, faceInImage, novelaiImage, rectMask, referenceImage, type FaceGuess } from '@/utils/spriteImage';

/**
 * AI 画立绘（设计文档 §10.4，"角色 → 立绘 → AI 画立绘"）。怎么画全在立绘预设里（@app/shared 的 spritePreset.ts）：
 * 1. 外观 tags：缺的话交给"生图提示词"按立绘预设的 sprite-tags 任务写（先给你看，确认后才存）；
 * 2. 底图：按画法拼提示词（长相 + 这身衣服 + 构图 + 底图的动作和表情，默认半身、平静、站立），NovelAI V5 直接画透明背景；
 *    画出来不是透明底（V4.5、公益站……）时按预设用 Director Tools 去背景；给了参考图时用 V4.5 的精准参考照着画；
 *    构图（半身、全身……）是立绘预设里的块：App 里平时用半身立绘（立绘框、头像框的默认值都是按半身定的），全身也能画；
 * 3. 照着底图换表情：只重画脸（局部重绘，遮罩是头像框放大几倍，身子一像素不动）/ Director Tools 换表情 / 整张图生图；
 * 4. 照着底图换动作：精准参考（V4.5）/ 同一个种子换动作 tags 重画；画完对齐到立绘框（按透明轮廓猜的脸对上头像框）。
 * 换表情、换动作都沿用底图的构图。和这个角色平时用的构图不一样的（例如半身的角色画了全身）留着备用、不参与自动挑选，免得换表情时人忽大忽小。
 * 所有出图都排进同一个队列，一次一张。画出来的图存进本机素材库，标好表情、动作、服装，各处按 pickPortrait 挑。
 */

/** 画这身衣服 */
export interface SpriteOutfit {
  name: string;
  tags: string;
  kind?: OutfitKind;
  /** 从哪儿来的：节律今天穿的 / 节律衣柜 / 立绘上已有的服装 */
  from: 'today' | 'wardrobe' | 'portrait';
}

/** 画好还没存的底图（先给你看） */
export interface SpriteDraft {
  bytes: Uint8Array<ArrayBuffer>;
  mime: string;
  width: number;
  height: number;
  /** 本机预览用的地址 */
  url: string;
  transparent: boolean;
  face: FaceGuess | null;
  gen: PortraitGen;
  framing: SpriteFraming | null;
  expression: SpriteLabel | null;
  pose: SpriteLabel | null;
  outfit: SpriteOutfit | null;
}

/** 能不能画、用的什么（界面上那一行） */
export interface SpriteStatus {
  preset: Preset | undefined;
  params: SpriteParams;
  /** 生图接通了 */
  imageLive: boolean;
  imageReason: string;
  /** 能照着图改（换表情、换动作、去背景）：生图用的是 NovelAI */
  canEdit: boolean;
  /** 生图 API 里选的模型 */
  imageModel: string;
  /** 写 tags 的"生图提示词"接通了 */
  promptLive: boolean;
  promptReason: string;
}

export function spritePresetFor(c: Character): Preset | undefined {
  const p = useLibraryStore().presetForUse('sprite', c);
  return p && isSpritePreset(p) ? p : undefined;
}

export function spriteStatus(c: Character): SpriteStatus {
  const ai = useAiStore();
  const preset = spritePresetFor(c);
  const image = ai.status('image');
  const prompt = ai.status('imagePrompt');
  return {
    preset,
    params: spriteParams(preset),
    imageLive: image.live,
    imageReason: image.live ? '' : image.reason,
    canEdit: !!image.api && canEditImage(kindOf(image.api, 'image')),
    imageModel: image.api?.model ?? '',
    promptLive: prompt.live,
    promptReason: prompt.live ? '' : prompt.reason,
  };
}

/** 画之前查一遍：有立绘预设、生图接通了；照着图改的还要是 NovelAI */
function need(c: Character, edit = false): { preset: Preset; params: SpriteParams; canEdit: boolean } {
  const s = spriteStatus(c);
  if (!s.preset) throw new AiError('no_route', '没有立绘预设：去"我的 → 预设 → 立绘"导入或恢复一个');
  if (!s.imageLive) throw new AiError('no_route', `「生图」还没接通：${s.imageReason}`);
  if (edit && !s.canEdit) throw new AiError('unsupported', '照着底图换表情、换动作、去背景要用 NovelAI：在"我的 → API 设置 → 生图"里选 NovelAI');
  return { preset: s.preset, params: s.params, canEdit: s.canEdit };
}

// —— 外观 tags（文本模型）——

function userName(c: Character): string {
  return usePersonaStore().forChat(useChatStore().chatOfCharacter(c.id)).name;
}

/** 写 tags 的输入：角色卡、世界书、现在的长相 */
function lookFills(c: Character): Partial<Record<SpriteFill, string>> {
  const user = userName(c);
  const today = useRhythmStore().outfitFor(c.id, null);
  return {
    spriteCharacter: characterLines(c, user),
    spriteSource: sourceLines(c, user),
    spriteLooks: [
      `现在的外观 tags：${c.appearanceTags.trim() || '（还没有）'}`,
      isFandom(c) ? `同人角色：角色 tag ${c.fandom?.characterTag}，作品 tag ${c.fandom?.copyrightTag || '（没填）'}（NovelAI 认得的话外观 tags 只补它认不全的地方）` : '',
      c.negativeTags.trim() ? `负面 tags：${c.negativeTags.trim()}` : '',
      today ? `今天穿：${today.name}（${today.tags}）` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

async function callSprite<T>(c: Character, task: SpriteTask, ask: string, parse: (v: unknown) => T | null, signal?: AbortSignal): Promise<{ value: T; model: string }> {
  const ai = useAiStore();
  const status = ai.status('imagePrompt');
  if (!status.live) throw new AiError('no_route', `「生图提示词」还没接通：${status.reason}`);
  const preset = spritePresetFor(c);
  if (!preset) throw new AiError('no_route', '没有立绘预设：去"我的 → 预设 → 立绘"导入或恢复一个');
  const messages = buildSpriteMessages({ task, characterName: c.name, userName: userName(c), fills: { ...lookFills(c), spriteAsk: ask } }, preset);
  const { value, result } = await ai.system.json('imagePrompt', { messages, ...samplerRequest(preset.sampler) }, parse, { signal });
  return { value, model: result.model };
}

/** 写外观 tags（还有一套常穿的衣服）：先给你看，"就用这个"再存（applyLooks） */
export function writeLooks(c: Character, signal?: AbortSignal): Promise<{ value: SpriteLooks; model: string }> {
  return callSprite(c, 'sprite-tags', '写外观 tags', parseSpriteLooks, signal);
}

/** 存外观 tags；衣服记成立绘的一套服装（还没有节律衣柜时，画底图默认穿它） */
export function applyLooks(c: Character, looks: SpriteLooks) {
  c.appearanceTags = looks.appearance;
  c.negativeTags = looks.negative;
  if (looks.outfit?.tags) {
    const set = ensurePortraitSet(c);
    const id = ensureOutfit(set, looks.outfit.name);
    const o = set.outfits.find((x) => x.id === id);
    if (o) {
      o.tags = looks.outfit.tags;
      o.kind ??= 'daily';
    }
  }
  c.updatedAt = Date.now();
}

/** 给预设里没有的表情 / 动作写 tags */
export function writeLabelTags(c: Character, kind: 'expression' | 'pose', name: string, signal?: AbortSignal): Promise<{ value: SpriteLabelTags; model: string }> {
  return callSprite(c, 'sprite-label', `${kind === 'expression' ? '表情' : '动作'}：${name}`, parseSpriteLabel, signal);
}

/** 把一个表情 / 动作加进立绘预设（别的角色也能用） */
export function addLabelToPreset(preset: Preset, kind: 'expression' | 'pose', label: SpriteLabel) {
  const prefix = kind === 'expression' ? SPRITE_EXPR : SPRITE_POSE;
  const extra: Record<string, unknown> = {};
  if (label.hint) extra.hint = label.hint;
  if (kind === 'expression' && label.emotion) extra.emotion = label.emotion;
  if (kind === 'pose' && label.fits.length) extra.fits = [...label.fits];
  preset.blocks.push({
    identifier: `custom-${Date.now().toString(36)}`,
    name: `${kind === 'expression' ? '表情' : '动作'} · ${label.name}`,
    role: 'system',
    content: label.tags,
    marker: false,
    enabled: true,
    injection: { position: 'relative', depth: 4 },
    triggers: [`${prefix}${label.name}`],
    ...(Object.keys(extra).length ? { extra } : {}),
  });
  preset.updatedAt = Date.now();
}

// —— 穿哪身 ——

/** 画底图能穿的：节律里今天穿的、节律衣柜里的、立绘上已有的服装（带 tags 的）；同名同 tags 的只留一个 */
export function outfitChoices(c: Character): SpriteOutfit[] {
  const rhythm = useRhythmStore();
  const out: SpriteOutfit[] = [];
  const push = (o: SpriteOutfit) => {
    if (o.tags.trim() && !out.some((x) => x.name === o.name && x.tags === o.tags)) out.push(o);
  };
  const today = rhythm.outfitFor(c.id, null);
  if (today) push({ name: today.name, tags: today.tags, kind: 'daily', from: 'today' });
  for (const w of rhythm.templateOf(c.id)?.wardrobe ?? []) push({ name: w.name, tags: w.tags, kind: w.kind, from: 'wardrobe' });
  for (const o of c.portraits?.outfits ?? []) if (o.tags) push({ name: o.label, tags: o.tags, kind: o.kind, from: 'portrait' });
  return out;
}

export function outfitNote(o: SpriteOutfit): string {
  return { today: '节律 · 今天穿', wardrobe: `衣柜 · ${o.kind ? OUTFIT_KINDS[o.kind] : ''}`, portrait: '立绘的服装' }[o.from];
}

// —— 构图 ——

/** 立绘预设里的构图（半身、全身……） */
export function presetFramings(c: Character): SpriteFraming[] {
  return spriteFramings(spritePresetFor(c));
}

/** 立绘预设里新画底图默认用的构图（出图参数里选的，对不上时第一个） */
function defaultFraming(preset: Preset | undefined): SpriteFraming | null {
  return spriteBaseLabel(spriteFramings(preset), spriteParams(preset).framing) ?? null;
}

/**
 * 这个角色平时用哪种构图：第一张 AI 底图定的（PortraitSet.framing）；还没有立绘、或者没记过（只有导入的图）时用立绘预设的默认构图（半身）
 */
export function mainFraming(c: Character): string {
  const set = c.portraits;
  return (set?.portraits.length ? set.framing : '') || defaultFraming(spritePresetFor(c))?.name || '';
}

/** 一张立绘是哪种构图：AI 画的记着；导入的当作这个角色平时用的那种 */
export function framingOf(c: Character, p: Portrait): string {
  return p.gen?.framing || mainFraming(c);
}

/** 预设里叫这个名字的构图；没有时（预设里改了名、删了）用默认的 */
function framingNamed(preset: Preset, name: string | undefined): SpriteFraming | null {
  return spriteFramings(preset).find((f) => f.name === name) ?? defaultFraming(preset);
}

// —— 画 ——

async function assetBlob(key: string): Promise<Blob> {
  const url = await assetUrl(key);
  if (!url) throw new AiError('empty', '本机找不到这张立绘了，重新导入或重画一张');
  return (await fetch(url)).blob();
}

/** 底图之外画的那几张照着哪张：选过的 → 最近画的底图 */
export function baseOf(c: Character): Portrait | null {
  const set = c.portraits;
  if (!set?.portraits.length) return null;
  const picked = set.genBase ? set.portraits.find((p) => p.id === set.genBase) : undefined;
  if (picked) return picked;
  return [...set.portraits].reverse().find((p) => p.gen?.method === 'base') ?? null;
}

export function setBase(c: Character, portraitId: string) {
  const set = c.portraits;
  if (!set?.portraits.some((p) => p.id === portraitId)) return;
  set.genBase = portraitId;
  c.updatedAt = Date.now();
}

/** 换表情、换动作时的提示词：长相 + 底图那身衣服 + 底图的构图 + 底图的动作 / 表情（预设里同名的那个），换掉要换的那一样 */
function promptFrom(c: Character, preset: Preset, base: Portrait, framing: SpriteFraming | null, change: { expression?: string; pose?: string }) {
  const set = c.portraits;
  const outfit = set?.outfits.find((o) => o.id === base.outfit);
  const wardrobe = outfit && !outfit.tags ? outfitChoices(c).find((o) => o.name === outfit.label) : undefined;
  const label = (kind: 'expression' | 'pose', id: string) => {
    const list: { id: string; label: string }[] = kind === 'expression' ? (set?.expressions ?? []) : (set?.poses ?? []);
    const name = list.find((x) => x.id === id)?.label ?? id;
    return spriteLabels(preset, kind).find((l) => l.name === name)?.tags ?? '';
  };
  return spritePrompt(preset, {
    name: c.name,
    appearance: imageAppearance(c),
    outfit: outfit?.tags ?? wardrobe?.tags ?? '',
    framing,
    expression: change.expression ?? label('expression', base.expression),
    pose: change.pose ?? label('pose', base.pose),
    negative: c.negativeTags,
  });
}

/** 画底图用的模型（照着它局部重绘时用它的重绘版）：底图是画出来的就用当时的，导入的用预设里的 */
function modelOf(base: Portrait, params: SpriteParams): string | undefined {
  const m = base.gen && base.gen.method !== 'emotion' ? base.gen.model.replace(/-inpainting$/, '') : '';
  return m || params.model || undefined;
}

function drawParams(params: SpriteParams): Pick<ImageRequest, 'steps' | 'scale' | 'sampler' | 'noiseSchedule' | 'extra'> {
  return { steps: params.steps, scale: params.scale, sampler: params.sampler, noiseSchedule: params.noiseSchedule, extra: params.extra };
}

interface Finished {
  bytes: Uint8Array<ArrayBuffer>;
  mime: string;
  width: number;
  height: number;
  transparent: boolean;
  face: FaceGuess | null;
  removedBg: boolean;
}

/**
 * 画完：看是不是透明底；不是、预设又开着去背景时，用 Director Tools 去背景（生图不是 NovelAI 时去不了，原样返回）。
 * 脸按这种构图的头身比猜（半身的头大、全身的头小）
 */
async function finish(
  bytes: Uint8Array<ArrayBuffer> | null,
  mime: string,
  params: SpriteParams,
  opts: { framing: SpriteFraming | null; compare?: Blob; signal?: AbortSignal; canEdit: boolean },
): Promise<Finished> {
  if (!bytes) throw new AiError('empty', '生图接口返回了，但里面没有图片');
  const headRatio = opts.framing?.headRatio ?? null;
  let blob = new Blob([bytes], { type: mime });
  let info = await alphaInfo(blob, { headRatio, compare: opts.compare });
  if (info.transparent || !params.removeBackground || !opts.canEdit) return { bytes, mime, width: info.width, height: info.height, transparent: info.transparent, face: info.face, removedBg: false };
  const src = await novelaiImage(blob, info.width * info.height);
  const r = await useAiStore().system.augment({ kind: 'bg-removal', image: src.base64, width: src.width, height: src.height, signal: opts.signal });
  if (!r.image.bytes) throw new AiError('empty', '去背景返回了，但里面没有图片');
  blob = new Blob([r.image.bytes], { type: r.image.mime });
  info = await alphaInfo(blob, { headRatio });
  return { bytes: r.image.bytes, mime: r.image.mime, width: info.width, height: info.height, transparent: info.transparent, face: info.face, removedBg: true };
}

/**
 * 画底图（第一张）：长相 + 这身衣服 + 构图 + 底图的动作和表情（预设里的，默认半身、站立、平静），透明背景。先给你看（acceptBase 才存）。
 * framing：构图的名字（不给 = 这个角色平时用的那种）；reference：照着一张图画（V4.5 的精准参考，例如角色卡的原图），画完不是透明底的去背景
 */
export function drawBase(c: Character, opts: { outfit: SpriteOutfit | null; framing?: string; reference?: Blob | null; signal?: AbortSignal } = { outfit: null }): Promise<SpriteDraft> {
  const { preset, params, canEdit } = need(c, !!opts.reference);
  const framing = framingNamed(preset, opts.framing ?? mainFraming(c));
  const expression = spriteBaseLabel(spriteLabels(preset, 'expression'), params.baseExpression) ?? null;
  const pose = spriteBaseLabel(spriteLabels(preset, 'pose'), params.basePose) ?? null;
  const appearance = imageAppearance(c);
  if (!appearance) throw new AiError('empty', `${c.name}还没有外观 tags：先让 AI 写外观 tags（同人角色在"生图"里填角色 tag 也行）`);
  const { prompt, negative } = spritePrompt(preset, { name: c.name, appearance, outfit: opts.outfit?.tags ?? '', framing, expression: expression?.tags ?? '', pose: pose?.tags ?? '', negative: c.negativeTags });
  return enqueueImage(
    'user',
    async () => {
      const ref = opts.reference ? await referenceImage(opts.reference, NOVELAI_REFERENCE_CANVASES) : null;
      const req: ImageRequest = {
        prompt,
        negative,
        size: { width: params.width, height: params.height },
        ...drawParams(params),
        ...(ref ? { references: [{ image: ref, strength: params.referenceStrength, fidelity: params.referenceFidelity }] } : {}),
      };
      const r = await useAiStore().system.draw(req, { signal: opts.signal, model: (ref ? params.referenceModel : params.model) || undefined });
      const img = r.images[0];
      const done = await finish(img?.bytes ?? null, img?.mime ?? 'image/png', params, { framing, signal: opts.signal, canEdit });
      return {
        ...done,
        url: URL.createObjectURL(new Blob([done.bytes], { type: done.mime })),
        gen: {
          method: 'base',
          prompt: r.prompt,
          negative: r.negative,
          seed: r.seed,
          model: r.model,
          ...(framing ? { framing: framing.name } : {}),
          ...(done.removedBg ? { removedBg: true } : {}),
          at: Date.now(),
        },
        framing,
        expression,
        pose,
        outfit: opts.outfit,
      };
    },
    opts.signal,
  );
}

/**
 * 用这张当底图：存进立绘（第一张时立绘框按它、头像框按猜的脸、这个角色平时就用它的构图），之后的表情、动作照着它画。
 * 构图和这个角色平时用的不一样时留着备用
 */
export async function acceptBase(c: Character, draft: SpriteDraft): Promise<Portrait> {
  const set = ensurePortraitSet(c);
  const fresh = !set.portraits.length;
  // 第一张：这个角色平时就用这张的构图；不是第一张时，构图和平时的不一样就留着备用
  const off = !fresh && !!draft.framing && draft.framing.name !== mainFraming(c);
  if (fresh && draft.framing) set.framing = draft.framing.name;
  const p = await addGeneratedPortrait(
    c,
    draft,
    {
      expression: draft.expression ? { label: draft.expression.name, hint: draft.expression.hint } : undefined,
      pose: draft.pose ? { label: draft.pose.name, hint: draft.pose.hint, fits: draft.pose.fits } : undefined,
      outfit: draft.outfit ? { label: draft.outfit.name, tags: draft.outfit.tags, kind: draft.outfit.kind } : undefined,
    },
    { gen: draft.gen, name: `${c.name}_底图`, fit: !fresh && draft.face && !off ? alignFit(set, draft, draft.face) : undefined, hidden: off, everyone: useCharacterStore().list },
  );
  if (fresh && draft.face) set.face = { ...draft.face };
  set.genBase = p.id;
  URL.revokeObjectURL(draft.url);
  return p;
}

/** 这个表情 / 动作在底图这种构图、这身、这个动作（表情）下已经有图了 */
export function hasLabel(c: Character, kind: 'expression' | 'pose', name: string): boolean {
  const set = c.portraits;
  const base = baseOf(c);
  if (!set || !base) return false;
  const list: { id: string; label: string }[] = kind === 'expression' ? set.expressions : set.poses;
  const id = list.find((x) => x.label === name || x.id === name)?.id;
  if (!id) return false;
  const framing = framingOf(c, base);
  return set.portraits.some(
    (p) =>
      p.outfit === base.outfit &&
      framingOf(c, p) === framing &&
      (kind === 'expression' ? p.expression === id && p.pose === base.pose : p.pose === id && p.expression === base.expression),
  );
}

/** 只重画脸时重画哪一块（占底图的比例），界面上画个框给你看 */
export function maskBox(c: Character): { x: number; y: number; w: number; h: number } | null {
  const set = c.portraits;
  const base = baseOf(c);
  if (!set || !base) return null;
  const { params } = spriteStatus(c);
  const f = faceInImage(set, base);
  const side = f.side * params.maskScale;
  const x = Math.max(0, f.cx - side / 2);
  const y = Math.max(0, f.cy - side / 2);
  return { x: x / base.width, y: y / base.height, w: Math.min(side, base.width - x) / base.width, h: Math.min(side, base.height - y) / base.height };
}

/**
 * 照着底图画一个表情（办法见预设的出图参数）。replace：换掉以前照着这张底图画的同一个表情
 */
export function drawExpression(c: Character, label: SpriteLabel, opts: { replace?: boolean; signal?: AbortSignal } = {}): Promise<Portrait> {
  const { preset, params } = need(c, true);
  const set = c.portraits;
  const base = baseOf(c);
  if (!set || !base) throw new AiError('no_route', '先画一张底图（或者在立绘里选一张当底图）');
  const method = params.expressionMethod === 'emotion' && !label.emotion ? 'inpaint' : params.expressionMethod;
  const framingName = framingOf(c, base);
  const framing = framingNamed(preset, framingName);
  return enqueueImage(
    'user',
    async () => {
      const ai = useAiStore();
      const baseBlob = await assetBlob(base.assetKey);
      const src = await novelaiImage(baseBlob, params.width * params.height);
      const srcBlob = new Blob([src.bytes], { type: 'image/png' });
      let out: { bytes: Uint8Array<ArrayBuffer> | null; mime: string; prompt: string; negative: string; seed: number | null; model: string };
      if (method === 'emotion') {
        const r = await ai.system.augment({ kind: 'emotion', image: src.base64, width: src.width, height: src.height, emotion: label.emotion, prompt: label.tags, defry: params.emotionLevel, signal: opts.signal });
        out = { bytes: r.image.bytes, mime: r.image.mime, prompt: `${label.emotion};;${label.tags}`, negative: '', seed: null, model: 'Director Tools · emotion' };
      } else {
        const { prompt, negative } = promptFrom(c, preset, base, framing, { expression: label.tags });
        let source: ImageRequest['source'];
        if (method === 'inpaint') {
          const f = faceInImage(set, base);
          const k = src.width / base.width;
          const side = f.side * k * params.maskScale;
          const x = Math.max(0, f.cx * k - side / 2);
          const y = Math.max(0, f.cy * k - side / 2);
          const mask = await rectMask(src.width, src.height, { x, y, w: Math.min(side, src.width - x), h: Math.min(side, src.height - y) });
          source = { image: src.base64, mask, strength: params.inpaintStrength, ...(params.inpaintModel ? { inpaintModel: params.inpaintModel } : {}) };
        } else {
          source = { image: src.base64, strength: params.img2imgStrength };
        }
        const r = await ai.system.draw(
          { prompt, negative, size: { width: src.width, height: src.height }, ...drawParams(params), seed: base.gen?.seed ?? undefined, source },
          { signal: opts.signal, model: modelOf(base, params) },
        );
        out = { bytes: r.images[0]?.bytes ?? null, mime: r.images[0]?.mime ?? 'image/png', prompt: r.prompt, negative: r.negative, seed: r.seed, model: r.model };
      }
      const done = await finish(out.bytes, out.mime, params, { framing, compare: srcBlob, signal: opts.signal, canEdit: true });
      const exprId = set.expressions.find((e) => e.label === label.name || e.id === label.name)?.id;
      return addGeneratedPortrait(
        c,
        done,
        { expression: { label: label.name, hint: label.hint }, pose: base.pose, outfit: base.outfit },
        {
          gen: { method, prompt: out.prompt, negative: out.negative, seed: out.seed, model: out.model, framing: framingName, from: base.id, ...(done.removedBg ? { removedBg: true } : {}), at: Date.now() },
          name: `${c.name}_${label.name}`,
          fit: base.fit,
          hidden: framingName !== mainFraming(c),
          everyone: useCharacterStore().list,
          replace: opts.replace && exprId ? (p) => p.id !== base.id && p.gen?.from === base.id && p.expression === exprId && p.pose === base.pose && p.outfit === base.outfit : undefined,
        },
      );
    },
    opts.signal,
  );
}

/** 照着底图画一个动作（办法见预设的出图参数），画完按猜的脸对齐到立绘框 */
export function drawPose(c: Character, label: SpriteLabel, opts: { replace?: boolean; signal?: AbortSignal } = {}): Promise<Portrait> {
  const { preset, params } = need(c, true);
  const set = c.portraits;
  const base = baseOf(c);
  if (!set || !base) throw new AiError('no_route', '先画一张底图（或者在立绘里选一张当底图）');
  const framingName = framingOf(c, base);
  const framing = framingNamed(preset, framingName);
  const { prompt, negative } = promptFrom(c, preset, base, framing, { pose: label.tags });
  return enqueueImage(
    'user',
    async () => {
      const ai = useAiStore();
      const size = { width: params.width, height: params.height };
      let r;
      if (params.poseMethod === 'reference') {
        const ref = await referenceImage(await assetBlob(base.assetKey), NOVELAI_REFERENCE_CANVASES);
        r = await ai.system.draw(
          { prompt, negative, size, ...drawParams(params), references: [{ image: ref, strength: params.referenceStrength, fidelity: params.referenceFidelity }] },
          { signal: opts.signal, model: params.referenceModel || undefined },
        );
      } else {
        r = await ai.system.draw({ prompt, negative, size, ...drawParams(params), seed: base.gen?.seed ?? undefined }, { signal: opts.signal, model: modelOf(base, params) });
      }
      const done = await finish(r.images[0]?.bytes ?? null, r.images[0]?.mime ?? 'image/png', params, { framing, signal: opts.signal, canEdit: true });
      const poseId = set.poses.find((x) => x.label === label.name || x.id === label.name)?.id;
      const off = framingName !== mainFraming(c);
      return addGeneratedPortrait(
        c,
        done,
        { expression: base.expression, pose: { label: label.name, hint: label.hint, fits: label.fits }, outfit: base.outfit },
        {
          gen: {
            method: params.poseMethod,
            prompt: r.prompt,
            negative: r.negative,
            seed: r.seed,
            model: r.model,
            framing: framingName,
            from: base.id,
            ...(done.removedBg ? { removedBg: true } : {}),
            at: Date.now(),
          },
          name: `${c.name}_${label.name}`,
          // 不是平时那种构图的留着备用，不往平时的立绘框上对齐
          fit: done.face && !off ? alignFit(set, done, done.face) : base.fit,
          hidden: off,
          everyone: useCharacterStore().list,
          replace: opts.replace && poseId ? (p) => p.id !== base.id && p.gen?.from === base.id && p.pose === poseId && p.expression === base.expression && p.outfit === base.outfit : undefined,
        },
      );
    },
    opts.signal,
  );
}

/** 预设里的表情、动作（界面列出来）；还有立绘上她自己的表情里预设没有的（tags 要先让 AI 写） */
export function presetLabels(c: Character): { expressions: SpriteLabel[]; poses: SpriteLabel[] } {
  const preset = spritePresetFor(c);
  return { expressions: spriteLabels(preset, 'expression'), poses: spriteLabels(preset, 'pose') };
}

/** 一个自己起名的表情 / 动作（tags 是你写的或 AI 写的） */
export function customLabel(name: string, tags: string, extra: { hint?: string; emotion?: string } = {}): SpriteLabel {
  return { name: name.trim(), tags: joinTags(tags), hint: extra.hint ?? '', emotion: extra.emotion ?? '', fits: [], identifier: '' };
}
