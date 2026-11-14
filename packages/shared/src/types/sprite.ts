import type { Expression, Pose } from '../expressions.ts';
import type { OutfitKind } from './rhythm.ts';

/**
 * 立绘：一张图就是一个完整的样子（服装 + 动作 + 表情画在一起）。
 * 每个角色的立绘张数、表情、动作、服装都不一样，三样都是她自己的标签，没有固定的一套：
 * - 表情：名字自己起（平静、坏笑、皱眉……），有几个算几个；给模型的提示里只列她有的；
 * - 动作：自己起名（托腮、抱臂……），可以注明适合哪些场景姿势（站 / 坐 / 学习 / 吃饭 / 躺），一起做事时按它挑；
 * - 服装：自己起名，写上和节律衣柜对得上的名字（同 Live2D 的换装），没对上时按用途（日常 / 运动 / 睡衣 / 约会）挑。
 * 同一个样子可以有好几张（变体），换表情时轮着用。
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
  /** 她的表情 id；空 = 还没标 */
  expression: string;
  /** 动作 id；空 = 没分动作 */
  pose: string;
  /** 服装 id；空 = 没分服装 */
  outfit: string;
  /** 对齐：在立绘框里再缩放、平移（框宽 / 框高的比例）。构图不一样的图靠它和别的图对齐，切换时不跳 */
  fit?: PortraitFit;
  /** 不参与自动挑选（留着备用） */
  hidden?: boolean;
  /** AI 画的（"AI 画立绘"）：怎么画出来的，重画、照着它画别的都用它 */
  gen?: PortraitGen;
}

/**
 * 一张 AI 画的立绘是怎么来的：
 * - base 底图：直接画（文生图），之后的表情、动作照着它画；
 * - inpaint 局部重绘（只重画脸）/ emotion（Director Tools 换表情）/ img2img（整张图生图）：照着底图换表情；
 * - reference（精准参考照着底图画）/ prompt（同一个种子换动作 tags 重画）：照着底图换动作。
 */
export interface PortraitGen {
  method: 'base' | 'inpaint' | 'emotion' | 'img2img' | 'reference' | 'prompt';
  /** 发给 NovelAI 的正向 / 负面提示词（套上生图风格以后的） */
  prompt: string;
  negative: string;
  seed: number | null;
  model: string;
  /** 照着哪张画的（底图的 id） */
  from?: string;
  /** 画出来没有透明背景，又用 Director Tools 去了背景 */
  removedBg?: boolean;
  at: number;
}

export interface PortraitFit {
  zoom: number;
  x: number;
  y: number;
}

/** 她的一个表情：id 就是模型写进 [expr:…] 的值，默认跟名字一样（中文也行），改名字时跟着改 */
export interface PortraitExpression {
  id: string;
  label: string;
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
  /** 画这身衣服用的 NovelAI tags（AI 画立绘时用；只写衣服、鞋、配饰） */
  tags?: string;
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
  /** 她的全部表情（按她自己的顺序） */
  expressions: PortraitExpression[];
  poses: PortraitPose[];
  outfits: PortraitOutfit[];
  /** 默认表情：没说要什么表情、或者要的她没有、也没有像的时候用 */
  defaultExpression: string;
  /**
   * 程序在固定时刻（戳一下、练完、碰杯……）会说一种情绪（expressions.ts 里那几个词）；这里写每种情绪用她的哪个表情。
   * 没写的按名字自动对，对不上就不换；写成空字符串 = 这种时刻不换表情
   */
  moments?: Partial<Record<Expression, string>>;
  /** 默认动作 / 服装 id；空 = 不指定 */
  defaultPose: string;
  defaultOutfit: string;
  /** 立绘框的宽高比（宽 / 高），按第一张图定；所有图都放进这个框，底边居中对齐 */
  aspect: number;
  /** 头像框：脸在立绘框里的中心（0-1）和方框边长（占框宽）。头像、表情缩略图按它裁，默认热区也按它摆 */
  face: { x: number; y: number; size: number };
  /** 戳戳乐热区；没有时按脸的位置给一套默认的 */
  hotspots?: PokeHotspot[];
  /** AI 画立绘时照着哪张画别的表情、动作（立绘的 id；导入的图也能当底图）；没有时用最近画的底图 */
  genBase?: string;
}
