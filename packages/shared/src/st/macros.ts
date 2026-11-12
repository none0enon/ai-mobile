import { formatDuration } from '../environment.ts';

/**
 * SillyTavern 宏（常用的一部分）。名字不区分大小写；不认识的宏原样保留。
 * 支持嵌套：从最里层开始替换，例如 {{setvar::x::{{char}}}}。
 */
export interface MacroContext {
  char: string;
  user: string;
  /** {{original}}：被角色卡覆盖前的主提示 / 后置指令 */
  original?: string;
  description?: string;
  personality?: string;
  scenario?: string;
  persona?: string;
  mesExamples?: string;
  charPrompt?: string;
  charJailbreak?: string;
  charVersion?: string;
  lastMessage?: string;
  lastUserMessage?: string;
  lastCharMessage?: string;
  model?: string;
  now?: Date;
  /** 距上次你发消息多久（毫秒）；{{idle_duration}} */
  idleMs?: number | null;
  /** 聊天变量，{{setvar}} 会改它 */
  vars?: Record<string, string>;
  random?: () => number;
  /** {{weather}}：天气一句话 */
  weather?: string;
  /**
   * 按这一次填的其他宏（名字小写）：生图预设里的 {{char_appearance}} {{char_outfit}} {{user_appearance}}，
   * 按这次画的角色替换（设计文档 §5.2）
   */
  extra?: Record<string, string>;
}

const WEEKDAY = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
const pad = (n: number) => String(n).padStart(2, '0');

function roll(spec: string, rnd: () => number): string {
  const m = spec.trim().match(/^(\d*)d(\d+)([+-]\d+)?$/i) ?? spec.trim().match(/^()(\d+)()$/);
  if (!m) return '';
  const count = Math.min(100, Number(m[1] || 1));
  const sides = Number(m[2]);
  if (!sides) return '';
  let total = Number(m[3] || 0);
  for (let i = 0; i < count; i++) total += 1 + Math.floor(rnd() * sides);
  return String(total);
}

/** {{random::a::b}} 或 {{random:a,b}} 的选项 */
function options(arg: string): string[] {
  if (arg.startsWith('::')) return arg.slice(2).split('::');
  if (arg.startsWith(':')) return arg.slice(1).split(/(?<!\\),/).map((s) => s.replace(/\\,/g, ',').trim());
  return [];
}

function one(raw: string, ctx: MacroContext): string | null {
  const body = raw.trim();
  if (body.startsWith('//')) return '';
  const lower = body.toLowerCase();
  const now = ctx.now ?? new Date();
  const rnd = ctx.random ?? Math.random;
  const vars = ctx.vars;

  switch (lower) {
    case 'char':
    case 'charifnotgroup':
    case 'group':
      return ctx.char;
    case 'user':
      return ctx.user;
    case 'original':
      return ctx.original ?? '';
    case 'description':
      return ctx.description ?? '';
    case 'personality':
      return ctx.personality ?? '';
    case 'scenario':
      return ctx.scenario ?? '';
    case 'persona':
      return ctx.persona ?? '';
    case 'mesexamples':
    case 'mesexamplesraw':
      return ctx.mesExamples ?? '';
    case 'charprompt':
      return ctx.charPrompt ?? '';
    case 'charjailbreak':
    case 'charinstruction':
      return ctx.charJailbreak ?? '';
    case 'charversion':
    case 'char_version':
      return ctx.charVersion ?? '';
    case 'lastmessage':
      return ctx.lastMessage ?? '';
    case 'lastusermessage':
      return ctx.lastUserMessage ?? '';
    case 'lastcharmessage':
      return ctx.lastCharMessage ?? '';
    case 'model':
      return ctx.model ?? '';
    case 'newline':
      return '\n';
    case 'noop':
      return '';
    case 'time':
      return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    case 'date':
      return `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;
    case 'weekday':
      return WEEKDAY[now.getDay()] ?? '';
    case 'isotime':
      return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    case 'isodate':
      return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    case 'idle_duration':
      return ctx.idleMs == null ? '刚刚' : formatDuration(ctx.idleMs / 60_000);
    case 'weather':
      return ctx.weather ?? '';
  }
  if (ctx.extra && Object.hasOwn(ctx.extra, lower)) return ctx.extra[lower] ?? '';

  if (lower.startsWith('random') || lower.startsWith('pick')) {
    const arg = body.slice(lower.startsWith('random') ? 6 : 4);
    const list = options(arg);
    return list.length ? (list[Math.floor(rnd() * list.length)] ?? '') : null;
  }
  if (lower.startsWith('roll')) {
    const arg = body.slice(4).replace(/^[:\s]+/, '');
    return roll(arg, rnd);
  }
  if (vars) {
    const m = body.match(/^(getvar|setvar|addvar|incvar|decvar)::([^:]+?)(?:::([\s\S]*))?$/i);
    if (m) {
      const op = (m[1] as string).toLowerCase();
      const key = (m[2] as string).trim();
      const val = m[3] ?? '';
      const cur = vars[key] ?? '';
      if (op === 'getvar') return cur;
      if (op === 'setvar') {
        vars[key] = val;
        return '';
      }
      if (op === 'addvar') {
        const a = Number(cur);
        const b = Number(val);
        vars[key] = cur !== '' && Number.isFinite(a) && Number.isFinite(b) ? String(a + b) : cur + val;
        return '';
      }
      const n = Number(cur) || 0;
      vars[key] = String(op === 'incvar' ? n + 1 : n - 1);
      return vars[key] as string;
    }
  }
  return null;
}

/** 从左到右展开：先展开宏参数里嵌套的宏，再算这个宏（所以 {{setvar}} 之后的 {{getvar}} 能读到新值） */
function expand(text: string, ctx: MacroContext): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf('{{', i);
    if (start < 0) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, start);
    let depth = 0;
    let j = start;
    let end = -1;
    while (j < text.length) {
      if (text.startsWith('{{', j)) {
        depth++;
        j += 2;
      } else if (text.startsWith('}}', j)) {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
        j += 2;
      } else j++;
    }
    if (end < 0) {
      // 没有配对的 }}：原样保留
      out += text.slice(start);
      break;
    }
    const raw = text.slice(start + 2, end);
    i = end + 2;
    if (raw.trim().startsWith('//')) continue;
    const inner = expand(raw, ctx);
    const v = one(inner, ctx);
    // 不认识的宏（还有 {{trim}}，最后统一处理）原样保留
    out += v === null ? `{{${inner}}}` : v;
  }
  return out;
}

export function substituteMacros(text: string, ctx: MacroContext): string {
  if (!text) return '';
  let out = text
    .replace(/<USER>/gi, ctx.user)
    .replace(/<BOT>/gi, ctx.char)
    .replace(/<CHAR>/gi, ctx.char);
  if (!out.includes('{{')) return out;
  out = expand(out, ctx);
  return out.replace(/(?:\r?\n)*\{\{trim\}\}(?:\r?\n)*/gi, '');
}
