import type { RegexPlacement, RegexScript } from '../types/preset.ts';
import { isObj } from './lorebook.ts';
import { substituteMacros, type MacroContext } from './macros.ts';

/**
 * SillyTavern 的正则脚本（public/scripts/extensions/regex/engine.js），照 ST 的规则执行：
 * - 查找写成 /正则/标志；不带斜杠时整串当正则、没有任何标志（没有 g 就只换第一处），同 ST 的 regexFromString；
 * - 替换里 $1、$<名字> 是捕获组，{{match}}（或 $0）是整段匹配；捕获到的内容先删掉 trimStrings，最后替换 {{char}} {{user}} 这些宏；
 * - 改哪里：两个"只"都不勾时改存下来的消息（她回复、你发送时，勾了 runOnEdit 的改消息时也改）；
 *   只改显示（markdownOnly）；只改发给 AI 的（promptOnly）；两个都勾 = 显示和发给 AI 的都改，存下来的不改；
 * - 深度：0 是最后一条，minDepth ~ maxDepth 之外的不改。只在显示、发给 AI 时看（存消息时没有深度，同 ST）。
 */

type Obj = Record<string, unknown>;

/** ST 的 placement 数字 ↔ App 的名字（0 是 ST 早就废弃的"只改显示"） */
const FROM_ST: Record<number, RegexPlacement> = { 1: 'user_input', 2: 'ai_output', 3: 'slash_command', 5: 'world_info', 6: 'reasoning' };
const TO_ST: Record<RegexPlacement, number> = { user_input: 1, ai_output: 2, slash_command: 3, world_info: 5, reasoning: 6 };

/** 作用范围（界面文字，同 SillyTavern 中文版）；App 只执行前两种 */
export const REGEX_PLACEMENTS: Record<RegexPlacement, string> = {
  user_input: '用户输入',
  ai_output: 'AI 输出',
  slash_command: '斜杠命令',
  world_info: '世界信息',
  reasoning: '推理',
};

/** ST 的 regexFromString：/pattern/flags；不是这种写法时整串当正则、不带标志。写错了返回 undefined（这条脚本不执行） */
export function regexFromString(input: string): RegExp | undefined {
  try {
    const m = input.match(/(\/?)(.+)\1([a-z]*)/i);
    if (!m) return undefined;
    // 标志不认识（或重复）：整串当正则
    if (m[3] && !/^(?!.*?(.).*?\1)[gmixXsuUAJ]+$/.test(m[3])) return new RegExp(input);
    return new RegExp(m[2] ?? '', m[3]);
  } catch {
    return undefined;
  }
}

/** 这条查找实际怎么用：给编辑界面说明（ST 的写法容易误会：不带斜杠就没有 g） */
export function describeFind(find: string): { ok: boolean; text: string } {
  if (!find) return { ok: false, text: '未填写' };
  const re = regexFromString(find);
  if (!re) return { ok: false, text: '正则表达式无效，不会执行' };
  const all = re.flags.includes('g');
  const flags = re.flags ? `标志 ${re.flags}` : '无标志';
  return { ok: true, text: `${flags}：${all ? '替换全部匹配' : '仅替换第一处匹配，全局替换请写成 /…/g'}` };
}

/** 宏的值放进正则前转义（ST 的 sanitizeRegexMacro） */
function escapeRegexMacro(s: string): string {
  const special: Record<string, string> = { '\n': '\\n', '\r': '\\r', '\t': '\\t', '\v': '\\v', '\f': '\\f', '\0': '\\0' };
  return s.replace(/[\n\r\t\v\f\0.^$*+?{}[\]\\/|()]/g, (c) => special[c] ?? `\\${c}`);
}

export interface RegexNames {
  char: string;
  user: string;
}

const macros = (n: RegexNames): MacroContext => ({ char: n.char, user: n.user });

