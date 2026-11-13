import type { ChapterSummary } from '@app/shared';

/** Only identical text covering the same messages is a duplicate; equal wording on another day is not. */
export function summaryKey(s: Pick<ChapterSummary, 'chatId' | 'level' | 'fromMessageId' | 'toMessageId' | 'text'>): string {
  return JSON.stringify([s.chatId, s.level, s.fromMessageId, s.toMessageId, s.text]);
}

/** Two windows migrating the same legacy record must write the same IndexedDB key. */
export async function legacySummaryId(s: Parameters<typeof summaryKey>[0]): Promise<string> {
  const key = summaryKey(s);
  // LAN previews may not have SubtleCrypto. The unshortened key is still deterministic and lossless.
  if (!globalThis.crypto?.subtle) return `sum_legacy:${encodeURIComponent(key)}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return `sum_legacy_${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** Retain every original record, but exclude duplicates from timelines, prompts and rollups. */
export function reconcileSummaries(rows: ChapterSummary[]): string[] {
  const groups = new Map<string, ChapterSummary[]>();
  for (const s of rows) {
    if (s.deleted) continue;
    const key = summaryKey(s);
    const group = groups.get(key) ?? [];
    group.push(s);
    groups.set(key, group);
  }
  const changed = new Set<string>();
  const aliases = new Map<string, string>();
  for (const group of groups.values()) {
    // Already rolled-up content must not reappear as an open segment after deduplication.
    group.sort((a, b) => Number(!!b.mergedInto) - Number(!!a.mergedInto) || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    const keep = group[0]!;
    for (const s of group) {
      const duplicateOf = s === keep ? undefined : keep.id;
      if (s.duplicateOf !== duplicateOf) {
        s.duplicateOf = duplicateOf;
        changed.add(s.id);
      }
      if (duplicateOf) aliases.set(s.id, duplicateOf);
    }
  }
  for (const s of rows) {
    const parent = s.mergedInto && aliases.get(s.mergedInto);
    if (parent && parent !== s.id) {
      s.mergedInto = parent;
      changed.add(s.id);
    }
  }
  return [...changed];
}
