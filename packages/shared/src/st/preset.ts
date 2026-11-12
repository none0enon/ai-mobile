import {
  APP_MARKERS,
  DEFAULT_PRESET_FORMATS,
  PROMPT_MARKERS,
  type Preset,
  type PresetFormats,
  type PromptBlock,
  type RegexScript,
  type SamplerParams,
} from '../types/preset.ts';
import { isObj } from './lorebook.ts';
import { normalizeRegexScript, regexToSt } from './regex.ts';

/**
 * SillyTavern Chat Completion 预设：prompts[] + prompt_order + 采样参数 + 拼装用的文字。
 *
 * 用哪套 prompt_order：ST 的提示词管理器是"全局"策略，固定读 character_id = 100001（openai.js 里的 dummyId）；
 * 100000 是旧版 / 默认那套。所以优先 100001，其次 100000，再其次第一套。
 * 两套都在时，开关以 100001 为准——在 ST 里看到的、实际发送的就是这套。
 */

type Obj = Record<string, unknown>;

export type ParsedPreset = Omit<Preset, 'id' | 'createdAt' | 'updatedAt'> & { warnings: string[] };

/** ST 自带的 marker：由程序填充，不写内容 */
const ST_MARKERS = ['worldInfoBefore', 'worldInfoAfter', 'charDescription', 'charPersonality', 'scenario', 'personaDescription', 'dialogueExamples', 'chatHistory'];

/** ST 默认的拼装顺序（预设里没有 prompt_order 时用） */
const ST_DEFAULT_ORDER = ['main', 'worldInfoBefore', 'personaDescription', 'charDescription', 'charPersonality', 'scenario', 'enhanceDefinitions', 'nsfw', 'worldInfoAfter', 'dialogueExamples', 'chatHistory', 'jailbreak'];

const PROMPT_USED = new Set(['identifier', 'name', 'role', 'content', 'marker', 'injection_position', 'injection_depth', 'injection_order', 'injection_trigger', 'forbid_overrides', 'enabled']);

/** 预设里我们自己管理的 key；其余原样存进 extra，导出时写回 */
const PRESET_USED = new Set([
  'temperature', 'top_p', 'top_k', 'frequency_penalty', 'presence_penalty', 'openai_max_tokens', 'openai_max_context', 'stream_openai', 'seed',
  'new_chat_prompt', 'new_example_chat_prompt', 'continue_nudge_prompt', 'impersonation_prompt', 'send_if_empty', 'wi_format',
  'scenario_format', 'personality_format', 'names_behavior', 'squash_system_messages',
]);

const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const role = (v: unknown): PromptBlock['role'] => (v === 'user' || v === 'assistant' ? v : 'system');

export function looksLikePreset(json: unknown): boolean {
  return isObj(json) && (Array.isArray(json.prompts) || Array.isArray(json.prompt_order) || ('openai_max_context' in json && 'temperature' in json));
}

/** 选 ST 实际生效的那套顺序 */
function pickOrder(json: Obj): { id: number | null; order: { identifier: string; enabled: boolean }[] } | null {
  const list = Array.isArray(json.prompt_order) ? json.prompt_order.filter(isObj) : [];
  const chosen = list.find((o) => Number(o.character_id) === 100001) ?? list.find((o) => Number(o.character_id) === 100000) ?? list[0];
  if (!chosen || !Array.isArray(chosen.order)) return null;
  return {
    id: chosen.character_id === undefined ? null : Number(chosen.character_id),
    order: chosen.order.filter(isObj).map((e) => ({ identifier: str(e.identifier), enabled: e.enabled !== false })).filter((e) => e.identifier),
  };
}

function blockFrom(p: Obj | undefined, identifier: string, enabled: boolean): PromptBlock {
  const marker = p?.marker === true || (!p && ST_MARKERS.includes(identifier));
  const stName = str(p?.name, identifier);
  const label = (PROMPT_MARKERS as Record<string, string>)[identifier];
  const extra: Obj = {};
  if (p) for (const [k, v] of Object.entries(p)) if (!PROMPT_USED.has(k)) extra[k] = v;
  if (marker && label && stName !== label) extra.name = stName;
  return {
    identifier,
    name: marker && label ? label : stName,
    role: role(p?.role),
    content: marker ? '' : str(p?.content),
    marker,
    enabled,
    injection: {
      position: p?.injection_position === 1 ? 'absolute' : 'relative',
      depth: num(p?.injection_depth, 4),
      order: num(p?.injection_order, 100),
    },
    forbidOverrides: p?.forbid_overrides === true ? true : undefined,
    triggers: Array.isArray(p?.injection_trigger) && p.injection_trigger.length ? p.injection_trigger.map(String) : undefined,
    extra: Object.keys(extra).length ? extra : undefined,
  };
}

