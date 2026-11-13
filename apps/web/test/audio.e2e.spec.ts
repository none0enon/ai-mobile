import { test, expect } from '@playwright/test';

test('actual audio levels close during PCM silence, abort, and playback rejection', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { playBytes } = await import('/src/services/audio.ts');
    const original = HTMLMediaElement.prototype.play;
    let active: HTMLMediaElement;
    HTMLMediaElement.prototype.play = function () { active = this; return original.call(this); };
    const samples = 24000 * 3;
    const bytes = new Uint8Array(44 + samples * 2);
    const view = new DataView(bytes.buffer);
    const text = (offset: number, text: string) => [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
    text(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); text(8, 'WAVEfmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, 24000, true); view.setUint32(28, 48000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    text(36, 'data'); view.setUint32(40, samples * 2, true);
    for (let i = 0; i < samples; i++) view.setInt16(44 + i * 2, i >= 24000 && i < 48000 ? 0 : Math.sin(i * 2 * Math.PI * 220 / 24000) * 16000, true);
    const levels: { t: number; level: number }[] = [];
    const playback = await playBytes(bytes, 'audio/wav', { onAudioLevel: level => levels.push({ t: active?.currentTime ?? 0, level }) });
    const abort = new AbortController();
    const aborted: number[] = [];
    const second = playBytes(bytes, 'audio/wav', { signal: abort.signal, onAudioLevel: level => aborted.push(level) });
    setTimeout(() => abort.abort(), 400);
    await second;
    HTMLMediaElement.prototype.play = () => Promise.reject(new DOMException('blocked', 'NotAllowedError'));
    const blocked: number[] = [];
    let rejected;
    try { rejected = await playBytes(bytes, 'audio/wav', { onAudioLevel: level => blocked.push(level) }); }
    finally { HTMLMediaElement.prototype.play = original; }
    return { playback, levels, aborted, rejected, blocked };
  });
  expect(result.playback.ok).toBe(true);
  expect(result.levels.some(l => l.level > 0.5)).toBe(true);
  const silence = result.levels.filter(l => l.t > 1.15 && l.t < 1.8);
  expect(silence.length).toBeGreaterThan(2);
  expect(silence.every(l => l.level === 0)).toBe(true);
  expect(result.levels.at(-1)!.level).toBe(0);
  expect(result.aborted.some(l => l > 0)).toBe(true);
  expect(result.aborted.at(-1)).toBe(0);
  expect(result.rejected.ok).toBe(false);
  expect(result.blocked.every(l => l === 0)).toBe(true);
});
