import type { Character } from './types/character.ts';

/**
 * 生图 tags 的小工具：前端和 Worker 共用（@app/ai 的生图提示词智能体也用这里的 joinTags）。
 */

/** 逗号分隔的 tags 合并：去掉空项和重复项（不区分大小写），保留第一次出现的顺序 */
export function joinTags(...lists: (string | undefined | null)[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const raw of (list ?? '').split(/[,，\n]/)) {
      const tag = raw.trim();
      const key = tag.toLowerCase();
      if (!tag || seen.has(key)) continue;
      seen.add(key);
      out.push(tag);
    }
  }
  return out.join(', ');
}

/** 人数一类的 tags（1girl、2boys、solo、no humans……）：NovelAI 建议写在最前面 */
const COUNT_TAG = /^(?:\d+\+?(?:girls?|boys?|others?)|solo|solo focus|no humans|multiple (?:girls|boys|others))$/i;

/** 把人数 tags 挑出来：{ lead: '1girl, solo', rest: '其余' }。拼最终提示词时放在角色 tag、外观 tags 前面 */
export function leadCountTags(tags: string): { lead: string; rest: string } {
  const lead: string[] = [];
  const rest: string[] = [];
  for (const raw of tags.split(/[,，\n]/)) {
    const t = raw.trim();
    if (!t) continue;
    (COUNT_TAG.test(t) ? lead : rest).push(t);
  }
  return { lead: lead.join(', '), rest: rest.join(', ') };
}

/** 打了"同人"标记、也填了角色 tag */
export function isFandom(c: Pick<Character, 'fandom'> | null | undefined): boolean {
  return !!c?.fandom?.enabled && !!c.fandom.characterTag.trim();
}

/**
 * 生图时她的长相（{{char_appearance}}，程序加在提示词最前面）：
 * - 同人：角色 tag + 作品 tag，再加你补的外观 tags（NovelAI 认不全的地方，可以不写）；
 * - 原创：外观 tags。
 */
export function imageAppearance(c: Pick<Character, 'fandom' | 'appearanceTags'>): string {
  if (!isFandom(c)) return joinTags(c.appearanceTags);
  return joinTags(c.fandom?.characterTag, c.fandom?.copyrightTag, c.appearanceTags);
}
