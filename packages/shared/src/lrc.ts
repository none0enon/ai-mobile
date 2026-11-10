export interface LrcLine {
  timeMs: number;
  text: string;
  /** 网易云 tlyric 里同一时间戳的译文 */
  translation?: string;
}

const STAMP_RE = /^\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/;

function parseOne(src: string): { timeMs: number; text: string }[] {
  const out: { timeMs: number; text: string }[] = [];
  for (const rawLine of src.split(/\r?\n/)) {
    const line = rawLine.trim();
    // 网易云会在歌词里夹 JSON 署名行：{"t":0,"c":[{"tx":"作词: "}...]}
    if (!line || line.startsWith('{')) continue;
    const stamps: number[] = [];
    let rest = line;
    for (let m = STAMP_RE.exec(rest); m; m = STAMP_RE.exec(rest)) {
      const min = Number(m[1]);
      const sec = Number(m[2]);
      // ".5" ".50" ".500" 都是 500ms，".05" 是 50ms
      const frac = m[3] ? Number(m[3].padEnd(3, '0')) : 0;
      stamps.push((min * 60 + sec) * 1000 + frac);
      rest = rest.slice(m[0].length);
    }
    // [ar:歌手] [ti:标题] 这类元信息不匹配数字时间戳，自然跳过
    if (!stamps.length) continue;
    const text = rest.trim();
    for (const timeMs of stamps) out.push({ timeMs, text });
  }
  return out.sort((a, b) => a.timeMs - b.timeMs);
}

/**
 * 解析 LRC 歌词。修掉 Netease_url 自带解析器的问题：
 * 毫秒精度、一行多个时间戳、跳过 JSON 署名行；可合并译文。
 */
export function parseLrc(lrc: string, tlyric?: string): LrcLine[] {
  const lines: LrcLine[] = parseOne(lrc);
  if (tlyric) {
    const translations = new Map(parseOne(tlyric).map((l) => [l.timeMs, l.text]));
    for (const line of lines) {
      const t = translations.get(line.timeMs);
      if (t) line.translation = t;
    }
  }
  return lines;
}

/** 当前播放位置对应第几行（二分查找最后一个 timeMs <= posMs 的行），还没到第一行返回 -1 */
export function lrcIndexAt(lines: LrcLine[], posMs: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((lines[mid]?.timeMs ?? Infinity) <= posMs) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}
