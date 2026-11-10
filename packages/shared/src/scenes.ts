import type { Outfit, Pose } from './expressions.ts';
import type { ControlTagKind } from './tags.ts';
import type { ProactiveTriggerId } from './types/proactive.ts';

export type SceneId = 'free' | 'exercise' | 'meal' | 'study' | 'sleep' | 'music' | 'date' | 'poke';

export type TimeOfDay = 'dawn' | 'morning' | 'noon' | 'afternoon' | 'dusk' | 'night' | 'late';

/**
 * 场景插件的声明。界面（SceneShell + 场景面板）、提示词拼装、主动消息规则都从这里取。
 * 新增场景 = 在这里加一条 + 写一个面板组件。
 */
export interface SceneDef {
  id: SceneId;
  name: string;
  /** UnoCSS 图标类名（lucide） */
  icon: string;
  tagline: string;
  /** 背景 key：占位背景按 key + 时段绘制；真背景图以后按同样的 key 替换 */
  backdrop: string;
  /** 环境音 */
  ambient: string[];
  outfit: Outfit;
  pose: Pose;
  /** 场景氛围色 */
  tint: string;
  /** 进入场景后拼进提示词的行为规则，可用宏 {{user}} {{char}} 和场景变量 */
  promptFragment: string;
  /** 这个场景里允许模型使用的控制标签 */
  allowedTags: ControlTagKind[];
  /** 和这个场景相关的主动消息触发器 */
  proactiveTriggers: ProactiveTriggerId[];
  /** 数据从哪里来（展示用） */
  dataSources: string[];
}

