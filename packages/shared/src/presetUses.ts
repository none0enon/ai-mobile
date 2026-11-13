import { SCENES, type SceneId } from './scenes.ts';
import type { PresetCategory } from './types/preset.ts';

/**
 * 用预设的地方：每个调用 AI 的功能用哪一类预设。
 * - 对话：每个角色自己选（Character.presetId），不在这张表里；
 * - 语音通话（call）：选一个对话预设（默认"通话 · 短句"），或者"跟随对话预设"；
 * - 一起做事的每件事（scene:meal 等）、主动消息：选一个对应分类的预设，或者"跟随对话预设"（用这个角色的对话预设）；
 * - 小剧场（番外）、总结、配图（image）、节律：选一个对应分类的预设；
 * - 一起做事时画的图（image:study 等）：选一个生图预设，或者"跟随配图"（用配图选的那个）。
 */
export type FeatureSceneId = Exclude<SceneId, 'free'>;
export type PresetUseId = 'call' | 'proactive' | 'theater' | 'summary' | 'consolidate' | 'image' | 'rhythm' | `scene:${FeatureSceneId}` | `image:${FeatureSceneId}`;

export interface PresetUse {
  id: PresetUseId;
  category: PresetCategory;
  label: string;
  desc: string;
  icon: string;
  /** 可以选"跟随…"：chat 跟随对话预设（一起做事、主动消息）；image 跟随配图（一起做事时画的图）；null 不能跟随 */
  follow: 'chat' | 'image' | null;
}

/**
 * 一起做事时自动画图的时刻（设计文档 §10.3）：生图预设里块的触发条件写时刻名，画哪个时刻就只发那一块。
 * 名字是协议（写进预设文件），中文是界面文字。还没有时刻的场景，画图时跟随配图的"画一个场景"。
 */
export const IMAGE_MOMENTS: Partial<Record<FeatureSceneId, Record<string, string>>> = {
  study: { seat: '入座', peek: '偷拍', reward: '奖励', mine: '你这边' },
};

/** 时刻的中文名（所有场景一起查） */
export function momentLabel(moment: string): string | undefined {
  for (const m of Object.values(IMAGE_MOMENTS)) if (m?.[moment]) return m[moment];
  return undefined;
}

export const PRESET_USES: PresetUse[] = [
  { id: 'call', category: 'chat', label: '语音通话', desc: '打电话时她说的话：短句、口语、不写动作，方便边生成边合成语音', icon: 'i-lucide-phone', follow: 'chat' },
  ...SCENES.map((s): PresetUse => ({ id: `scene:${s.id as FeatureSceneId}`, category: 'feature', label: s.name, desc: `${s.name}时的对话`, icon: s.icon, follow: 'chat' })),
  { id: 'proactive', category: 'proactive', label: '主动消息', desc: '到点时角色先发来的那条', icon: 'i-lucide-bell-ring', follow: 'chat' },
  { id: 'theater', category: 'theater', label: '番外', desc: '"我的 → 试一试 → 写一段番外"', icon: 'i-lucide-book-heart', follow: null },
  { id: 'summary', category: 'summary', label: '总结聊天', desc: '每攒够几条（"我的 → 消息设置"里改）自动写梗概、故事片段和记忆，聊天 ⋯ 里也能手动整理', icon: 'i-lucide-notebook-pen', follow: null },
  { id: 'consolidate', category: 'summary', label: '记忆整理', desc: '每天凌晨 4 点在云端合并重复的记忆、合并时间线、过期的事改时态、修改画像卡；记忆本里也能"立即整理"', icon: 'i-lucide-sparkles', follow: null },
  { id: 'image', category: 'image', label: '配图', desc: '聊天 ＋ → 生成配图、聊天里的 [cg:]、番外的那一幕：先写成 NovelAI tags 再调生图 API', icon: 'i-lucide-image', follow: null },
  ...SCENES.map((s): PresetUse => {
    const moments = IMAGE_MOMENTS[s.id as FeatureSceneId];
    return {
      id: `image:${s.id as FeatureSceneId}`,
      category: 'image',
      label: s.name,
      desc: moments ? `${s.name}时自动画的图：${Object.values(moments).join('、')}` : `${s.name}时画的图`,
      icon: s.icon,
      follow: 'image',
    };
  }),
  { id: 'rhythm', category: 'rhythm', label: '节律', desc: '导入角色后建她的世界；每天排她的作息、三餐和穿着（"我的 → 节律"）', icon: 'i-lucide-calendar-clock', follow: null },
];

export function presetUse(id: PresetUseId): PresetUse | undefined {
  return PRESET_USES.find((u) => u.id === id);
}

/** 在这个场景里对话用哪个用途（自由聊天没有，用对话预设） */
export function sceneUse(sceneId: string | null | undefined): PresetUseId | null {
  return sceneId && SCENES.some((s) => s.id === sceneId) ? (`scene:${sceneId}` as PresetUseId) : null;
}

/** 在这个场景里画图用哪个用途（自由聊天没有，用配图） */
export function sceneImageUse(sceneId: string | null | undefined): PresetUseId {
  return sceneId && SCENES.some((s) => s.id === sceneId) ? (`image:${sceneId}` as PresetUseId) : 'image';
}
