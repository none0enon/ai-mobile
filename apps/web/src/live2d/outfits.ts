import { matchOutfit, type CharacterLive2D, type DayOutfit, type Live2DOutfit, type Live2DParameter, type RhythmSlot } from '@app/shared';

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

/** Exact garment names first, then explicit aliases/tags, then the saved default. */
export function selectOutfit(config: Pick<CharacterLive2D, 'outfits' | 'defaultOutfit'>, desired?: DayOutfit, fallback: Live2DOutfit[] = []): Live2DOutfit | undefined {
  const outfits = config.outfits?.length ? config.outfits : fallback;
  return matchOutfit(outfits, desired, (o) => o) ?? outfits.find(o => o.id === config.defaultOutfit) ?? outfits[0];
}

/** A call follows the character's current rhythm activity, including custom locations. */
export function outfitScene(slot?: RhythmSlot): 'sleep' | 'exercise' | 'date' | null {
  const activity = slot?.status ?? '';
  if (/睡觉|睡眠|入睡|就寝|午睡|sleep|bedtime/i.test(activity)) return 'sleep';
  if (/锻炼|健身|训练|跑步|游泳|打球|运动|workout|training|jogging/i.test(activity)) return 'exercise';
  if (/约会|\bdate\b|\bdating\b/i.test(activity)) return 'date';
  return null;
}
