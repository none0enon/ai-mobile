import type { CharacterLive2D } from '@app/shared';
import type { ModelManifest } from './model';
import type { Gesture } from './gesture';

const aliases: Record<string, string[]> = {
  neutral: ['neutral', 'calm', 'normal', '平静'], smile: ['smile', 'smirk', 'happy', 'joy', '微笑'],
  laugh: ['laugh', 'smirk', 'happy'], blush: ['blush', 'soft', 'shy'], shy: ['shy', 'soft', 'blush'],
  pout: ['pout', 'angry', 'cool'], surprised: ['surprised', 'surprise', 'shock'],
  sad: ['sad', 'sadness', 'soft'], angry: ['angry', 'anger', '生气'], sleepy: ['sleepy', 'cool', 'calm'], sleep: ['sleep', 'cool', 'calm'],
};
export const ACTION_LABELS: Record<string, string> = { greeting: '打招呼', agree: '赞同', disagree: '否定' };

export function defaultBindings(m: ModelManifest): Pick<CharacterLive2D, 'expressions' | 'motions' | 'expressionMap' | 'motionMap'> {
  const expressions = (m.FileReferences.Expressions ?? []).map(e => e.Name);
  const motions = Object.entries(m.FileReferences.Motions ?? {}).flatMap(([g, items]) => items.map((_, i) => `${g}:${i}`));
  const find = (candidates: string[]) => candidates.map(a => expressions.find(e => e.toLowerCase() === a)).find(Boolean) ?? '';
  const expressionMap = Object.fromEntries(Object.entries(aliases).map(([key, candidates]) => [key, find(candidates) || find(aliases.neutral!)]));
  const motionMap = Object.fromEntries(Object.entries({ greeting: ['greeting', 'wave'], agree: ['nod', 'agree'], disagree: ['shake', 'disagree'], ...aliases }).map(([key, candidates]) => [key, motions.find(m => candidates.includes(m.split(':')[0]!.toLowerCase())) ?? '']));
  return { expressions, motions, expressionMap, motionMap };
}

export function dialogueCue(text: string): 'greeting' | 'agree' | 'disagree' | '' {
  if (/(你好|早安|早上好|晚安|再见|拜拜|挥手|hello|\bhi\b|goodbye)/i.test(text)) return 'greeting';
  if (/(不行|不可以|不同意|别这样|摇头|\bno\b|disagree)/i.test(text)) return 'disagree';
  if (/(好呀|好啊|好的|可以|没问题|当然|点头|\byes\b|agree)/i.test(text)) return 'agree';
  return '';
}

/** Immediate target changes; gestures never wait for previous gestures to finish. */
export function gestureFor(expression: string, text = ''): Gesture {
  if (dialogueCue(text) === 'greeting') return 'wave';
  return ['angry', 'pout', 'cool'].includes(expression) ? 'crossed' : 'rest';
}

export function mouthLevel(level: number, audible: boolean): number {
  return audible && Number.isFinite(level) && level > 0.035 ? Math.min(1, Math.max(0, level)) : 0;
}