/** 跑一条脚本（ST 的 runRegexScript）：不看开关以外的条件（作用在哪、改哪里、深度由 applyRegexScripts 判断） */
export function runRegexScript(script: RegexScript, text: string, names: RegexNames): string {
  if (!script || script.enabled === false || !script.find || !text) return text;
  const find =
    script.substituteRegex === 1
      ? substituteMacros(script.find, macros(names))
      : script.substituteRegex === 2
        ? substituteMacros(script.find, { char: escapeRegexMacro(names.char), user: escapeRegexMacro(names.user) })
        : script.find;
  const re = regexFromString(find);
  if (!re) return text;
  const template = (script.replace ?? '').replace(/\{\{match\}\}/gi, '$0');
  const trims = (script.trimStrings ?? []).filter(Boolean).map((t) => substituteMacros(t, macros(names)));
  // 用函数替换：替换文字里的 $&、$$ 不当成 JS 的替换记号，只认 $数字 和 $<名字>（同 ST）
  return text.replace(re, (...args: unknown[]) => {
    const last = args.at(-1);
    const groups = last && typeof last === 'object' ? (last as Record<string, string | undefined>) : undefined;
    // args：整段匹配、各捕获组、位置、原文[、命名组]
    const count = args.length - (groups ? 4 : 3);
    const filled = template.replace(/\$(\d+)|\$<([^>]+)>/g, (_, num: string | undefined, name: string | undefined) => {
      const i = Number(num);
      const v = num !== undefined ? (i <= count ? args[i] : undefined) : name !== undefined ? groups?.[name] : undefined;
      if (typeof v !== 'string' || !v) return '';
      return trims.reduce((s, t) => s.split(t).join(''), v);
    });
    return substituteMacros(filled, macros(names));
  });
}

/** 改哪里：store 存下来的消息 / display 显示 / prompt 发给 AI 的 */
export type RegexTarget = 'store' | 'display' | 'prompt';

export interface RegexApplyOptions extends RegexNames {
  placement: RegexPlacement;
  target: RegexTarget;
  /** 倒数第几条（0 = 最后一条）；不给就不看深度 */
  depth?: number;
  /** 改消息时：只跑勾了"改消息时也执行"的 */
  edit?: boolean;
}

/** 这一次该不该跑这条（ST 的 getRegexedString 里的判断） */
export function regexApplies(s: RegexScript, o: Pick<RegexApplyOptions, 'placement' | 'target' | 'depth' | 'edit'>): boolean {
  if (s.enabled === false || !s.find) return false;
  const display = !!s.markdownOnly;
  const prompt = !!s.promptOnly;
  if (o.target === 'display' ? !display : o.target === 'prompt' ? !prompt : display || prompt) return false;
  if (o.edit && !s.runOnEdit) return false;
  if (typeof o.depth === 'number') {
    if (typeof s.minDepth === 'number' && s.minDepth >= -1 && o.depth < s.minDepth) return false;
    if (typeof s.maxDepth === 'number' && s.maxDepth >= 0 && o.depth > s.maxDepth) return false;
  }
  return s.placement.includes(o.placement);
}

/** 按顺序跑一组脚本，上一条的结果交给下一条 */
export function applyRegexScripts(scripts: readonly RegexScript[] | undefined, text: string, o: RegexApplyOptions): string {
  if (!scripts?.length || !text) return text;
  let out = text;
  for (const s of scripts) if (regexApplies(s, o)) out = runRegexScript(s, out, o);
  return out;
}

// —— 导入、导出 ——

const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const depthOf = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null);

/** ST 正则脚本里用到的字段；其余原样放进 extra */
const ST_USED = new Set(['id', 'scriptName', 'findRegex', 'replaceString', 'trimStrings', 'placement', 'disabled', 'markdownOnly', 'promptOnly', 'runOnEdit', 'substituteRegex', 'minDepth', 'maxDepth']);

/** 看起来是不是一条 SillyTavern 正则脚本 */
export function looksLikeStRegex(json: unknown): boolean {
  return isObj(json) && typeof json.findRegex === 'string' && ('scriptName' in json || 'replaceString' in json);
}

/** 正则脚本文件：一条、一组，或者带着 regex_scripts 的东西 */
export function looksLikeRegexFile(json: unknown): boolean {
  return looksLikeStRegex(json) || (Array.isArray(json) && json.length > 0 && json.every(looksLikeStRegex));
}

/**
 * 一条正则脚本 → RegexScript。认两种写法：SillyTavern 导出的（scriptName / findRegex / replaceString / placement 数字），
 * App 预设文件里的（name / find / replace / placement 文字）
 */
