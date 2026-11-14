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
export function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('图片读不出来'));
    reader.readAsDataURL(file);
  });
}

export function loadImage(src: string): Promise<HTMLImageElement> {
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

/**
 * 立绘：保留透明，长边压到 max（默认 2048px，手机上整屏立绘也够清楚），优先存 WebP。
 * 浏览器不会编码 WebP 时（iOS Safari）存 PNG；没缩小、压完反而更大时用原文件。
 */
export async function compressPortrait(file: Blob, max = 2048): Promise<{ bytes: Uint8Array<ArrayBuffer>; mime: string; width: number; height: number }> {
  const img = await loadImage(await readAsDataUrl(file));
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) throw new Error('图片读不出来');
  const scale = Math.min(1, max / Math.max(w, h));
  const original = async () => ({ bytes: new Uint8Array(await file.arrayBuffer()), mime: file.type || 'image/png', width: w, height: h });
  if (scale === 1 && file.type === 'image/webp') return original();
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('浏览器不支持 canvas');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const encode = (type: string, quality?: number) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
  let blob = await encode('image/webp', 0.9);
  if (!blob || blob.type !== 'image/webp') blob = await encode('image/png');
  if (!blob) throw new Error('图片压缩失败');
  if (scale === 1 && /^image\/(png|webp|avif|gif)$/.test(file.type) && file.size <= blob.size) return original();
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: blob.type, width: canvas.width, height: canvas.height };
}

/**
 * 发给她看的照片：长边压到 max（默认 1600px）存成 JPEG（各家识图都认），返回字节和尺寸。
 * 手机相机拍的照片常有几千万像素，原样存既占地方、识图也慢。
 */
export async function compressPhoto(file: Blob, max = 1600, quality = 0.86): Promise<{ bytes: Uint8Array<ArrayBuffer>; mime: string; width: number; height: number }> {
  const img = await loadImage(await readAsDataUrl(file));
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) throw new Error('图片读不出来');
  const scale = Math.min(1, max / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('浏览器不支持 canvas');
  // 透明的 PNG 铺白底，转 JPEG 时不会变黑
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  if (!blob) throw new Error('图片压缩失败');
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: 'image/jpeg', width: canvas.width, height: canvas.height };
}

/** 字节 → base64（识图要的格式），分段转，大图也不会爆栈 */
export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
