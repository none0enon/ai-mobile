import { substituteMacros, type Character } from '@app/shared';
import { useLibraryStore } from '@/stores/library';

/**
 * 交给任务类智能体（节律建世界、立绘写外观 tags）的角色材料：角色卡的几项，加上作者备注和绑定的世界书。
 */

/** 名字、称呼、描述、性格、场景 */
export function characterLines(c: Character, user: string): string {
  const sub = (t: string) => substituteMacros(t, { char: c.name, user }).trim();
  return [
    `名字：${c.name}（界面里称呼"${c.pronoun}"）`,
    c.card.description ? `描述：${sub(c.card.description)}` : '',
    c.card.personality ? `性格：${sub(c.card.personality)}` : '',
    c.card.scenario ? `场景：${sub(c.card.scenario)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** 角色卡的作者备注和绑定的世界书（开着的条目），太长时截断 */
export function sourceLines(c: Character, user: string, budget = 9000): string {
  const lib = useLibraryStore();
  const parts: string[] = [];
  let left = budget;
  if (c.card.creatorNotes.trim()) parts.push(`作者备注：${c.card.creatorNotes.trim().slice(0, 600)}`);
  for (const id of c.lorebookIds) {
    const book = lib.lorebookById(id);
    if (!book) continue;
    for (const e of book.entries) {
      if (!e.enabled || !e.content.trim() || left <= 0) continue;
      const title = e.comment || e.keys.slice(0, 3).join('、');
      const text = substituteMacros(e.content, { char: c.name, user }).trim().slice(0, Math.min(1200, left));
      left -= text.length;
      parts.push(`【${title}】${text}`);
    }
  }
  return parts.length ? `世界书和设定：\n${parts.join('\n')}` : '';
}
