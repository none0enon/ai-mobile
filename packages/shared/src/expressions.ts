/**
 * 默认表情 / 服装 / 姿势表。真立绘导入后，以立绘套装里实际有图的为准，
 * 并且只把有图的表情写进给模型的提示（避免模型用了没有图的表情）。
 */
export const EXPRESSIONS = [
  'neutral',
  'smile',
  'laugh',
  'blush',
  'shy',
  'pout',
  'surprised',
  'sad',
  'angry',
  'sleepy',
  'sleep',
] as const;

export type Expression = (typeof EXPRESSIONS)[number];

export const EXPRESSION_LABELS: Record<Expression, string> = {
  neutral: '平静',
  smile: '微笑',
  laugh: '大笑',
  blush: '脸红',
  shy: '害羞',
  pout: '嘟嘴',
  surprised: '惊讶',
  sad: '难过',
  angry: '生气',
  sleepy: '犯困',
  sleep: '睡着',
};

export function isExpression(value: unknown): value is Expression {
  return typeof value === 'string' && (EXPRESSIONS as readonly string[]).includes(value);
}

export const OUTFITS = {
  daily: '日常',
  sport: '运动服',
  pajama: '睡衣',
  date: '约会装',
  apron: '围裙',
} as const;

export type Outfit = keyof typeof OUTFITS;

export const POSES = {
  stand: '站立',
  sit: '坐',
  study: '学习',
  eat: '吃饭',
  lie: '躺',
} as const;

export type Pose = keyof typeof POSES;
