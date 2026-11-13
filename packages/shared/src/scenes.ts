import type { Outfit, Pose } from './expressions.ts';
import type { ControlTagKind } from './tags.ts';
import type { ProactiveTriggerId } from './types/proactive.ts';

export type SceneId = 'free' | 'exercise' | 'meal' | 'study' | 'sleep' | 'music' | 'date' | 'poke' | 'watch' | 'game' | 'read' | 'home' | 'heart';

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
    name: '健身',
    icon: 'i-lucide-dumbbell',
    tagline: '照着今天的计划练，或者随便动动；她换上运动服陪你',
    backdrop: 'gym',
    ambient: ['birds', 'wind'],
    outfit: 'sport',
    pose: 'stand',
    tint: '#7fd1b1',
    // 自带的"健身"功能预设里有自己的场景规则；这里只在功能预设跟随对话预设时用
    promptFragment: '【场景：健身】你和{{user}}在一起健身，你也换好了运动服在旁边陪着练。说话要短，适合边练边听；鼓励要具体，不说教；{{user}}累了就让{{user}}慢一点。',
    allowedTags: ['expr'],
    proactiveTriggers: ['sedentary', 'workout-praise'],
    dataSources: ['今天的健身计划（「健康计划」按你的人设排的）', 'App 内计时', '安卓：蓝牙心率带 / 手表的心率广播、手机计步、GPS 距离', '别的手机：结束时手动填手表上的数'],
  },
  {
    id: 'meal',
    name: '一起吃饭',
    icon: 'i-lucide-utensils',
    tagline: '她也在吃饭时一起吃，不在饭点就各吃各的、碰个杯',
    backdrop: 'dining',
    ambient: ['cafe'],
    outfit: 'daily',
    pose: 'eat',
    tint: '#f2b27a',
    promptFragment:
      '【场景：一起吃饭】{{user}}在吃饭，你陪着。共同吃饭时你也正好在吃饭，像坐在同一张桌子两边一起吃；各吃各的时你在自己那边做自己的事，隔着屏幕陪{{user}}吃，可以碰杯。聊吃的、聊今天；记住{{user}}的口味；{{user}}发来饭照时，先具体评价看到的食物。',
    allowedTags: ['expr', 'cg'],
    proactiveTriggers: ['breakfast', 'lunch', 'dinner'],
    dataSources: ['三餐时间窗口（环境与作息里设置）', '她今天的作息和三餐（节律）', '健康计划里这顿怎么吃', '饭照（识图）'],
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
      '【场景：陪伴学习】{{user}}正在专注学习（番茄钟、倒计时或正计时）。一起专注时你们共用一个计时器、到点一起休息；各自专注时各用各的计时器，你按自己的节奏学。专注时段你不主动说话；只在休息时段或{{user}}找你时聊天，语气轻、句子短；{{user}}走神回来时轻轻提醒。',
    allowedTags: ['expr'],
    proactiveTriggers: ['study-checkin'],
    dataSources: ['番茄钟记录', '离开 App 检测（走神提醒）'],
  },
  {
    id: 'sleep',
    name: '哄睡',
    icon: 'i-lucide-moon-star',
    tagline: '连麦、讲故事、白噪音和音乐，明早来电叫醒你',
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
    tagline: '选个地方，像视觉小说一样约会，想约多久约多久',
    backdrop: 'cafe',
    ambient: ['cafe'],
    outfit: 'date',
    pose: 'stand',
    tint: '#ff9fa8',
    promptFragment:
      '【场景：约会】你和{{user}}在约会。用（旁白）加「台词」推进，每段结尾给四个选项：[choice:顺着:…|逆着:…|皮一下:…|暧昧:…]；真正心动的时刻可以用 [cg:画面描述] 留一张图；注意天气和时间。',
    allowedTags: ['expr', 'cg', 'choice'],
    proactiveTriggers: ['anniversary'],
    dataSources: ['地点、天气、时间', '"约会"功能预设：开场、每一段、结束', '"生图 · 约会"：到达、关键时刻、留念'],
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
  {
    id: 'watch',
    name: '一起观影',
    icon: 'i-lucide-clapperboard',
    tagline: '同一部片，她跟着字幕在对的那一秒说话',
    backdrop: 'cinema',
    ambient: [],
    outfit: 'daily',
    pose: 'sit',
    tint: '#e07a7a',
    // 场景规则写在"一起观影"的功能预设里（不写死在代码里）
    promptFragment: '',
    allowedTags: ['expr'],
    proactiveTriggers: [],
    dataSources: ['本地视频（不上传）', '外挂字幕文件 srt / vtt / ass'],
  },
  {
    id: 'game',
    name: '一起游戏',
    icon: 'i-lucide-puzzle',
    tagline: '海龟汤、真心话大冒险、飞行棋：她出题你猜、轮流说真心话做大冒险、掷骰子走到哪做到哪',
    backdrop: 'room',
    ambient: [],
    outfit: 'daily',
    pose: 'sit',
    tint: '#b9a3e6',
    // 规则写在"一起游戏"的功能预设里（不写死在代码里）
    promptFragment: '',
    allowedTags: ['expr'],
    proactiveTriggers: [],
    dataSources: ['海龟汤题库（src/soups/ 里的题库文件，可以增删改）', '现编的题', '真心话大冒险的题：她按预设里的尺度、你们的关系和记忆现出', '飞行棋的棋盘：开局时照选的棋盘预设现设计 128 格的任务'],
  },
  {
    id: 'read',
    name: '一起看书',
    icon: 'i-lucide-book-open-text',
    tagline: '同一本书，她提前读几页，在页边留批注',
    backdrop: 'library',
    ambient: ['pages'],
    outfit: 'daily',
    pose: 'sit',
    tint: '#d9a77a',
    // 规则写在"一起看书"的功能预设里（不写死在代码里）
    promptFragment: '',
    allowedTags: ['expr'],
    proactiveTriggers: [],
    dataSources: ['EPUB / TXT / PDF（只存在本机）', '粘贴的文章', '拍下的书页（识图）'],
  },
  {
    id: 'home',
    name: '共同的家',
    icon: 'i-lucide-house-heart',
    tagline: '今天的家务一件件做完，她在旁边陪你聊、给你放歌',
    backdrop: 'living',
    ambient: [],
    outfit: 'daily',
    pose: 'stand',
    tint: '#f2c38b',
    // 自带的"共同的家"功能预设里有自己的场景规则；这里只在功能预设跟随对话预设时用
    promptFragment: '【场景：共同的家】你和{{user}}在你们共同的家里，{{user}}在做今天的家务（清单和进度在"家务"那一块）。说话生活化、简短，像住在一起的恋人。',
    allowedTags: ['expr'],
    proactiveTriggers: [],
    dataSources: ['你人设里的家务清单（每天、每周）', '你在这里勾的：做完了、拖着的', '今天的饮食计划（开了健康系统时，做饭照着它）'],
  },
  {
    id: 'heart',
    name: '心跳',
    icon: 'i-lucide-heart-pulse',
    tagline: '只属于你们两个人的时间：打字或连麦，她的话通过 Intiface Central 传到你身上的玩具',
    backdrop: 'bedroom',
    ambient: [],
    outfit: 'pajama',
    pose: 'sit',
    tint: '#ff7a93',
    // 自带的"心跳"功能预设里有自己的场景规则；这里只在功能预设跟随对话预设时用
    promptFragment:
      '【场景：心跳】这是只属于你和{{user}}的亲密时间。说话贴近、带着情绪和呼吸感，节奏跟着{{user}}走：{{user}}想慢就慢，想要更多再给更多；{{user}}说停、说不舒服时立刻温柔地停下来。',
    allowedTags: ['expr'],
    proactiveTriggers: [],
    dataSources: ['Intiface Central（Buttplug 协议，本机或局域网的 WebSocket）：连着的玩具和它们能做什么', '"控制指令"预设按她的话写的指令，或者她在回复里写的 <device>', 'NovelAI 画的背景（"生图 · 心跳"的几个预设）'],
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
