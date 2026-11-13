/**
 * 隐藏控制标签：主对话模型在回复里夹带，用户看不到，客户端在流式输出时实时剥离并执行。
 * 由 sleep-together 原型的 makeTagStripper（只认 [expr:x]）扩展而来。
 *
 *   [expr:smile]          切换立绘表情（只允许立绘套装里有图的表情）
 *   [pose:sit]            切换姿势
 *   [outfit:pajama]       切换服装
 *   [bg:cafe]             切换背景
 *   [cg:雨天的图书馆]      请求一张配图（交给生图提示词智能体）
 *   [music:歌名-歌手]      分享一首歌（生成歌曲卡片）
 *   [call]                想打电话（界面弹出来电）
 *   [choice:A|B|C]        约会里的选项
 *   [poke:head]           回戳你
 *   <device>"VIBRATE": 40</device>   心跳里玩具的控制指令（尖括号写法，可以跨行；内容见 device.ts）
 *
 * 兼容全角写法【expr：smile】。不认识的方括号（例如"[笑]"）原样保留为正文。
 */
export const CONTROL_TAG_KINDS = ['expr', 'pose', 'outfit', 'bg', 'cg', 'music', 'call', 'choice', 'poke'] as const;

/** 尖括号写法、成对的标签：<device>…</device>（同 SillyTavern 的 Intiface 插件） */
export const BLOCK_TAG_KINDS = ['device'] as const;

export type ControlTagKind = (typeof CONTROL_TAG_KINDS)[number] | (typeof BLOCK_TAG_KINDS)[number];

export type ControlTag =
  | { kind: 'expr' | 'pose' | 'outfit' | 'bg' | 'poke' | 'cg' | 'device'; value: string }
  | { kind: 'music'; title: string; artist: string }
  | { kind: 'call' }
  | { kind: 'choice'; options: string[] };

export type TagStreamEvent = { type: 'text'; text: string } | { type: 'tag'; tag: ControlTag };

/**
 * 每种标签的写法和什么时候用。写给模型看：拼进提示词的"当前场景规则 + 可用标签"那一块（只列这个场景能用的），
 * 所以导入的 SillyTavern 预设也知道怎么用。
 */
export const CONTROL_TAG_DOCS: Record<ControlTagKind, { syntax: string; desc: string }> = {
  expr: { syntax: '[expr:表情]', desc: '情绪变化时切换立绘表情，只能用下面列出的表情' },
  pose: { syntax: '[pose:姿势]', desc: '换一个姿势（sit、stand……）' },
  outfit: { syntax: '[outfit:服装]', desc: '换一身衣服（pajama、casual……）' },
  bg: { syntax: '[bg:地点]', desc: '换背景（cafe、library……）' },
  cg: {
    syntax: '[cg:画面描述]',
    desc: '发一张图给对方：对方想看你（照片、自拍、你现在的样子），或者你想让对方看到眼前的画面时用。冒号后面用中文写清楚画面：谁、在哪、在做什么、什么光线。程序会照着画出来发过去；一次回复最多一个',
  },
  music: { syntax: '[music:歌名-歌手]', desc: '分享一首歌' },
  call: { syntax: '[call]', desc: '想和对方打电话时用' },
  choice: { syntax: '[choice:选项A|选项B]', desc: '给对方几个选项，显示成可以直接点的回复' },
  poke: { syntax: '[poke:部位]', desc: '回戳对方' },
  device: {
    syntax: '<device>"VIBRATE": 强度</device>',
    desc: '对方连着成人玩具时，在发生的那句话后面写控制指令：VIBRATE / OSCILLATE / ROTATE（0–100 或 {"pattern": [..], "interval": [..]}）、LINEAR（{"start_position", "end_position", "duration"}）、"STOP": true',
  },
};

const KIND_ALT = CONTROL_TAG_KINDS.join('|');
// [ 或 【 开头，名字，可选的 : 或 ： 加取值，] 或 】 结尾
const TAG_RE = new RegExp(`[\\[【](${KIND_ALT})(?:[:：]([^\\]】\\n]{0,200}))?[\\]】]`, 'gi');
const MAX_TAG_LEN = 220;

function parseTag(kind: ControlTagKind, raw: string | undefined): ControlTag | null {
  const value = (raw ?? '').trim();
  switch (kind) {
    case 'call':
      return { kind: 'call' };
    case 'choice': {
      const options = value
        .split(/[|｜]/)
        .map((s) => s.trim())
        .filter(Boolean);
      return options.length ? { kind: 'choice', options } : null;
    }
    case 'music': {
      if (!value) return null;
      const [title = '', ...rest] = value.split(/\s*[-—–]\s*/);
      return { kind: 'music', title: title.trim(), artist: rest.join(' - ').trim() };
    }
    default:
      return value ? { kind, value } : null;
  }
}

/** tail 以 "[" 或 "【" 开头且还没闭合：判断它是不是一个还没收完的标签 */
function isPartialTag(tail: string): boolean {
  if (tail.length > MAX_TAG_LEN) return false;
  const normalized = tail.replace(/^【/, '[').replace('：', ':');
  const m = /^\[([a-zA-Z]*)(:[^\]】\n]*)?$/.exec(normalized);
  if (!m) return false;
  const name = (m[1] ?? '').toLowerCase();
  if (m[2] !== undefined) return (CONTROL_TAG_KINDS as readonly string[]).includes(name);
  return CONTROL_TAG_KINDS.some((k) => k.startsWith(name));
}

