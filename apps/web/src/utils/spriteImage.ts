import type { PortraitFit, PortraitSet } from '@app/shared';
import { loadImage, readAsDataUrl, toBase64 } from './image';

/**
 * AI 画立绘用到的图片处理（都在本机 canvas 里做）：看一张图是不是透明底、按透明的轮廓猜脸在哪、
 * 把图改成 NovelAI 收的尺寸（64 的倍数）、画局部重绘的遮罩、把底图垫成精准参考要的尺寸、
 * 立绘框和图片像素之间换算（立绘框的摆法同 PortraitFigure：图底边居中放进框，再按每张图的对齐参数缩放平移）。
 */

export async function decodeImage(blob: Blob): Promise<HTMLImageElement> {
  const img = await loadImage(await readAsDataUrl(blob));
  if (!img.naturalWidth || !img.naturalHeight) throw new Error('图片读不出来');
  return img;
}

function canvasOf(width: number, height: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('浏览器不支持 canvas');
  return { canvas, ctx };
}

async function pngOf(canvas: HTMLCanvasElement): Promise<{ bytes: Uint8Array<ArrayBuffer>; base64: string }> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('图片编码失败');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { bytes, base64: toBase64(bytes) };
}

/** 脸在图里的位置：中心和方框边长，都是占图宽 / 图高的比例（size 占图宽） */
export interface FaceGuess {
  x: number;
  y: number;
  size: number;
}

export interface AlphaInfo {
  width: number;
  height: number;
  /** 透明背景：图的四条边基本都是透明的；和底图比时，底图透明的地方也还是透明的 */
  transparent: boolean;
  /** 按透明的轮廓猜的脸（不是透明底时为空） */
  face: FaceGuess | null;
}

/** 缩到长边 512 读像素（只看透明不透明，够用了） */
async function pixels(blob: Blob, size?: { w: number; h: number }): Promise<{ data: Uint8ClampedArray; w: number; h: number; width: number; height: number }> {
  const img = await decodeImage(blob);
  const scale = Math.min(1, 512 / Math.max(img.naturalWidth, img.naturalHeight));
  const w = size?.w ?? Math.max(1, Math.round(img.naturalWidth * scale));
  const h = size?.h ?? Math.max(1, Math.round(img.naturalHeight * scale));
  const { ctx } = canvasOf(w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return { data: ctx.getImageData(0, 0, w, h).data, w, h, width: img.naturalWidth, height: img.naturalHeight };
}

/**
 * 看一张图是不是透明底，是的话按人的轮廓猜脸：最上面那一截（约一个头高）是头，脸的中心在头顶往下六成处。
 * 猜的脸只是给头像框一个起点，不对的话在"头像框和戳戳乐热区"里拖。
 * compare 给了（构图一样的底图，例如只重画了脸）：底图透明的地方有一成以上变得不透明了，就算没保住透明底（重画的那块铺上了背景）
 */
export async function alphaInfo(blob: Blob, opts: { headRatio?: number; compare?: Blob } = {}): Promise<AlphaInfo> {
  const { data, w, h, width, height } = await pixels(blob);
  const alpha = (x: number, y: number) => data[(y * w + x) * 4 + 3] ?? 255;
  let edge = 0;
  let clear = 0;
  for (let x = 0; x < w; x++) {
    for (const y of [0, h - 1]) {
      edge++;
      if (alpha(x, y) < 16) clear++;
    }
  }
  for (let y = 1; y < h - 1; y++) {
    for (const x of [0, w - 1]) {
      edge++;
      if (alpha(x, y) < 16) clear++;
    }
  }
  let transparent = edge > 0 && clear / edge >= 0.9;
  if (transparent && opts.compare) {
    const base = await pixels(opts.compare, { w, h });
    let was = 0;
    let filled = 0;
    for (let i = 3; i < data.length; i += 4) {
      if ((base.data[i] ?? 255) >= 16) continue;
      was++;
      if ((data[i] ?? 0) > 200) filled++;
    }
    if (was && filled / was > 0.1) transparent = false;
  }
  if (!transparent) return { width, height, transparent, face: null };
  // 每一行不透明的像素
  const minRun = Math.max(2, Math.round(w * 0.01));
  const rows: number[] = [];
  for (let y = 0; y < h; y++) {
    let n = 0;
    for (let x = 0; x < w; x++) if (alpha(x, y) > 32) n++;
    rows.push(n);
  }
  const top = rows.findIndex((n) => n >= minRun);
  let bottom = -1;
  for (let y = h - 1; y >= 0; y--) {
    if ((rows[y] ?? 0) >= minRun) {
      bottom = y;
      break;
    }
  }
  if (top < 0 || bottom <= top) return { width, height, transparent, face: null };
  const head = (bottom - top) * (opts.headRatio ?? 0.15);
  // 脸的左右按头那一截（避开头顶的呆毛、耳朵）不透明像素的平均位置
  let sx = 0;
  let count = 0;
  for (let y = Math.round(top + head * 0.3); y <= Math.min(h - 1, Math.round(top + head * 0.9)); y++) {
    for (let x = 0; x < w; x++) {
      if (alpha(x, y) > 32) {
        sx += x;
        count++;
      }
    }
  }
  const cx = count ? sx / count : w / 2;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  return {
    width,
    height,
    transparent,
    face: { x: clamp(cx / w, 0.05, 0.95), y: clamp((top + head * 0.6) / h, 0.03, 0.9), size: clamp(head / w, 0.05, 0.9) },
  };
}

/**
 * 改成 NovelAI 收的样子：PNG，宽高是 64 的倍数；面积超过 maxArea 时按比例缩小（图生图、局部重绘、换表情都要用原图的宽高出图）
 */
export async function novelaiImage(blob: Blob, maxArea: number): Promise<{ bytes: Uint8Array<ArrayBuffer>; base64: string; width: number; height: number }> {
  const img = await decodeImage(blob);
  const w0 = img.naturalWidth;
  const h0 = img.naturalHeight;
  const s = Math.min(1, Math.sqrt(maxArea / (w0 * h0)));
  const snap = (n: number) => Math.max(64, Math.round(n / 64) * 64);
  const width = snap(w0 * s);
  const height = snap(h0 * s);
  const { canvas, ctx } = canvasOf(width, height);
  ctx.drawImage(img, 0, 0, width, height);
  return { ...(await pngOf(canvas)), width, height };
}

/** 局部重绘的遮罩：和图一样大，黑底，要重画的方框涂白（坐标是像素） */
export async function rectMask(width: number, height: number, rect: { x: number; y: number; w: number; h: number }): Promise<string> {
  const { canvas, ctx } = canvasOf(width, height);
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(Math.round(rect.x), Math.round(rect.y), Math.round(rect.w), Math.round(rect.h));
  return (await pngOf(canvas)).base64;
}

/**
 * 精准参考的参考图：铺在白底上（官方建议"站着、中性姿势、简单的背景"），按比例最接近的那种尺寸居中垫好
 */
export async function referenceImage(blob: Blob, canvases: readonly { width: number; height: number }[]): Promise<string> {
  const img = await decodeImage(blob);
  const ratio = img.naturalWidth / img.naturalHeight;
  const target = [...canvases].sort((a, b) => Math.abs(Math.log(a.width / a.height / ratio)) - Math.abs(Math.log(b.width / b.height / ratio)))[0] ?? { width: 1024, height: 1536 };
  const { canvas, ctx } = canvasOf(target.width, target.height);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, target.width, target.height);
  const s = Math.min(target.width / img.naturalWidth, target.height / img.naturalHeight);
  const dw = img.naturalWidth * s;
  const dh = img.naturalHeight * s;
  ctx.drawImage(img, (target.width - dw) / 2, (target.height - dh) / 2, dw, dh);
  return (await pngOf(canvas)).base64;
}

