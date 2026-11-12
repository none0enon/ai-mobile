/**
 * 装成 App 以后（安卓 Chrome），在 B 站 / YouTube 等 App 里点"分享"、选这个 App（manifest 的 share_target）：
 * 浏览器打开 ./?share_title=…&share_text=…&share_url=…
 * 这里在路由创建之前把它换成"一起观影"的地址（带上链接和标题）。地址栏里的参数同时去掉，刷新不会再触发一次。
 * 必须在 router.ts 之前执行（main.ts 第一个 import 它）：哈希路由创建时会把当时的查询参数记成基础地址。
 */
try {
  const q = new URLSearchParams(location.search);
  const title = q.get('share_title')?.trim() ?? '';
  const text = q.get('share_text')?.trim() ?? '';
  const url = q.get('share_url')?.trim() ?? '';
  if (title || text || url) {
    // 链接可能在 url 里，也可能夹在 text 里（B 站分享出来的是"【标题】 链接"这一整段）
    const link = /https?:\/\//i.test(text) || !url ? text : url;
    const params = new URLSearchParams();
    if (link || url) params.set('link', link || url);
    if (title && !text.includes(title)) params.set('title', title);
    history.replaceState(null, '', `${location.pathname}#/scene/watch?${params}`);
  }
} catch {
  // 读不了地址：照常打开
}

export {};
