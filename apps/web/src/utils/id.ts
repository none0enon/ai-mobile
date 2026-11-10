/**
 * 生成 id。不用 crypto.randomUUID：局域网 http 预览不是安全上下文，那里没有它。
 */
export function uid(prefix = ''): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  const body = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return prefix ? `${prefix}_${body}` : body;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('aborted', 'AbortError'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new DOMException('aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

export function pick<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)] as T;
}