// —— 立绘框 ↔ 图片像素 ——
// 立绘框按高度算单位：宽 aspect、高 1。图按 contain 放进框、底边居中；再以框的底边中点为原点缩放 zoom、平移 (x·宽, y·高)。

interface Placement {
  /** 每个像素多少（框高的单位） */
  c: number;
  left: number;
  top: number;
  zoom: number;
  tx: number;
  ty: number;
  aspect: number;
}

function placement(aspect: number, width: number, height: number, fit?: PortraitFit): Placement {
  const c = Math.min(aspect / width, 1 / height);
  return { c, left: (aspect - width * c) / 2, top: 1 - height * c, zoom: fit?.zoom || 1, tx: (fit?.x ?? 0) * aspect, ty: fit?.y ?? 0, aspect };
}

/** 头像框（PortraitSet.face）在这张图里是哪一块（像素）：中心和方框边长 */
export function faceInImage(set: Pick<PortraitSet, 'face' | 'aspect'>, img: { width: number; height: number; fit?: PortraitFit }): { cx: number; cy: number; side: number } {
  const p = placement(set.aspect, img.width, img.height, img.fit);
  const ox = p.aspect / 2;
  // 框里的点 → 变换之前的点 → 像素
  const fx = ox + (set.face.x * p.aspect - p.tx - ox) / p.zoom;
  const fy = 1 + (set.face.y - p.ty - 1) / p.zoom;
  return { cx: (fx - p.left) / p.c, cy: (fy - p.top) / p.c, side: (set.face.size * p.aspect) / (p.zoom * p.c) };
}

/**
 * 新画的一张怎么对齐到这个角色的立绘框：让猜到的脸落在头像框上（大小也对上），切换时不跳。
 * 限制在编辑页"对齐"能调的范围里（大小 50%–200%，左右上下 ±50%），猜歪了也不至于离谱，还能再手动对齐
 */
export function alignFit(set: Pick<PortraitSet, 'face' | 'aspect'>, img: { width: number; height: number }, face: FaceGuess): PortraitFit {
  const p = placement(set.aspect, img.width, img.height);
  const zoom = Math.min(2, Math.max(0.5, (set.face.size * p.aspect) / (face.size * img.width * p.c)));
  const ox = p.aspect / 2;
  const px = p.left + face.x * img.width * p.c;
  const py = p.top + face.y * img.height * p.c;
  const tx = set.face.x * p.aspect - ox - zoom * (px - ox);
  const ty = set.face.y - 1 - zoom * (py - 1);
  const round = (n: number) => Math.round(Math.min(0.5, Math.max(-0.5, n)) * 1000) / 1000;
  return { zoom: Math.round(zoom * 1000) / 1000, x: round(tx / p.aspect), y: round(ty) };
}
