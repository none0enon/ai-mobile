/**
 * 把用户选的图片压小再存：背景长边 1440px，头像裁成正方形 320px。
 * 优先 WebP；iOS Safari 的 canvas 不会编码 WebP，退回 JPEG（先铺白底，透明处不会变黑）。
 * 返回 data URL。正式版（M1 起）存进 IndexedDB，按内容哈希传到 R2，随记录同步。
 */
export interface CompressOptions {
  /** 长边最大像素 */
  max: number;
  /** 居中裁成正方形（头像） */
  square?: boolean;
  quality?: number;
}

/** 用 data URL 读文件（不用 blob: 地址：有些预览环境的内容安全策略不放行 blob: 图片） */
function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('图片读不出来'));
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片读不出来'));
    img.src = src;
  });
}

export async function compressImage(file: Blob, opts: CompressOptions): Promise<string> {
  const img = await loadImage(await readAsDataUrl(file));
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) throw new Error('图片读不出来');
  const side = Math.min(w, h);
  const [sx, sy, sw, sh] = opts.square ? [(w - side) / 2, (h - side) / 2, side, side] : [0, 0, w, h];
  const scale = Math.min(1, opts.max / Math.max(sw, sh));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sw * scale));
  canvas.height = Math.max(1, Math.round(sh * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('浏览器不支持 canvas');
  const quality = opts.quality ?? 0.82;
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  const webp = canvas.toDataURL('image/webp', quality);
  if (webp.startsWith('data:image/webp')) return webp;
  ctx.globalCompositeOperation = 'destination-over';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}
