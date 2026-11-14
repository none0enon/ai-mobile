import type { Expression, Pose } from '../expressions.ts';
import type { OutfitKind } from './rhythm.ts';

/**
 * 立绘：一张图就是一个完整的样子（服装 + 动作 + 表情画在一起）。
 * 每个角色的立绘张数、表情、动作、服装都不一样，所以三样都是"标签"，不是固定的格子：
 * - 表情：11 个基础表情（expressions.ts）之外可以自己加（坏笑、不屑……），每个自定义表情挂一个最接近的基础表情，
 *   缺图回退、语音的情绪、Live2D 都按它；
 * - 动作：自己起名（托腮、抱臂……），可以注明适合哪些场景姿势（站 / 坐 / 学习 / 吃饭 / 躺），一起做事时按它挑；
 * - 服装：自己起名，写上和节律衣柜对得上的名字（同 Live2D 的换装），没对上时按用途（日常 / 运动 / 睡衣 / 约会）挑。
 * 同一个表情可以有好几张（变体），切表情时轮着用。
 * 图片存在这台设备的 IndexedDB 素材库（按内容哈希），角色上只记元数据（同 Live2D）。
 */
export interface Portrait {
  id: string;
  /** 本机素材库里的 key（内容哈希） */
  assetKey: string;
  /** 导入时的文件名（去掉扩展名），方便认 */
  name: string;
  width: number;
  height: number;
  /** 基础表情 id 或自定义表情 id */
  expression: string;
  /** 动作 id；空 = 没分动作 */
  pose: string;
  /** 服装 id；空 = 没分服装 */
  outfit: string;
  /** 对齐：在立绘框里再缩放、平移（框宽 / 框高的比例）。构图不一样的图靠它和别的图对齐，切换时不跳 */
  fit?: PortraitFit;
  /** 不参与自动挑选（留着备用） */
  hidden?: boolean;
}

export interface PortraitFit {
  zoom: number;
  x: number;
  y: number;
}

/** 自定义表情：id 就是写进 [expr:…] 的值（中文也行） */
export interface PortraitExpression {
  id: string;
  label: string;
  /** 最接近的基础表情 */
  base: Expression;
  /** 写给模型看：什么时候用 */
  hint?: string;
}

export interface PortraitPose {
  id: string;
  label: string;
  /** 写给模型看：什么时候换成这个动作 */
  hint?: string;
  /** 适合的场景姿势（一起学习要 study、一起吃饭要 eat……）；不写 = 哪儿都能用 */
  fits?: Pose[];
}

export interface PortraitOutfit {
  id: string;
  label: string;
  /** 用途：节律里今天的那套没对上名字时，按用途挑 */
  kind?: OutfitKind;
  /** 和节律衣柜对得上的名字、别名、tags（逗号分隔），同 Live2D 换装 */
  match?: string;
}

/** 坐标都是相对立绘框的 0-1 比例，和图片分辨率无关 */
export type HotspotShape =
  | { kind: 'rect'; x: number; y: number; w: number; h: number }
  | { kind: 'polygon'; points: [number, number][] };

export interface PokeReaction {
  expression: string;
  /** 本地台词池：点击后立刻随机出一句（零延迟），AI 反应稍后再来 */
  lines: string[];
}

/** 戳戳乐热区 */
export interface PokeHotspot {
  id: string;
  /** head / cheek / shoulder / hand …，会写进"你拍了拍她的头"和给 AI 的提示 */
  part: string;
  label: string;
  shape: HotspotShape;
  tap: PokeReaction;
  longPress?: PokeReaction;
}

/** 一个角色的全部立绘（挂在 Character.portraits 上） */
export interface PortraitSet {
  portraits: Portrait[];
  /** 自定义表情（基础表情不用写） */
  expressions: PortraitExpression[];
  poses: PortraitPose[];
  outfits: PortraitOutfit[];
  /** 默认动作 / 服装 id；空 = 不指定 */
  defaultPose: string;
  defaultOutfit: string;
  /** 立绘框的宽高比（宽 / 高），按第一张图定；所有图都放进这个框，底边居中对齐 */
  aspect: number;
  /** 头像框：脸在立绘框里的中心（0-1）和方框边长（占框宽）。头像、表情缩略图按它裁，默认热区也按它摆 */
  face: { x: number; y: number; size: number };
  /** 戳戳乐热区；没有时按脸的位置给一套默认的 */
  hotspots?: PokeHotspot[];
}
