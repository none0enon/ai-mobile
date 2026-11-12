/**
 * 字幕：外挂字幕文件（srt / vtt / ass / ssa）→ 按片内时间排好的台词（秒）。
 * 一起观影时她按这些台词知道演到哪、说了什么（设计文档 §9.9）。
 */
export interface SubtitleCue {
  /** 开始、结束（片内秒数） */
  start: number;
  end: number;
  text: string;
}

/** 按文件名或内容认出格式再解析；认不出时按 srt / vtt 读 */
export function parseSubtitles(text: string, fileName = ''): SubtitleCue[] {
  const t = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const cues = /\.(ass|ssa)$/i.test(fileName) || /^\s*\[Script Info\]/im.test(t) || /^\s*\[Events\]/im.test(t) ? parseAss(t) : parseSrtVtt(t);
  const out: SubtitleCue[] = [];
  for (const c of cues.sort((a, b) => a.start - b.start || a.end - b.end)) {
    const prev = out.at(-1);
    // 同一时间段的几行（双语字幕、特效字幕拆开的）合成一条
    if (prev && Math.abs(prev.start - c.start) < 0.05 && Math.abs(prev.end - c.end) < 0.05) {
      if (!prev.text.includes(c.text)) prev.text = `${prev.text} / ${c.text}`;
      continue;
    }
    out.push({ ...c });
  }
  return out;
}

/** 00:01:02,345 / 01:02.345 / 1:02:03.45 → 秒 */
function clockToSec(s: string): number | null {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(s.trim());
  if (!m) return null;
  const frac = m[4] ? Number(`0.${m[4]}`) : 0;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + frac;
}

/** 去掉样式标签：<i>、<font …>、{\an8}，和 ass 的 \N \h */
function cleanText(s: string): string {
  return s
    .replace(/\{[^}]*\}/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\\[Nn]/g, ' ')
    .replace(/\\h/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseSrtVtt(t: string): SubtitleCue[] {
  const out: SubtitleCue[] = [];
  for (const block of t.split(/\n{2,}/)) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, b] = (lines[i] as string).split('-->');
    const start = clockToSec(a ?? '');
    const end = clockToSec((b ?? '').trim().split(/\s+/)[0] ?? '');
    const text = cleanText(lines.slice(i + 1).join(' '));
    if (start === null || end === null || !text) continue;
    out.push({ start, end: Math.max(end, start), text });
  }
  return out;
}

function parseAss(t: string): SubtitleCue[] {
  const out: SubtitleCue[] = [];
  let inEvents = false;
  let fields = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
  for (const raw of t.split('\n')) {
    const line = raw.trim();
    if (/^\[.*\]$/.test(line)) {
      inEvents = /^\[events\]$/i.test(line);
      continue;
    }
    if (!inEvents) continue;
    if (/^format\s*:/i.test(line)) {
      fields = line.replace(/^format\s*:/i, '').split(',').map((f) => f.trim().toLowerCase());
      continue;
    }
    if (!/^dialogue\s*:/i.test(line)) continue;
    // 最后一个字段（Text）里可以有逗号：只切前面几个
    const body = line.replace(/^dialogue\s*:/i, '');
    const parts: string[] = [];
    let rest = body;
    for (let k = 0; k < fields.length - 1; k += 1) {
      const c = rest.indexOf(',');
      if (c < 0) break;
      parts.push(rest.slice(0, c));
      rest = rest.slice(c + 1);
    }
    parts.push(rest);
    const get = (name: string) => parts[fields.indexOf(name)] ?? '';
    const start = clockToSec(get('start'));
    const end = clockToSec(get('end'));
    const text = cleanText(get('text'));
    if (start === null || end === null || !text) continue;
    out.push({ start, end: Math.max(end, start), text });
  }
  return out;
}

/** 片内时间点上（或之前最近）的那一条的下标；还没开始时是 -1 */
export function cueIndexAt(cues: readonly SubtitleCue[], t: number): number {
  let lo = 0;
  let hi = cues.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((cues[mid] as SubtitleCue).start <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** 片内时间 → 00:41:08 */
export function mediaClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s % 60)}`;
}
