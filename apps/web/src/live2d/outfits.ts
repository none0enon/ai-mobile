import type { CharacterLive2D, DayOutfit, Live2DOutfit, Live2DParameter, RhythmSlot } from '@app/shared';

export function isMadaraRig(parameters: Live2DParameter[]): boolean {
  return ['ParamGestureLive', 'ParamGestureRaise', 'ParamGestureFold', 'ParamOutfitPose'].every(id => parameters.some(p => p.id === id));
}

export function suggestedOutfits(parameters: Live2DParameter[]): Live2DOutfit[] {
  if (isMadaraRig(parameters)) return [
    { id: 'armour', name: '铠甲', match: '铠甲,盔甲,战甲,armour,armor', parameters: { ParamOutfitPose: 0 } },
    { id: 'clan', name: '族服', match: '族服,宇智波族服,clan,clan outfit', parameters: { ParamOutfitPose: 3 } },
  ];
  // Only discrete clothing selectors; never mistake skirt/sleeve physics for outfits.
  const selectors = parameters.filter(p => /outfit|costume|clothes|clothing|服装|衣装|衣服|换装/i.test(`${p.id} ${p.name}`)
    && !/sway|swing|physics|angle|摆动|物理/i.test(`${p.id} ${p.name}`)
    && Number.isInteger(p.min) && Number.isInteger(p.max) && p.max > p.min && p.max - p.min <= 12);
  const defaults = Object.fromEntries(selectors.map(p => [p.id, p.default]));
  return [
    { id: 'model-default', name: '模型原装', match: '', parameters: defaults },
    ...selectors.flatMap(p => Array.from({ length: p.max - p.min + 1 }, (_, i) => i + p.min).filter(v => v !== p.default).map(value => ({
      id: `${p.id}:${value}`, name: `${p.name} ${value}`, match: '', parameters: { ...defaults, [p.id]: value },
    }))),
  ];
}

const normalize = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[_\s-]+/g, ' ').trim();
function includesTerm(haystack: string, term: string) {
  const at = haystack.indexOf(term);
  if (at < 0) return false;
  // English tags match words: "armor" must not match "armorless".
  if (/^[a-z0-9 ]+$/.test(term)) return (` ${haystack} `).includes(` ${term} `) || haystack.split(/[,，;；|/]+/).some(s => s.trim() === term);
  return true;
}

/** Exact garment names first, then explicit aliases/tags, then the saved default. */
export function selectOutfit(config: Pick<CharacterLive2D, 'outfits' | 'defaultOutfit'>, desired?: DayOutfit, fallback: Live2DOutfit[] = []): Live2DOutfit | undefined {
  const outfits = config.outfits?.length ? config.outfits : fallback;
  const name = normalize(desired?.name ?? '');
  const text = normalize(`${desired?.name ?? ''},${desired?.tags ?? ''}`).replace(/[,，;；|/]+/g, ' ');
  const exact = name && outfits.find(o => normalize(o.name) === name);
  if (exact) return exact;
  let match: Live2DOutfit | undefined;
  let score = 0;
  for (const outfit of outfits) {
    const terms = [outfit.name, ...outfit.match.split(/[,，;；\n|]+/)];
    for (const raw of terms) {
      const term = normalize(raw);
      if (term.length >= 2 && term.length > score && includesTerm(text, term)) { match = outfit; score = term.length; }
    }
  }
  return match ?? outfits.find(o => o.id === config.defaultOutfit) ?? outfits[0];
}

/** A call follows the character's current rhythm activity, including custom locations. */
export function outfitScene(slot?: RhythmSlot): 'sleep' | 'exercise' | 'date' | null {
  const activity = slot?.status ?? '';
  if (/睡觉|睡眠|入睡|就寝|午睡|sleep|bedtime/i.test(activity)) return 'sleep';
  if (/锻炼|健身|训练|跑步|游泳|打球|运动|workout|training|jogging/i.test(activity)) return 'exercise';
  if (/约会|\bdate\b|\bdating\b/i.test(activity)) return 'date';
  return null;
}