export const SCENES: SceneDef[] = [
  {
    id: 'exercise',
    name: '一起运动',
    icon: 'i-lucide-footprints',
    tagline: '她换上运动服陪你跑，每公里给你打气',
    backdrop: 'park',
    ambient: ['birds', 'wind'],
    outfit: 'sport',
    pose: 'stand',
    tint: '#7fd1b1',
    promptFragment:
      '【场景：一起运动】你和{{user}}正在一起跑步或散步。说话要短，适合边跑边听；每公里给一句鼓励或吐槽；结束后对这次运动具体地评价。',
    allowedTags: ['expr', 'cg'],
    proactiveTriggers: ['sedentary', 'workout-praise'],
    dataSources: ['App 内实时记录（计时、GPS）', '安卓计步传感器 / Health Connect', 'iPhone 快捷指令推送健康数据', '运动截图识别'],
  },
  {
    id: 'meal',
    name: '一起吃饭',
    icon: 'i-lucide-utensils',
    tagline: '饭点她会暗示你，也会坐下来陪你吃',
    backdrop: 'dining',
    ambient: ['cafe'],
    outfit: 'daily',
    pose: 'eat',
    tint: '#f2b27a',
    promptFragment:
      '【场景：一起吃饭】你们坐在同一张餐桌前，你也在吃。聊吃的、聊今天；记住{{user}}的口味；{{user}}发来饭照时，先具体评价看到的食物。',
    allowedTags: ['expr', 'cg'],
    proactiveTriggers: ['breakfast', 'lunch', 'dinner'],
    dataSources: ['三餐时间窗口（环境与作息里设置）', '饭照（视觉模型点评）'],
  },
  {
    id: 'study',
    name: '陪伴学习',
    icon: 'i-lucide-book-open',
    tagline: '番茄钟开着，她在旁边安静地陪你',
    backdrop: 'library',
    ambient: ['rain', 'pages'],
    outfit: 'daily',
    pose: 'study',
    tint: '#8fb3f0',
    promptFragment:
      '【场景：陪伴学习】{{user}}正在专注学习（番茄钟）。专注时段你不主动说话；只在休息时段或{{user}}找你时聊天，语气轻、句子短；{{user}}走神回来时轻轻提醒。',
    allowedTags: ['expr'],
    proactiveTriggers: ['study-checkin'],
    dataSources: ['番茄钟记录', '离开 App 检测（走神提醒）'],
  },
  {
    id: 'sleep',
    name: '哄睡',
    icon: 'i-lucide-moon-star',
    tagline: '低语、讲故事、白噪音，明早来电叫醒你',
    backdrop: 'bedroom',
    ambient: ['rain', 'fire', 'waves'],
    outfit: 'pajama',
    pose: 'lie',
    tint: '#9b8cf0',
    promptFragment:
      '【场景：哄睡】现在是睡前。语速放慢、句子短、语气轻柔，像在耳边低语；不要问让人兴奋的问题；可以讲睡前故事；{{user}}说晚安后，只回一句很短的晚安。',
    allowedTags: ['expr'],
    proactiveTriggers: ['bedtime', 'wake-call'],
    dataSources: ['入睡 / 起床时间', '深夜仍在使用手机（安卓）'],
  },
  {
    id: 'music',
    name: '一起听歌',
    icon: 'i-lucide-music-2',
    tagline: '同一首歌，她会在喜欢的那句发弹幕',
    backdrop: 'music',
    ambient: [],
    outfit: 'daily',
    pose: 'sit',
    tint: '#f39cc0',
    promptFragment:
      '【场景：一起听歌】你们正在一起听《{{song}}》。根据当前歌词发很短的感想（20 字以内），像弹幕；不要每句都评；可以用 [music:歌名-歌手] 推荐下一首。',
    allowedTags: ['expr', 'music'],
    proactiveTriggers: [],
    dataSources: ['网易云音乐 Worker：搜索 / 歌曲地址 / 歌词'],
  },
  {
    id: 'date',
    name: '约会',
    icon: 'i-lucide-heart-handshake',
    tagline: '选个地方，像视觉小说一样约会',
    backdrop: 'cafe',
    ambient: ['cafe'],
    outfit: 'date',
    pose: 'stand',
    tint: '#ff9fa8',
    promptFragment:
      '【场景：约会·{{place}}】以旁白加对话推进约会。每轮结尾给出 2-3 个选项：[choice:选项A|选项B|选项C]；最浪漫的时刻可以用 [cg:画面描述] 请求一张配图；注意天气和时间。',
    allowedTags: ['expr', 'pose', 'bg', 'cg', 'choice'],
    proactiveTriggers: ['anniversary'],
    dataSources: ['地点、天气、时间', 'NovelAI 生成 CG'],
  },
  {
    id: 'poke',
    name: '戳戳乐',
    icon: 'i-lucide-pointer',
    tagline: '戳戳头、捏捏脸，看她什么反应',
    backdrop: 'room',
    ambient: [],
    outfit: 'daily',
    pose: 'stand',
    tint: '#f5b8a6',
    promptFragment:
      '【场景：戳戳乐】{{user}}在戳你（部位：{{part}}，连击 {{combo}} 次）。按性格做出很短的真实反应（15 字以内），配合 [expr:x]；被戳太多会生气。',
    allowedTags: ['expr', 'poke'],
    proactiveTriggers: [],
    dataSources: ['立绘热区（在立绘编辑里画）'],
  },
];

export const FREE_SCENE: SceneDef = {
  id: 'free',
  name: '日常聊天',
  icon: 'i-lucide-message-circle-heart',
  tagline: '像真人恋人一样聊天',
  backdrop: 'bedroom',
  ambient: [],
  outfit: 'daily',
  pose: 'stand',
  tint: '#f5b8a6',
  promptFragment: '【场景：日常聊天】像真人恋人一样自然地聊天，回复长短随对话节奏变化。',
  allowedTags: ['expr', 'cg', 'music', 'call', 'poke', 'choice'],
  proactiveTriggers: [],
  dataSources: [],
};

export function getScene(id: string): SceneDef {
  return SCENES.find((s) => s.id === id) ?? FREE_SCENE;
}
