import { stripControlTags } from '@app/shared';

/**
 * 朗读前的文字处理（设计文档 §11.1）：去掉控制标签、（动作描写）、*动作*、表情符号、Markdown 记号和链接。
 * 括号里的通常是动作或神态（"（小声）""(托着下巴看你)"），读出来很出戏，所以整段去掉。
 */
export function prepareTtsText(text: string): string {
  let t = stripControlTags(text).text;
  t = t
    // 动作描写：全角 / 半角括号、星号、方括号里的旁白
    .replace(/（[^（）]*）/g, ' ')
    .replace(/\([^()]*\)/g, ' ')
    .replace(/\*[^*\n]+\*/g, ' ')
    .replace(/【[^【】]*】/g, ' ')
    // 链接
    .replace(/https?:\/\/\S+/g, ' ')
    // 表情符号（含组合用的零宽连接符、变体选择符、肤色）
    .replace(/[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u200d\ufe0e\ufe0f\u20e3]/gu, '')
    // Markdown 记号
    .replace(/[`#>_~]{1,}/g, ' ')
    .replace(/\*+/g, '')
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
