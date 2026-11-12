import { PRESET_USES, type PresetUseId } from './presetUses.ts';
import { normalizeRegexScript } from './st/regex.ts';
import {
  DEFAULT_PRESET_FORMATS,
  PRESET_CATEGORIES,
  type Preset,
  type PresetCategory,
  type PresetFormats,
  type PromptBlock,
  type RegexScript,
  type SamplerParams,
} from './types/preset.ts';

/**
 * 预设文件（App 自己的格式，.json）。App 自带的预设就是 apps/web/src/presets/ 里的这种文件：
 * 第一次打开时像导入一样放进预设库，之后和你导入的一样能改、能删、能复制、能导出。
 * "导入"里也能选这种文件；预设编辑页能把任何预设导出成这种文件。
 */
export const PRESET_FILE_FORMAT = 'ai-mobile-preset';

export interface PresetFile {
  format: typeof PRESET_FILE_FORMAT;
  version: 1;
  /** App 自带的预设有固定 id（演示角色按它找）；导入时和已有的撞了就换新的 */
  id?: string;
  name: string;
  description?: string;
  category: PresetCategory;
  /** 第一次放进预设库时给哪些用途用（那个用途还没选过的话） */
  defaultFor?: PresetUseId[];
  blocks: PromptBlock[];
  sampler: SamplerParams;
  formats?: Partial<PresetFormats>;
  regex?: RegexScript[];
  /** 从 SillyTavern 导入的预设：导回 ST 时要用的原始字段 */
  source?: Preset['source'];
  extra?: Record<string, unknown>;
}

export type ParsedPresetFile = Omit<Preset, 'id' | 'createdAt' | 'updatedAt'> & { id?: string; defaultFor: PresetUseId[]; warnings: string[] };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export function looksLikePresetFile(json: unknown): boolean {
  return isObj(json) && json.format === PRESET_FILE_FORMAT;
}

function blockFrom(raw: unknown, i: number, warnings: string[]): PromptBlock | null {
  if (!isObj(raw)) {
    warnings.push(`第 ${i + 1} 块不是对象，跳过`);
    return null;
  }
  const identifier = str(raw.identifier).trim();
  if (!identifier) {
    warnings.push(`第 ${i + 1} 块没有 identifier，跳过`);
    return null;
  }
  const inj = isObj(raw.injection) ? raw.injection : {};
  const role = raw.role === 'user' || raw.role === 'assistant' ? raw.role : 'system';
  return {
    identifier,
    name: str(raw.name, identifier),
    role,
    content: str(raw.content),
    marker: raw.marker === true,
    enabled: raw.enabled !== false,
    injection: { position: inj.position === 'absolute' ? 'absolute' : 'relative', depth: num(inj.depth, 4), ...(typeof inj.order === 'number' ? { order: inj.order } : {}) },
    ...(raw.forbidOverrides === true ? { forbidOverrides: true } : {}),
    ...(Array.isArray(raw.triggers) && raw.triggers.length ? { triggers: raw.triggers.map(String) } : {}),
    ...(raw.origin === 'app' ? { origin: 'app' as const } : {}),
    ...(isObj(raw.extra) ? { extra: raw.extra } : {}),
  };
}

/** 读预设文件；分类不认识时报错 */
export function parsePresetFile(json: unknown, fileName = ''): ParsedPresetFile {
  if (!looksLikePresetFile(json)) throw new Error('不是 App 的预设文件');
  const j = json as Obj;
  const category = j.category as PresetCategory;
  if (!PRESET_CATEGORIES[category]) throw new Error(`预设文件里的分类"${String(j.category)}"不认识`);
  const warnings: string[] = [];
  const blocks = (Array.isArray(j.blocks) ? j.blocks : []).map((b, i) => blockFrom(b, i, warnings)).filter((b): b is PromptBlock => !!b);
  if (!blocks.length) warnings.push('预设文件里没有提示词块');
  const s = isObj(j.sampler) ? j.sampler : {};
  const sampler: SamplerParams = {
    temperature: num(s.temperature, 1),
    topP: num(s.topP, 1),
    ...(typeof s.topK === 'number' ? { topK: s.topK } : {}),
    maxTokens: num(s.maxTokens, 600),
    contextTokens: num(s.contextTokens, 24000),
    frequencyPenalty: num(s.frequencyPenalty, 0),
    presencePenalty: num(s.presencePenalty, 0),
    stream: s.stream !== false,
    ...(typeof s.seed === 'number' ? { seed: s.seed } : {}),
  };
  const regex: RegexScript[] = (Array.isArray(j.regex) ? j.regex : []).map((r, i) => normalizeRegexScript(r, i)).filter((r): r is RegexScript => !!r);
  const defaultFor = (Array.isArray(j.defaultFor) ? j.defaultFor : []).filter((u): u is PresetUseId => PRESET_USES.some((x) => x.id === u && x.category === category));
  const name = str(j.name).trim() || fileName.replace(/\.json$/i, '') || '预设';
  return {
    ...(typeof j.id === 'string' && j.id.trim() ? { id: j.id.trim() } : {}),
    name,
    description: str(j.description),
    category,
    blocks,
    sampler,
    formats: { ...DEFAULT_PRESET_FORMATS, ...(isObj(j.formats) ? (j.formats as Partial<PresetFormats>) : {}) },
    regex,
    ...(isObj(j.source) ? { source: j.source as Preset['source'] } : {}),
    ...(isObj(j.extra) ? { extra: j.extra } : {}),
    defaultFor,
    warnings,
  };
}

/** 把预设写成预设文件（导出、备份、拿到别的设备上导入） */
export function toPresetFile(p: Preset, defaultFor: PresetUseId[] = []): PresetFile {
  return {
    format: PRESET_FILE_FORMAT,
    version: 1,
    id: p.id,
    name: p.name,
    description: p.description,
    category: p.category,
    ...(defaultFor.length ? { defaultFor } : {}),
    blocks: p.blocks,
    sampler: p.sampler,
    formats: p.formats,
    regex: p.regex,
    ...(p.source ? { source: p.source } : {}),
    ...(p.extra ? { extra: p.extra } : {}),
  };
}
