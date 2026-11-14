import type { DayOutfit } from './types/rhythm.ts';

/**
 * 按节律里今天穿的那套挑一身（Live2D 换装、立绘的服装共用）：
 * 名字完全一样的最先；再看名字、别名、tags 里有没有出现在今天这套的名字或 tags 里，取最长的那个词对上的。
 * 都没对上时返回 undefined，由调用的地方决定退回哪一身。
 */
const normalize = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[_\s-]+/g, ' ').trim();

function includesTerm(haystack: string, term: string) {
  const at = haystack.indexOf(term);
  if (at < 0) return false;
  // 英文 tag 按整词对："armor" 不能对上 "armorless"
  if (/^[a-z0-9 ]+$/.test(term)) return ` ${haystack} `.includes(` ${term} `) || haystack.split(/[,，;；|/]+/).some((s) => s.trim() === term);
  return true;
}

export function matchOutfit<T>(items: readonly T[], desired: DayOutfit | undefined, terms: (item: T) => { name: string; match?: string }): T | undefined {
  if (!desired) return undefined;
  const name = normalize(desired.name);
  const text = normalize(`${desired.name},${desired.tags}`).replace(/[,，;；|/]+/g, ' ');
  const exact = name ? items.find((o) => normalize(terms(o).name) === name) : undefined;
  if (exact) return exact;
  let match: T | undefined;
  let score = 0;
  for (const item of items) {
    const t = terms(item);
    for (const raw of [t.name, ...(t.match ?? '').split(/[,，;；\n|]+/)]) {
      const term = normalize(raw);
      if (term.length >= 2 && term.length > score && includesTerm(text, term)) {
        match = item;
        score = term.length;
      }
    }
  }
  return match;
}
