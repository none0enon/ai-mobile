export interface Bounds { left: number; right: number; bottom: number; top: number }

export function validBounds(b: Bounds): boolean {
  return Object.values(b).every(Number.isFinite) && b.right > b.left && b.top > b.bottom;
}

/** Uniform screen-space scale, independent of the exported canvas size/origin. */
export function fitSilhouette(bounds: Bounds, width: number, height: number, zoom = 1) {
  const aspect = Math.max(1, width) / Math.max(1, height);
  const z = Number.isFinite(zoom) ? Math.min(1.6, Math.max(0.7, zoom)) : 1;
  const scale = Math.min(1.92 * aspect / (bounds.right - bounds.left), 1.94 / (bounds.top - bounds.bottom)) * z;
  return {
    x: scale / aspect,
    y: scale,
    tx: -(bounds.left + bounds.right) / 2 * scale / aspect,
    // The visible lower edge meets the frame; busts cannot float above captions.
    ty: -1 - bounds.bottom * scale,
  };
}

/** readPixels rows start at the bottom; discard transparent padding, not mesh vertices. */
export function alphaBounds(pixels: Uint8Array, width: number, height: number): Bounds | undefined {
  const bounds = { left: width, right: -1, bottom: height, top: -1 };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (pixels[(y * width + x) * 4 + 3]! < 24) continue;
    bounds.left = Math.min(bounds.left, x);
    bounds.right = Math.max(bounds.right, x + 1);
    bounds.bottom = Math.min(bounds.bottom, y);
    bounds.top = Math.max(bounds.top, y + 1);
  }
  return validBounds(bounds) ? bounds : undefined;
}
