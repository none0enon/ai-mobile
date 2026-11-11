import { stripControlTags, type TtsTextOptions } from '@app/shared';
import { compileFilter } from '../llm/filter.ts';

/**
 * 朗读前的文字处理（设计文档 §11.1；可选项对照 SillyTavern 的 TTS 设置）：
 * 去掉控制标签、代码块、<标签>（状态栏之类）、动作描写、表情符号、Markdown 记号和链接。
 * 括号和星号里的通常是动作或神态（"（小声）""*托着下巴看你*"），默认整段不读；也可以只读引号里的话。
 */
export const DEFAULT_TTS_TEXT: TtsTextOptions = {
  quotedOnly: false,
  asterisks: 'drop',
  parentheses: 'drop',
  skipCodeBlocks: true,
  skipTags: true,
};

/** 引号（同 SillyTavern 的多音色分段）："…" “…” «…» 「…」 『…』 ＂…＂ */
const QUOTED = /"([^"]+)"|“([^”]+)”|«([^»]+)»|「([^」]+)」|『([^』]+)』|＂([^＂]+)＂/g;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function prepareTtsText(text: string, options: Partial<TtsTextOptions> & { speakerName?: string } = {}): string {
  const o = { ...DEFAULT_TTS_TEXT, ...options };
  let t = stripControlTags(text).text;
  if (o.skipCodeBlocks) t = t.replace(/```[\s\S]*?```/g, ' ').replace(/~~~[\s\S]*?~~~/g, ' ');
  if (o.skipTags) t = t.replace(/<([a-z][\w-]*)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<\/?[a-z][^>]*>/gi, ' ');
  if (o.regex) {
    const re = compileFilter(o.regex);
    if (re) t = t.replace(re, ' ');
  }
  // 星号包住的动作：整段不读，或者只去掉星号照读
  t = o.asterisks === 'keep' ? t.replace(/\*+/g, '') : t.replace(/\*[^*]*?(?:\*|$)/g, ' ');
  // 括号里的动作、神态，【】里的旁白
  if (o.parentheses !== 'keep') t = t.replace(/（[^（）]*）/g, ' ').replace(/\([^()]*\)/g, ' ').replace(/【[^【】]*】/g, ' ');
  // 只读引号里的话；一句引号都没有时照常读全文（同 SillyTavern）
  if (o.quotedOnly) {
    const parts = [...t.matchAll(QUOTED)].map((m) => (m.slice(1).find((g) => g !== undefined) ?? '').trim()).filter(Boolean);
    if (parts.length) t = parts.map((p, i) => (i < parts.length - 1 && !/[。！？!?…~～，,]$/.test(p) ? `${p}，` : p)).join('');
  }
  if (o.speakerName) t = t.replace(new RegExp(`^\\s*${escapeRegex(o.speakerName)}\\s*[:：]`, 'gm'), '');
  t = t
    // Markdown 图片、链接
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    // 表情符号（含组合用的零宽连接符、变体选择符、肤色）
    .replace(/[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u200d\ufe0e\ufe0f\u20e3]/gu, '')
    // Markdown 记号
    .replace(/[`#>_~]{1,}/g, ' ')
    // 连续的省略号读起来一样：留一个
    .replace(/(……){2,}/g, '……')
    .replace(/\.{4,}/g, '...')
    .replace(/[ \t\u3000]+/g, ' ')
    // 去掉动作描写后中文之间留下的空格（"笨蛋 ……我也是"）
    .replace(/(?<=[^\x00-\x7f]) +| +(?=[^\x00-\x7f])/g, '')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
  return t;
}

/**
 * 按句切开（通话时边合成边播：第一句先出声）。在句末标点后切，太短的并到下一句，太长的再在逗号处切。
 */
export function splitSentences(text: string, maxLen = 60, minLen = 6): string[] {
  const pieces = text
    .split(/(?<=[。！？!?；;…~～\n])/)
    .map((s) => s.trim())
    .filter(Boolean);
  const merged: string[] = [];
  let buf = '';
  for (const p of pieces) {
    buf = buf ? `${buf}${p}` : p;
    if (buf.replace(/[\s\p{P}]/gu, '').length >= minLen) {
      merged.push(buf);
      buf = '';
    }
  }
  if (buf) {
    if (merged.length) merged[merged.length - 1] += buf;
    else merged.push(buf);
  }
  const out: string[] = [];
  for (const s of merged) {
    if (s.length <= maxLen) {
      out.push(s);
      continue;
    }
    let rest = s;
    while (rest.length > maxLen) {
      const window = rest.slice(0, maxLen);
      const cut = Math.max(window.lastIndexOf('，'), window.lastIndexOf(','), window.lastIndexOf('、'), window.lastIndexOf(' '));
      const at = cut > maxLen / 3 ? cut + 1 : maxLen;
      out.push(rest.slice(0, at).trim());
      rest = rest.slice(at);
    }
    if (rest.trim()) out.push(rest.trim());
  }
  return out;
}

/** 文本里有假名就当日语（GPT-SoVITS 要指定语言），否则中文（中文模式能读中英混排） */
export function guessLanguage(text: string): 'zh' | 'ja' | 'en' {
  if (/[\u3040-\u30ff]/.test(text)) return 'ja';
  if (!/[\u4e00-\u9fff]/.test(text) && /[a-z]/i.test(text)) return 'en';
  return 'zh';
}