/** App 自己的程序填充块：摘要放在聊天记录前，记忆 / 环境 / 场景规则按深度插进聊天记录末尾 */
export function appBlocks(): { before: PromptBlock[]; after: PromptBlock[] } {
  const b = (identifier: (typeof APP_MARKERS)[number], injection: PromptBlock['injection']): PromptBlock => ({
    identifier,
    name: PROMPT_MARKERS[identifier],
    role: 'system',
    content: '',
    marker: true,
    enabled: true,
    injection,
    origin: 'app',
  });
  return {
    before: [b('summary', { position: 'relative', depth: 4 })],
    after: [
      b('memory', { position: 'absolute', depth: 4, order: 100 }),
      b('environment', { position: 'absolute', depth: 2, order: 100 }),
      b('sceneRules', { position: 'absolute', depth: 1, order: 100 }),
    ],
  };
}

/** 预设里带的正则脚本（ST 的 extensions.regex_scripts），字段全部保留 */
function regexFrom(json: Obj): RegexScript[] {
  const ext = isObj(json.extensions) ? json.extensions : {};
  const list = Array.isArray(ext.regex_scripts) ? ext.regex_scripts : [];
  return list.map((r, i) => normalizeRegexScript(r, i)).filter((r): r is RegexScript => !!r);
}

export function parsePreset(json: unknown, fileName = '导入的预设'): ParsedPreset {
  if (!isObj(json)) throw new Error('预设不是 JSON 对象');
  const warnings: string[] = [];
  const prompts = new Map<string, Obj>();
  for (const p of Array.isArray(json.prompts) ? json.prompts.filter(isObj) : []) {
    const id = str(p.identifier);
    if (id) prompts.set(id, p);
  }

  const picked = pickOrder(json);
  let order = picked?.order;
  if (!order) {
    warnings.push('预设里没有 prompt_order，按 ST 默认顺序排');
    order = ST_DEFAULT_ORDER.filter((id) => prompts.has(id) || ST_MARKERS.includes(id)).map((identifier) => ({ identifier, enabled: true }));
    for (const id of prompts.keys()) if (!order.some((o) => o.identifier === id)) order.push({ identifier: id, enabled: prompts.get(id)?.enabled !== false });
  } else if (picked && picked.id !== 100001) {
    warnings.push(`预设里没有 100001 这套顺序，用的是 ${picked.id ?? '第一套'}`);
  }

  const blocks: PromptBlock[] = [];
  for (const o of order) {
    const p = prompts.get(o.identifier);
    if (!p && !ST_MARKERS.includes(o.identifier)) {
      warnings.push(`顺序里的"${o.identifier}"在 prompts 里找不到，跳过`);
      continue;
    }
    blocks.push(blockFrom(p, o.identifier, o.enabled));
  }

  // 补上 App 自己的块
  const app = appBlocks();
  const hist = blocks.findIndex((b) => b.identifier === 'chatHistory');
  if (hist >= 0) {
    blocks.splice(hist + 1, 0, ...app.after);
    blocks.splice(hist, 0, ...app.before);
  } else {
    warnings.push('预设里没有"聊天记录"（chatHistory），发出去的提示词里不会有聊天内容');
    blocks.push(...app.before, ...app.after);
  }

  const sampler: SamplerParams = {
    temperature: num(json.temperature, 1),
    topP: num(json.top_p, 1),
    topK: num(json.top_k, 0),
    maxTokens: num(json.openai_max_tokens, 300),
    contextTokens: num(json.openai_max_context, 4095),
    frequencyPenalty: num(json.frequency_penalty, 0),
    presencePenalty: num(json.presence_penalty, 0),
    stream: json.stream_openai !== false,
    seed: num(json.seed, -1),
  };

  const nb = num(json.names_behavior, 0);
  const formats: PresetFormats = {
    ...DEFAULT_PRESET_FORMATS,
    newChatPrompt: str(json.new_chat_prompt, '[Start a new Chat]'),
    newExampleChatPrompt: str(json.new_example_chat_prompt, '[Example Chat]'),
    continueNudgePrompt: str(json.continue_nudge_prompt, DEFAULT_PRESET_FORMATS.continueNudgePrompt),
    impersonationPrompt: str(json.impersonation_prompt),
    sendIfEmpty: str(json.send_if_empty),
    wiFormat: str(json.wi_format, '{0}'),
    // ST 默认会包一层"[{{char}}'s personality: …]"；预设里写了就按预设
    scenarioFormat: str(json.scenario_format, '[Circumstances and context of the dialogue: {{scenario}}]'),
    personalityFormat: str(json.personality_format, "[{{char}}'s personality: {{personality}}]"),
    namesBehavior: nb === -1 || nb === 1 || nb === 2 ? nb : 0,
    squashSystemMessages: json.squash_system_messages === true,
  };

  const extra: Obj = {};
  for (const [k, v] of Object.entries(json)) if (!PRESET_USED.has(k)) extra[k] = v;

  const name = fileName.replace(/\.json$/i, '') || '导入的预设';
  const on = blocks.filter((b) => b.enabled && b.origin !== 'app').length;
  return {
    name,
    description: `从 SillyTavern 导入 · ${blocks.length - app.before.length - app.after.length} 块（开 ${on} 块）· 用的是 ${picked?.id ?? '默认'} 这套顺序`,
    // ST 的 Chat Completion 预设是对话预设；导入时可以改成功能或主动消息
    category: 'chat',
    blocks,
    sampler,
    formats,
    regex: regexFrom(json),
    source: { kind: 'sillytavern', orderId: picked?.id ?? null, fileName },
    extra,
    warnings,
  };
}