function lastOpenBracket(s: string): number {
  return Math.max(s.lastIndexOf('['), s.lastIndexOf('【'));
}

export interface ParsedReply {
  /** 给用户看的正文（已去掉标签） */
  visible: string;
  /** at = 标签在 visible 里的位置：剧场模式打字机打到这里时才切表情 */
  tags: { tag: ControlTag; at: number }[];
  /** 结尾有一个还没收完的标签，已暂时隐藏 */
  pending: boolean;
}

const DEVICE_RE = /<device\s*>([\s\S]*?)<\/device\s*>/gi;

/** 结尾还没收完的 <device>…（流式时）：返回从哪里开始先藏起来；没有为 -1 */
function unfinishedBlock(s: string): number {
  const lower = s.toLowerCase();
  const open = lower.lastIndexOf('<device');
  if (open >= 0 && lower.indexOf('</device', open) < 0) return open;
  // 结尾是 "<"、"<dev" 这样的半截开头
  const lt = s.lastIndexOf('<');
  if (lt >= 0 && lt >= s.length - 8 && '<device>'.startsWith(lower.slice(lt))) return lt;
  return -1;
}

/** 一段正文里的方括号标签：去掉标签，执行白名单里的；返回接上这一段之后的正文 */
function stripBrackets(seg: string, allowed: readonly ControlTagKind[] | undefined, visible: string, tags: ParsedReply['tags']): string {
  let out = visible;
  let last = 0;
  for (const m of seg.matchAll(TAG_RE)) {
    const index = m.index ?? 0;
    out += seg.slice(last, index);
    const kind = (m[1] ?? '').toLowerCase() as ControlTagKind;
    const tag = parseTag(kind, m[2]);
    if (tag && (!allowed || allowed.includes(kind))) tags.push({ tag, at: out.length });
    last = index + m[0].length;
  }
  return out + seg.slice(last);
}

/**
 * 无状态解析：每次拿"到目前为止的全文"重新解析一遍。
 * 和 math-reader 的 readAIStream 一样，onDelta 每次给的都是累积全文，所以直接配合使用。
 * allowed 用于场景白名单：不在白名单里的已知标签照样从正文里去掉，但不执行。
 * <device>…</device> 整段从正文里拿掉（单独一行的连同换行），还没收完的先藏起来。
 */
export function parseControlTags(raw: string, allowed?: readonly ControlTagKind[]): ParsedReply {
  let body = raw;
  let pending = false;
  const cut = unfinishedBlock(body);
  if (cut >= 0) {
    body = body.slice(0, cut);
    pending = true;
  }
  let visible = '';
  const tags: ParsedReply['tags'] = [];
  let last = 0;
  for (const m of body.matchAll(DEVICE_RE)) {
    const index = m.index ?? 0;
    visible = stripBrackets(body.slice(last, index), allowed, visible, tags);
    if (!allowed || allowed.includes('device')) tags.push({ tag: { kind: 'device', value: (m[1] ?? '').trim() }, at: visible.length });
    last = index + m[0].length;
    if (!visible || visible.endsWith('\n')) {
      if (body.startsWith('\r\n', last)) last += 2;
      else if (body[last] === '\n') last += 1;
    }
  }
  let tail = body.slice(last);
  const open = lastOpenBracket(tail);
  if (open !== -1 && isPartialTag(tail.slice(open))) {
    tail = tail.slice(0, open);
    pending = true;
  }
  visible = stripBrackets(tail, allowed, visible, tags);
  return { visible, tags, pending };
}

/**
 * 流式剥离器：每来一个增量 chunk 调一次 consume，结束时调 flush。
 * 适合只给增量的流；跨 chunk 的半截标签（例如 "[ex" + "pr:smile]"）会先缓住，凑完整再解析。
 */
export function createTagStripper() {
  let carry = '';

  function consume(chunk: string): TagStreamEvent[] {
    const events: TagStreamEvent[] = [];
    let input = carry + chunk;
    carry = '';

    const open = lastOpenBracket(input);
    if (open !== -1) {
      const tail = input.slice(open);
      if (isPartialTag(tail)) {
        carry = tail;
        input = input.slice(0, open);
      }
    }

    let last = 0;
    for (const m of input.matchAll(TAG_RE)) {
      const index = m.index ?? 0;
      if (index > last) events.push({ type: 'text', text: input.slice(last, index) });
      const tag = parseTag((m[1] ?? '').toLowerCase() as ControlTagKind, m[2]);
      if (tag) events.push({ type: 'tag', tag });
      last = index + m[0].length;
    }
    if (last < input.length) events.push({ type: 'text', text: input.slice(last) });
    return events;
  }

  function flush(): TagStreamEvent[] {
    if (!carry) return [];
    const text = carry;
    carry = '';
    return [{ type: 'text', text }];
  }

  return { consume, flush };
}

/** 非流式：一次性剥离整段文本里的标签 */
export function stripControlTags(text: string): { text: string; tags: ControlTag[] } {
  const parsed = parseControlTags(text);
  return {
    text: parsed.visible.replace(/[ \t]+\n/g, '\n').trim(),
    tags: parsed.tags.map((t) => t.tag),
  };
}
