/**
 * 回复里折起来的部分：<details><summary>标题</summary>内容</details>。
 * SillyTavern 的预设常让模型把每条的总结（summary）、状态栏这样写在回复末尾，ST 里显示成能点开的一块；
 * 这里把它拆出来，聊天气泡里同样显示成折叠块。只认这几个标签，内容仍按文字显示（不当 HTML 插进页面）。
 * 流式时只收到开标签、还没写完的，也先折起来。
 */
export type TextFold = { kind: 'text'; text: string } | { kind: 'fold'; title: string; body: string };

const OPEN = /<details\b[^>]*>/i;
const CLOSE = /<\/details\s*>/i;
const SUMMARY = /<summary\b[^>]*>([\s\S]*?)<\/summary\s*>/i;

/** 折叠块里的 <p>、<br> 换成换行，去掉每行开头的缩进（预设里的格式常带缩进） */
function plain(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?p\b[^>]*>/gi, '\n')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function fold(inner: string): TextFold {
  const s = SUMMARY.exec(inner);
  const body = s ? inner.slice(0, s.index) + inner.slice(s.index + s[0].length) : inner;
  return { kind: 'fold', title: (s && plain(s[1] ?? '')) || '展开', body: plain(body) };
}

export function splitFolds(text: string): TextFold[] {
  if (!OPEN.test(text)) return [{ kind: 'text', text }];
  const out: TextFold[] = [];
  let rest = text;
  for (let m = OPEN.exec(rest); m; m = OPEN.exec(rest)) {
    const before = rest.slice(0, m.index).trimEnd();
    const after = rest.slice(m.index + m[0].length);
    const end = CLOSE.exec(after);
    // 还没写完：末尾半截的标签（"</deta"）先不显示
    const inner = end ? after.slice(0, end.index) : after.replace(/<[^>]*$/, '');
    rest = end ? after.slice(end.index + end[0].length).trimStart() : '';
    if (before) out.push({ kind: 'text', text: before });
    out.push(fold(inner));
  }
  if (rest.trim()) out.push({ kind: 'text', text: rest });
  return out;
}

/** 去掉折叠块，只留正文（剧场模式的对话框里只显示她说的话） */
export function withoutFolds(text: string): string {
  const parts = splitFolds(text);
  if (parts.length === 1 && parts[0]?.kind === 'text') return text;
  return parts
    .map((p) => (p.kind === 'text' ? p.text : ''))
    .filter(Boolean)
    .join('\n');
}