/** 导出回 ST 预设：改过的块写回 prompts，顺序和开关写回导入时用的那套 prompt_order；App 自己的块不导出；正则写回 extensions.regex_scripts */
export function presetToSt(preset: Pick<Preset, 'blocks' | 'sampler' | 'formats' | 'extra' | 'source'> & Partial<Pick<Preset, 'regex'>>): Obj {
  const out: Obj = { ...(preset.extra ?? {}) };
  if (preset.regex) out.extensions = { ...(isObj(out.extensions) ? out.extensions : {}), regex_scripts: preset.regex.map(regexToSt) };
  const prompts: Obj[] = Array.isArray(out.prompts) ? (out.prompts as Obj[]).map((p) => ({ ...p })) : [];
  const own = preset.blocks.filter((b) => b.origin !== 'app');
  for (const b of own) {
    const { name: stName, ...extra } = (b.extra ?? {}) as Obj;
    const p: Obj = {
      ...extra,
      identifier: b.identifier,
      name: b.marker ? str(stName, b.name) : b.name,
      role: b.role,
      ...(b.marker ? { marker: true } : { content: b.content }),
      injection_position: b.injection.position === 'absolute' ? 1 : 0,
      injection_depth: b.injection.depth,
      injection_order: b.injection.order ?? 100,
      injection_trigger: b.triggers ?? [],
      forbid_overrides: b.forbidOverrides ?? false,
    };
    const i = prompts.findIndex((x) => x.identifier === b.identifier);
    if (i >= 0) prompts[i] = { ...prompts[i], ...p };
    else prompts.push(p);
  }
  out.prompts = prompts;

  const orderId = preset.source?.orderId ?? 100001;
  const orders: Obj[] = Array.isArray(out.prompt_order) ? (out.prompt_order as Obj[]).filter((o) => Number(o.character_id) !== orderId) : [];
  orders.push({ character_id: orderId, order: own.map((b) => ({ identifier: b.identifier, enabled: b.enabled })) });
  out.prompt_order = orders;

  const s = preset.sampler;
  Object.assign(out, {
    temperature: s.temperature,
    top_p: s.topP,
    top_k: s.topK ?? 0,
    frequency_penalty: s.frequencyPenalty,
    presence_penalty: s.presencePenalty,
    openai_max_tokens: s.maxTokens,
    openai_max_context: s.contextTokens,
    stream_openai: s.stream,
    seed: s.seed ?? -1,
  });
  const f = preset.formats;
  Object.assign(out, {
    new_chat_prompt: f.newChatPrompt,
    new_example_chat_prompt: f.newExampleChatPrompt,
    continue_nudge_prompt: f.continueNudgePrompt,
    impersonation_prompt: f.impersonationPrompt,
    send_if_empty: f.sendIfEmpty,
    wi_format: f.wiFormat,
    scenario_format: f.scenarioFormat,
    personality_format: f.personalityFormat,
    names_behavior: f.namesBehavior,
    squash_system_messages: f.squashSystemMessages,
  });
  return out;
}