export function normalizeRegexScript(raw: unknown, i = 0): RegexScript | null {
  if (!isObj(raw)) return null;
  const st = looksLikeStRegex(raw) || typeof raw.scriptName === 'string';
  const list = Array.isArray(raw.placement) ? raw.placement : [];
  let placement = [
    ...new Set(
      list.map((p) => (typeof p === 'number' ? FROM_ST[p] : typeof p === 'string' && Object.hasOwn(TO_ST, p) ? (p as RegexPlacement) : undefined)).filter((p): p is RegexPlacement => !!p),
    ),
  ];
  let markdownOnly = raw.markdownOnly === true;
  // ST 早期的"只改显示"（placement 0）：当成只改显示、作用在你和她的消息上
  if (list.includes(0)) {
    markdownOnly = true;
    if (!placement.length) placement = ['user_input', 'ai_output'];
  }
  const sub = Number(raw.substituteRegex);
  const extra: Obj = {};
  if (st) {
    for (const [k, v] of Object.entries(raw)) if (!ST_USED.has(k)) extra[k] = v;
  } else if (isObj(raw.extra)) {
    Object.assign(extra, raw.extra);
  }
  return {
    id: str(raw.id) || `regex-${i}`,
    name: str(st ? raw.scriptName : raw.name).trim() || `正则 ${i + 1}`,
    find: str(st ? raw.findRegex : raw.find),
    replace: str(st ? raw.replaceString : raw.replace),
    placement,
    enabled: st ? raw.disabled !== true : raw.enabled !== false,
    trimStrings: Array.isArray(raw.trimStrings) ? raw.trimStrings.filter((t): t is string => typeof t === 'string' && t !== '') : [],
    markdownOnly,
    promptOnly: raw.promptOnly === true,
    runOnEdit: raw.runOnEdit === true,
    minDepth: depthOf(raw.minDepth),
    maxDepth: depthOf(raw.maxDepth),
    substituteRegex: sub === 1 || sub === 2 ? sub : 0,
    ...(Object.keys(extra).length ? { extra } : {}),
  };
}

/** RegexScript → SillyTavern 的正则脚本（导出、写回 ST 预设） */
export function regexToSt(s: RegexScript): Obj {
  return {
    ...(s.extra ?? {}),
    id: s.id,
    scriptName: s.name,
    findRegex: s.find,
    replaceString: s.replace,
    trimStrings: s.trimStrings ?? [],
    placement: s.placement.map((p) => TO_ST[p]),
    disabled: !s.enabled,
    markdownOnly: !!s.markdownOnly,
    promptOnly: !!s.promptOnly,
    runOnEdit: !!s.runOnEdit,
    substituteRegex: s.substituteRegex ?? 0,
    minDepth: s.minDepth ?? null,
    maxDepth: s.maxDepth ?? null,
  };
}

/**
 * 导入正则：SillyTavern 导出的一条或一组正则脚本，也能从 ST 预设、角色卡（extensions.regex_scripts）、
 * App 的预设文件（regex）里取。认不出时报错
 */
export function parseRegexImport(json: unknown): { scripts: RegexScript[]; from: string } {
  const pick = (list: unknown[], from: string) => ({ scripts: list.map((r, i) => normalizeRegexScript(r, i)).filter((r): r is RegexScript => !!r && !!r.find), from });
  if (Array.isArray(json)) return pick(json, '正则脚本');
  if (!isObj(json)) throw new Error('不是 JSON 对象');
  if (looksLikeStRegex(json)) return pick([json], '正则脚本');
  // App 的预设文件（导出的、自带的）
  if (Array.isArray(json.regex) && Array.isArray(json.blocks)) return pick(json.regex, 'App 预设文件');
  if (Array.isArray(json.regex_scripts)) return pick(json.regex_scripts, '正则脚本');
  const ext = isObj(json.extensions) ? json.extensions : isObj(json.data) && isObj(json.data.extensions) ? json.data.extensions : null;
  if (ext && Array.isArray(ext.regex_scripts)) return pick(ext.regex_scripts, isObj(json.data) ? '角色卡' : '预设');
  throw new Error('无法识别：不是 SillyTavern 正则脚本，也不是包含正则的预设或角色卡');
}
