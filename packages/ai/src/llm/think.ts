/**
 * 有的中转服务和本地部署把思考过程放在正文开头的 <think>…</think> 里。
 * 返回 split(raw) → { text, thinking }：把收到的正文全文拆成正文和思考内容；
 * 开头的标签还没收全（如只收到 "<thi"）时先都不显示（移植自 math-reader 的 createThinkTagSplitter）。
 */
export function createThinkTagSplitter(): (raw: string) => { text: string; thinking: string } {
  let mode: 'unknown' | 'none' | 'open' | 'closed' = 'unknown';
  let lead = 0; // <think> 前的空白长度
  let scanFrom = 7; // 下次从这里找 </think>，避免每段都从头扫描
  let bodyStart = 0;
  let thinking = '';
  return (raw) => {
    if (mode === 'none') return { text: raw, thinking: '' };
    if (mode === 'closed') return { text: raw.slice(bodyStart).replace(/^\s+/, ''), thinking };
    if (mode === 'unknown') {
      lead = raw.length - raw.replace(/^\s+/, '').length;
      const start = raw.slice(lead, lead + 7);
      if (!start || (start.length < 7 && '<think>'.startsWith(start))) return { text: '', thinking: '' };
      if (start !== '<think>') {
        mode = 'none';
        return { text: raw, thinking: '' };
      }
      mode = 'open';
    }
    const end = raw.indexOf('</think>', lead + scanFrom);
    if (end < 0) {
      scanFrom = Math.max(7, raw.length - lead - 7);
      // 末尾可能是收了一半的 </think>，先不显示
      let open = raw.slice(lead + 7);
      const lt = open.lastIndexOf('<');
      if (lt >= 0 && '</think>'.startsWith(open.slice(lt))) open = open.slice(0, lt);
      return { text: '', thinking: open.trim() };
    }
    mode = 'closed';
    thinking = raw.slice(lead + 7, end).trim();
    bodyStart = end + 8;
    return { text: raw.slice(bodyStart).replace(/^\s+/, ''), thinking };
  };
}

/**
 * 一次性拆分（普通响应用）。只有 <think> 没有 </think>（被截断）时当作全是思考、正文为空，和流式时看到的一致；
 * 整段回复恰好是 "<thi" 这种前缀时原样当正文
 */
export function splitThinkTag(raw: string): { text: string; thinking: string } {
  const r = createThinkTagSplitter()(raw);
  if (!r.text && !r.thinking && raw.trim() && !raw.includes('<think>')) return { text: raw, thinking: '' };
  return r;
}
