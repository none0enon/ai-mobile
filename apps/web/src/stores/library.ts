import {
  parsePresetFile,
  presetUse,
  PRESET_USES,
  toPresetFile,
  type Character,
  type Lorebook,
  type Preset,
  type PresetCategory,
  type PresetFile,
  type PresetUse,
  type PresetUseId,
} from '@app/shared';
import { defineStore } from 'pinia';
import { reactive, ref } from 'vue';
import { autoSave, getAll, getOne, write } from '@/db/idb';
import { lorebooks as demoLorebooks } from '@/mock/library';
import { uid } from '@/utils/id';

/**
 * App 自带的预设：src/presets/ 里的预设文件（App 自己的格式）。往这个文件夹里加一个 .json 就多一个自带预设。
 * 第一次打开时像导入一样放进预设库，之后和你导入的一样：能改、能删、能复制、能导出；删掉的不会再放回来。
 */
const FILES = import.meta.glob<unknown>('../presets/*.json', { eager: true, import: 'default' });

interface Seed {
  file: string;
  preset: Preset;
  defaultFor: PresetUseId[];
}

function readSeeds(): Seed[] {
  const out: Seed[] = [];
  for (const [path, json] of Object.entries(FILES)) {
    const file = path.split('/').pop() ?? path;
    try {
      const { warnings: _w, defaultFor, id, ...data } = parsePresetFile(json, file);
      const now = Date.now();
      out.push({ file, defaultFor, preset: { ...data, id: id ?? `preset-${file.replace(/\.json$/i, '')}`, createdAt: now, updatedAt: now, seedFile: file } });
    } catch (e) {
      console.error(`预设文件 ${file} 读不出来：`, e);
    }
  }
  // 先对话、再功能……同一类按文件名
  const order: PresetCategory[] = ['chat', 'feature', 'proactive', 'theater', 'summary', 'image', 'rhythm', 'health', 'device', 'novel'];
  return out.sort((a, b) => order.indexOf(a.preset.category) - order.indexOf(b.preset.category) || a.file.localeCompare(b.file));
}

const SEEDS = readSeeds();

/** 自带预设文件里某一块的内容（预设里没有这一块时用文件里的，例如导入的 SillyTavern 预设没有"识图看照片"） */
export function seedBlockContent(identifier: string): string | undefined {
  for (const s of SEEDS) {
    const b = s.preset.blocks.find((x) => x.identifier === identifier);
    if (b?.content.trim()) return b.content.trim();
  }
  return undefined;
}
const DEMO_BOOK_IDS = new Set(demoLorebooks.map((b) => b.id));

/**
 * 自带的预设文件改过以后，本机已经放进库里的那份怎么跟上。只动你没改过的地方，每一条只做一次：
 * - replaced：块的旧默认内容。本机那块还是旧的（你没改过）就换成文件里现在的；
 * - added：文件里新加的块。本机那份没有就照文件里的位置插进去（之后你删了不会再放回来）。
 * 复制出来的、导入的预设不动；想整份回到文件的样子用"恢复成预设文件"。
 */
interface SeedUpgrade {
  id: string;
  /** 一个预设文件，或者好几个（同样的改动） */
  file?: string;
  files?: string[];
  replaced?: Record<string, string[]>;
  added?: string[];
  /** 改名：预设的名字、块的名字还是旧的默认名时换成新的 */
  renamed?: { preset?: [string, string]; blocks?: Record<string, [string, string]> };
}
const SEED_UPGRADES: SeedUpgrade[] = [
  {
    // 一起看书能读带公式的专业书：识图读成 Markdown + LaTeX；新增"专业书"一块
    id: 'feature-read:math',
    file: 'feature-read.json',
    replaced: { readOcr: ['把图片里这一页书的正文原样读出来：一段一行，保留标点；不要页眉、页脚、页码和图片说明，不要加任何别的话。'] },
    added: ['readTechnical'],
  },
  {
    // 哄睡接上真实的模型和语音：低语、睡前故事、定时到了各一块，加上程序填这一次输入的"场景任务"
    id: 'feature-sleep:voice',
    file: 'feature-sleep.json',
    added: ['sleepWhisper', 'sleepStory', 'sleepEnd', 'sceneTask'],
  },
  {
    // 一起观影可以贴链接看（B 站 / YouTube / 视频直链）：没有逐句字幕时她怎么说
    id: 'feature-watch:link',
    file: 'feature-watch.json',
    added: ['watchLink'],
  },
  {
    // 陪伴学习改版：番茄钟 / 倒计时 / 正计时，一起专注（共用计时器）/ 各自专注（各用各的）
    id: 'feature-study:modes',
    file: 'feature-study.json',
    replaced: {
      sceneRule: ['【场景：陪伴学习】{{user}}正在专注学习（番茄钟）。专注时段你不主动说话；只在休息时段或{{user}}找你时聊天，语气轻、句子短；{{user}}走神回来时轻轻提醒。'],
      studyBreak: [
        '一个番茄刚结束，进入休息。先说一句你这边进展得怎么样（卡住了就说卡住了），再具体夸{{user}}做完的一件事；有纸条就回纸条；{{user}}中途离开过就轻轻问一句，不指责。三句以内。',
      ],
    },
  },
  {
    // 陪伴学习分上下两屏：画幅由程序定（一起专注竖图，各自专注方图或横图）；各自专注时下半屏按你的人设画"你这边"
    id: 'image-study:split',
    file: 'image-study.json',
    replaced: {
      rules: [
        '规则：\n- tags 顺序：人数（1girl / 1boy）→ 构图与镜头（upper body, cowboy shot, from side, close-up…）→ 表情与动作 → 场景与背景 → 光线、天气、时段 → 氛围。\n- 不要写{{char}}的长相（发色、瞳色、发型、体型），程序会把长相加在最前面。\n- 写了"服装（程序会加…）"时不要写任何衣服；没写时按"{{char}}今天穿"写衣服的 tags。\n- 不要写画师名和质量词（masterpiece、best quality 之类程序会加）。\n- 画面里只有{{char}}一个人（solo）。\n- 都用竖图 portrait：在手机上竖着看。',
      ],
      format: ['只输出一个 JSON 对象，不要任何其他文字：\n{"caption": "中文短标题（12 字以内）", "tags": "逗号分隔的英文 tags", "negative": "额外的负面 tags，可以为空字符串", "size": "portrait"}'],
    },
    added: ['momentMine'],
  },
  {
    // 聊天 ＋ 发照片：识图先把照片看一遍（这一块交给识图，不发给对话模型）
    id: 'chat-daily:photo-look',
    file: 'chat-daily.json',
    added: ['photoLook'],
  },
  {
    id: 'chat-stage:photo-look',
    file: 'chat-stage.json',
    added: ['photoLook'],
  },
  {
    // 一起听歌接上网易云：一首歌开始时按歌词批量写弹幕、边听边聊；后置指令不再限定"一句"（批量时要输出 JSON）
    id: 'feature-music:netease',
    file: 'feature-music.json',
    replaced: { jailbreak: ['像弹幕一样短：一句，20 字以内。'] },
    added: ['musicBatch', 'musicChat'],
  },
  {
    // 看链接时像发弹幕一样吐槽；认得出片名里的作品、角色时可以就着说
    id: 'feature-watch:link-roast',
    file: 'feature-watch.json',
    replaced: {
      watchLink: [
        '这一次你们看的是一个视频链接，没有逐句字幕：场景任务里有平台、标题、作者、{{user}}贴的简介或内容、现在播到哪、你们刚才说过的话。你看不到画面也听不到声音，只知道这些。像坐在旁边一起看那样随口说一句（20 字以内）：可以接{{user}}刚才的话、聊标题和气氛、对进度有感而发，或者问一句；不要编造这些信息里没有的剧情、台词和画面细节；不要重复你刚才说过的话。',
      ],
    },
  },
  {
    // 记忆：聊天记录带行号和时间，总结时按话题切故事片段（带标签），每条记忆注明来自第几行
    id: 'summary:slices',
    file: 'summary.json',
    replaced: {
      format: ["输出一个 JSON 对象，不要任何其他文字：\n{\"summary\": \"这一段发生了什么（第三人称，100–200 字）\", \"memories\": [{\"type\": \"fact|preference|event|promise|followup|emotion|relationship\", \"content\": \"一句话，具体到人和事\", \"importance\": 1-10, \"dueAt\": \"需要之后跟进时写 ISO 时间（带时区），否则 null\", \"supersedes\": [\"被这条更新掉的旧记忆 id\"]}], \"relationship\": {\"affectionDelta\": -3 到 3 的整数, \"mood\": \"{{char}}现在的心情，没变化写 null\", \"nicknames\": {\"user\": \"{{char}}对{{user}}的新称呼，没有就省略\", \"char\": \"{{user}}对{{char}}的新称呼，没有就省略\"}}}"],
      rules: ["规则：\n- 记忆只写以后用得上的：{{user}}的事实、偏好、约定、要跟进的事、情绪变化、关系里程碑；闲聊不记。\n- 和已有记忆重复的不再写；有变化的写新的一条，并在 supersedes 里写旧的 id。\n- \"周三下午两点面试\"这类带时间的事写成 followup，dueAt 写事情结束后适合问结果的时间。\n- 好感变化克制：普通聊天 0，明显的感动或冲突才 ±1～3。"],
    },
  },
  {
    // 哄睡的聊天改成连麦：说话她就听得到、小声回你（sleep-call）；你安静久了她低语一句还是"低语"那一块
    id: 'feature-sleep:mic',
    file: 'feature-sleep.json',
    added: ['sleepCall'],
  },
  {
    // 家务系统、健康系统：角色扮演的预设加上"家务和健康"（程序填你今天的情况）和她怎么反应的两块（只在你开了那套系统时发送）
    id: 'life:blocks',
    files: [
      'chat-call.json',
      'chat-daily.json',
      'chat-stage.json',
      'proactive.json',
      'feature-date.json',
      'feature-game.json',
      'feature-meal.json',
      'feature-music.json',
      'feature-poke.json',
      'feature-read.json',
      'feature-sleep.json',
      'feature-study.json',
      'feature-watch.json',
    ],
    added: ['home', 'homeRules', 'healthRules'],
  },
  {
    // 一起运动改成"健身"：照计划练 / 随便动动，开练、做完一个动作、练了一段时间、边练边聊、结束各一块，加上程序填这一次输入的"场景任务"
    id: 'feature-exercise:fitness',
    file: 'feature-exercise.json',
    replaced: { sceneRule: ['【场景：一起运动】你和{{user}}正在一起跑步或散步。说话要短，适合边跑边听；每公里给一句鼓励或吐槽；结束后对这次运动具体地评价。'], jailbreak: ['边跑边说：每次一两句短句，适合边跑边听；不写大段动作描写。'] },
    renamed: { preset: ['一起运动', '健身'], blocks: { sceneRule: ['场景规则 · 一起运动', '场景规则 · 健身'] } },
    added: ['home', 'homeRules', 'healthRules', 'fitStart', 'fitMove', 'fitCheer', 'fitChat', 'fitEnd', 'sceneTask'],
  },
  {
    // 总结：家务卡片、运动记录记成习惯和变化（不是每次打卡都记）
    id: 'summary:life',
    file: 'summary.json',
    replaced: { rules: ['规则：\n- 片段按话题切，一件事一段，通常 1–5 段；零碎的闲聊合成一段"日常"。from / to 写聊天记录里的 # 行号。\n- 记忆只写以后用得上的：{{user}}的事实、偏好、约定、要跟进的事、情绪变化、关系里程碑；闲聊不记。\n- 一条只写一件事；写名字，不写"他""她"；时间写具体日期（按聊天记录里的时间换算，"明天"写成几月几号）。\n- 和已有记忆重复的不再写；有变化的写新的一条，并在 supersedes 里写旧的 id。\n- "周三下午两点面试"这类带时间的事写成 followup，dueAt 写事情结束后适合问结果的时间。\n- 好感变化克制：普通聊天 0，明显的感动或冲突才 ±1～3。'] },
  },
  {
    // 节律建世界：能一起做的事里"一起运动"改叫"健身"
    id: 'rhythm:fitness',
    file: 'rhythm.json',
    replaced: { buildWorld: ['这次的任务：建世界。从下面的角色卡和世界书里找出{{char}}住在哪、在哪读书或工作、常去哪些地方、身边有谁，写出{{char}}的小世界：\n- 地点 5–10 个，分三片：home 住处（至少一个，第一个是{{char}}住的地方）、campus 读书或工作的地方、city 常去的地方。名字用角色卡世界观里的叫法，6 个字以内。\n- 每个地点写 backdrop，只能从这些里选：bedroom 卧室、房间 / library 图书馆、自习室 / dining 食堂、餐厅 / cafe 咖啡店、小店 / park 公园、操场、户外 / seaside 海边、江边 / pool 游泳馆 / gym 健身房、训练场 / cinema 电影院 / night-market 夜市、街边小吃 / gallery 美术馆、博物馆 / aquarium 水族馆 / amusement 游乐园、电玩城 / music 有音乐的地方。\n- 每个地点写在那里能和{{user}}一起做的事 activities，scene 只能从这些里选：study 陪伴学习 / read 一起看书 / meal 一起吃饭 / exercise 一起运动 / watch 一起看片 / game 海龟汤 / date 约会 / music 一起听歌 / sleep 哄睡 / poke 戳戳乐；label 是在这个地点的说法（例如在咖啡店学习写"一起自习"）。\n- 身边的人：角色卡和世界书里提到的家人、室友、同学、同事、朋友，写名字、和{{char}}的关系、出处或一句话。没提到的不要编。\n- 作息模板：从 00:00 排到 24:00，一段接一段、不重叠，写几点到几点、在哪（写地点的 key）、在做什么（6 个字以内）；不能挪的事（固定的课、训练、班）写 "fixed": true。\n- 三餐习惯：早饭、午饭、晚饭一般吃什么。\n- 衣柜：4–8 套，至少有日常 daily、运动 sport、睡衣 sleep 各一套，可以有约会 date；每套写中文名和 NovelAI 的英文 tags（只写衣服、鞋、配饰，不写长相）。设定里写了{{char}}常穿什么的，照设定写。\n- 手头的事：{{char}}最近在忙的一件具体的事（陪伴学习时{{char}}的小目标）。\n输出格式：\n{"name": "小世界的名字", "blurb": "一句话介绍", "areas": {"home": "住处这一片叫什么", "campus": "读书或工作的那一片叫什么", "city": "常去的那一片叫什么"}, "homeKey": "住处的 key", "locations": [{"key": "英文小写 key", "name": "名字", "area": "home|campus|city", "indoor": true, "backdrop": "bedroom", "blurb": "一句话", "activities": [{"scene": "study", "label": "一起自习"}]}], "people": [{"name": "名字", "relation": "关系", "note": "出处或一句话"}], "schedule": [{"from": "00:00", "to": "07:30", "at": "地点 key", "status": "睡觉中", "fixed": false}], "meals": {"breakfast": "", "lunch": "", "dinner": ""}, "wardrobe": [{"kind": "daily|sport|sleep|date", "name": "中文名", "tags": "英文 tags"}], "task": "手头的事"}'] },
  },
  {
    // 接了 Google 地图：外食从附近真实的店里挑（饭里多了 place、order），要买的东西写成名字、多少、在哪买、搜什么，
    // 按附近超市和网店（Amazon、Kroger……）真能买到的写；新增程序填充块"附近能吃的和能买的"
    id: 'health:nearby',
    file: 'health.json',
    replaced: {
      rules: ["规则：\n- 健身：只用\"能接受的健身方式\"里的；每天练多久不超过那天能练的时间（0 分钟的那天休息）；一周里有轻有重，同一个部位的力量训练隔一天再练；新手从简单的做起。身体情况里写了旧伤、不舒服的，避开会加重的动作，换成温和的。\n- 动作说明：复杂的动作（要几个部位一起配合、容易做错、做错了容易受伤的，比如深蹲、弓步、硬拉、俯卧撑、平板支撑、波比跳、臀桥、划船）在 how 里一步一步写清楚：起始姿势、怎么动、怎么呼吸、做到什么程度停。用大白话说身体哪里怎么动（\"屁股往后坐，像要坐到椅子上\"\"膝盖和脚尖朝同一个方向\"\"背挺直，别弓成虾米\"）；不要用肌肉的学名（股四头肌、臀大肌、腘绳肌、三角肌、竖脊肌、核心肌群这类词不写），实在要说就说\"大腿前面\"\"屁股\"\"大腿后面\"\"肩膀\"\"肚子\"。简单的动作（原地踏步、开合跳、拉伸）how 写一两句或者不写。tips 写最要注意的一点，easier 写做不动时怎么降低难度。\n- 饮食：三顿饭照目标搭配（减脂少油少糖、蛋白质够；增肌多吃一点、蛋白质更多）。自己做的那顿：做饭时间不超过那顿能花的时间，只用有的厨具，食材优先用家里有的，缺的写进这周要买的东西；不自己做的那顿写在食堂、外卖、外面怎么选。避开忌口和过敏的东西。菜谱的步骤写到照着就能做出来。\n- 热量这些数写个大概就行；不评价身材，不劝节食，不推荐药物和补剂。"],
      planWeek: ["这次的任务：排这一周。\n输出格式：\n{\"focus\": \"这周的重点（一句话）\", \"days\": [{\"weekday\": 1, \"workout\": \"练什么（例如：上肢力量 + 核心、快走、休息）\", \"minutes\": 30, \"rest\": false, \"meals\": \"这天三餐的方向，一句话\"}], \"shopping\": [\"这周要买的东西，带大概的量\"], \"tips\": [\"一两条这周的小提醒\"]}\ndays 从周一（weekday 1）写到周日（weekday 0），7 天都写；休息的那天 rest 写 true、minutes 写 0。"],
      planDay: ["这次的任务：排今天。照\"这周的计划\"里今天那一项排（今天不能练就休息）。\n输出格式：\n{\"rest\": false, \"workout\": {\"title\": \"今天练什么\", \"minutes\": 30, \"intensity\": \"轻松 / 中等 / 有点累\", \"warmup\": [动作], \"items\": [动作], \"cooldown\": [动作]}, \"meals\": {\"breakfast\": 饭, \"lunch\": 饭, \"dinner\": 饭, \"snack\": 饭或 null}, \"tips\": \"一句今天的提醒\"}\n动作：{\"name\": \"动作名\", \"sets\": 组数, \"reps\": \"每组多少，例如 12 次、每边 10 次\", \"seconds\": 按时间做的每组几秒（按次数做的写 0）, \"rest\": 组间休息几秒, \"how\": [\"第一步……\", \"第二步……\"], \"tips\": \"最要注意的一点\", \"easier\": \"做不动时怎么做\"}\n饭：{\"name\": \"吃什么\", \"cook\": 是不是自己做（true / false）, \"minutes\": 做饭要几分钟（不自己做写 0）, \"kcal\": 大概多少千卡, \"ingredients\": [\"食材和用量\"], \"steps\": [\"第一步……\"], \"note\": \"不自己做时怎么选，或者一句提醒\"}\n热身和拉伸也用动作的格式（sets 写 1）。今天休息时 rest 写 true，workout 写 null（三顿饭照样写）。"],
    },
    added: ['healthNearby'],
  },
  {
    // 一起游戏加了真心话大冒险：建世界时 game 这件事不再只写海龟汤
    id: 'rhythm:game',
    file: 'rhythm.json',
    replaced: { buildWorld: ["这次的任务：建世界。从下面的角色卡和世界书里找出{{char}}住在哪、在哪读书或工作、常去哪些地方、身边有谁，写出{{char}}的小世界：\n- 地点 5–10 个，分三片：home 住处（至少一个，第一个是{{char}}住的地方）、campus 读书或工作的地方、city 常去的地方。名字用角色卡世界观里的叫法，6 个字以内。\n- 每个地点写 backdrop，只能从这些里选：bedroom 卧室、房间 / library 图书馆、自习室 / dining 食堂、餐厅 / cafe 咖啡店、小店 / park 公园、操场、户外 / seaside 海边、江边 / pool 游泳馆 / gym 健身房、训练场 / cinema 电影院 / night-market 夜市、街边小吃 / gallery 美术馆、博物馆 / aquarium 水族馆 / amusement 游乐园、电玩城 / music 有音乐的地方。\n- 每个地点写在那里能和{{user}}一起做的事 activities，scene 只能从这些里选：study 陪伴学习 / read 一起看书 / meal 一起吃饭 / exercise 健身 / watch 一起看片 / game 海龟汤 / date 约会 / music 一起听歌 / sleep 哄睡 / poke 戳戳乐；label 是在这个地点的说法（例如在咖啡店学习写\"一起自习\"）。\n- 身边的人：角色卡和世界书里提到的家人、室友、同学、同事、朋友，写名字、和{{char}}的关系、出处或一句话。没提到的不要编。\n- 作息模板：从 00:00 排到 24:00，一段接一段、不重叠，写几点到几点、在哪（写地点的 key）、在做什么（6 个字以内）；不能挪的事（固定的课、训练、班）写 \"fixed\": true。\n- 三餐习惯：早饭、午饭、晚饭一般吃什么。\n- 衣柜：4–8 套，至少有日常 daily、运动 sport、睡衣 sleep 各一套，可以有约会 date；每套写中文名和 NovelAI 的英文 tags（只写衣服、鞋、配饰，不写长相）。设定里写了{{char}}常穿什么的，照设定写。\n- 手头的事：{{char}}最近在忙的一件具体的事（陪伴学习时{{char}}的小目标）。\n输出格式：\n{\"name\": \"小世界的名字\", \"blurb\": \"一句话介绍\", \"areas\": {\"home\": \"住处这一片叫什么\", \"campus\": \"读书或工作的那一片叫什么\", \"city\": \"常去的那一片叫什么\"}, \"homeKey\": \"住处的 key\", \"locations\": [{\"key\": \"英文小写 key\", \"name\": \"名字\", \"area\": \"home|campus|city\", \"indoor\": true, \"backdrop\": \"bedroom\", \"blurb\": \"一句话\", \"activities\": [{\"scene\": \"study\", \"label\": \"一起自习\"}]}], \"people\": [{\"name\": \"名字\", \"relation\": \"关系\", \"note\": \"出处或一句话\"}], \"schedule\": [{\"from\": \"00:00\", \"to\": \"07:30\", \"at\": \"地点 key\", \"status\": \"睡觉中\", \"fixed\": false}], \"meals\": {\"breakfast\": \"\", \"lunch\": \"\", \"dinner\": \"\"}, \"wardrobe\": [{\"kind\": \"daily|sport|sleep|date\", \"name\": \"中文名\", \"tags\": \"英文 tags\"}], \"task\": \"手头的事\"}"] },
  },
  {
    // 海龟汤的尺度挪进预设：清汤、红汤各一块（soup-level:名字），现编和自检照"尺度"那一块
    id: 'feature-game:levels',
    file: 'feature-game.json',
    replaced: { soupMake: ["出一道原创的海龟汤，尺度和可以用的地点、人物在场景任务里（清汤：不涉及死亡和恐怖）。先想好汤底，再写汤面；汤面要能通过是非题问出汤底。只输出一个 JSON 对象，不要别的文字：{\"title\": \"标题\", \"surface\": \"汤面\", \"truth\": \"汤底\", \"keys\": [\"要问出来的关键点\"], \"difficulty\": 1 到 3}"], soupCheck: ["检查场景任务里这道海龟汤：只看汤面，能不能通过是非题问出汤底？关键点和汤底对得上吗？有没有前后矛盾？只输出一个 JSON 对象，不要别的文字：{\"ok\": true 或 false, \"reason\": \"原因\"}"] },
    added: ['soupLevelClear', 'soupLevelRed'],
  },
];

/** 按 SEED_UPGRADES 更新本机的自带预设，返回改了的那些 */
function upgradeSeeded(list: Preset[], done: Set<string>): Preset[] {
  const changed = new Set<Preset>();
  for (const u of SEED_UPGRADES) {
    if (done.has(u.id)) continue;
    done.add(u.id);
    for (const file of u.files ?? (u.file ? [u.file] : [])) upgradeFile(list, u, file, changed);
  }
  for (const p of changed) p.updatedAt = Date.now();
  return [...changed];
}

/** 一个预设文件的一条升级：本机从这个文件放进来的那份（你没改过的地方）跟上 */
function upgradeFile(list: Preset[], u: SeedUpgrade, file: string, changed: Set<Preset>) {
  const seed = SEEDS.find((s) => s.file === file)?.preset;
  if (!seed) return;
  for (const p of list) {
    if (p.seedFile !== file) continue;
    const [fromName, toName] = u.renamed?.preset ?? [];
    if (fromName && toName && p.name === fromName) {
      p.name = toName;
      if (seed.description) p.description = seed.description;
      changed.add(p);
    }
    for (const [id, [from, to]] of Object.entries(u.renamed?.blocks ?? {})) {
      const mine = p.blocks.find((b) => b.identifier === id);
      if (mine && mine.name === from) {
        mine.name = to;
        changed.add(p);
      }
    }
    for (const [id, olds] of Object.entries(u.replaced ?? {})) {
      const mine = p.blocks.find((b) => b.identifier === id);
      const now = seed.blocks.find((b) => b.identifier === id);
      if (mine && now && mine.content !== now.content && olds.includes(mine.content.trim())) {
        mine.content = now.content;
        changed.add(p);
      }
    }
    for (const id of u.added ?? []) {
      const at = seed.blocks.findIndex((b) => b.identifier === id);
      if (at < 0 || p.blocks.some((b) => b.identifier === id)) continue;
      // 插在文件里它前面那一块的后面；那一块你删了就放最后
      const prev = seed.blocks[at - 1]?.identifier;
      const i = prev ? p.blocks.findIndex((b) => b.identifier === prev) : -1;
      p.blocks.splice(i >= 0 ? i + 1 : p.blocks.length, 0, clone(seed.blocks[at]!));
      changed.add(p);
    }
  }
}

/** 演示用的世界书（每次打开重新生成）；预设没有"自带的不能动"这回事 */
export function isDemoRecord(id: string) {
  return DEMO_BOOK_IDS.has(id);
}

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

/**
 * 预设和世界书。
 * - 预设分十类（对话、功能、主动消息、小剧场、总结、生图、节律、健康、控制指令、小说）；
 * - 每个用途（一起做事的每件事、主动消息、番外、总结、配图、一起做事时画的图、节律）选一个对应分类的预设；对话预设每个角色自己选；
 * - 所有预设都存在本机（自带的放进来以后也一样）。
 */
export const useLibraryStore = defineStore('library', () => {
  // 读本机数据库之前先用预设文件里的（启动时界面要有东西），读完以后以本机的为准
  const presets = ref<Preset[]>(SEEDS.map((s) => clone(s.preset)));
  const lorebooks = ref<Lorebook[]>([...demoLorebooks]);
  /** 每个用途选的预设；null = 跟随（对话预设，或者一起做事时画的图跟随配图） */
  const uses = reactive<Partial<Record<PresetUseId, string | null>>>(defaultUses(SEEDS));

  const presetSaver = autoSave('presets', () => presets.value.map((p) => ({ key: p.id, value: p })), presets);
  const bookSaver = autoSave(
    'lorebooks',
    () => lorebooks.value.filter((b) => !DEMO_BOOK_IDS.has(b.id)).map((b) => ({ key: b.id, value: b })),
    lorebooks,
  );
  const useSaver = autoSave('settings', () => [{ key: 'presetUses', value: { ...uses } }], () => ({ ...uses }));

  /** 预设文件里写的"默认给哪些用途用" */
  function defaultUses(seeds: Seed[]): Partial<Record<PresetUseId, string>> {
    const out: Partial<Record<PresetUseId, string>> = {};
    for (const s of seeds) for (const u of s.defaultFor) out[u] ??= s.preset.id;
    return out;
  }

  async function hydrate() {
    const [ps, bs, savedUses, seeded, upgraded] = await Promise.all([
      getAll<Preset>('presets'),
      getAll<Lorebook>('lorebooks'),
      getOne<Record<string, unknown>>('settings', 'presetUses'),
      getOne<string[]>('settings', 'seededPresetFiles'),
      getOne<string[]>('settings', 'presetUpgrades'),
    ]);
    const done = new Set(Array.isArray(seeded) ? seeded : []);
    const upgradesDone = new Set(Array.isArray(upgraded) ? upgraded : []);
    const saved = new Map(ps.map((p) => [p.id, { ...p, category: p.category ?? 'chat' } as Preset]));
    const list: Preset[] = [];
    const fresh: Seed[] = [];
    for (const s of SEEDS) {
      const mine = saved.get(s.preset.id);
      if (mine) {
        list.push(mine);
        saved.delete(s.preset.id);
      } else if (!done.has(s.file)) {
        // 新的预设文件（第一次打开，或者 App 更新后多了一个）：放进预设库
        list.push(clone(s.preset));
        fresh.push(s);
      }
      // 放进来过、本机又没有：你删掉了，不再放回来
    }
    // 导入的、复制的：按导入时间排（以前存的没有分类，都是对话预设）
    list.push(...[...saved.values()].sort((a, b) => a.createdAt - b.createdAt));
    // 自带预设文件后来改过的地方：本机那份你没改过就跟上
    const touched = upgradeSeeded(list, upgradesDone).filter((p) => !fresh.some((s) => s.preset.id === p.id));
    presets.value = list;

    for (const k of Object.keys(uses) as PresetUseId[]) delete uses[k];
    if (savedUses && typeof savedUses === 'object') {
      for (const u of PRESET_USES) {
        const v = savedUses[u.id];
        if (v === null && u.follow) uses[u.id] = null;
        else if (typeof v === 'string') uses[u.id] = v;
      }
    }
    // 预设文件写了默认给哪些用途：那个用途你还没选过、而且那个预设还在，就用它。
    // 以前只在第一次放进来时用一次、又没存下来，第二次打开就全变成"这一类的第一个"（场景都用成了约会的预设）
    for (const [u, id] of Object.entries(defaultUses(SEEDS)) as [PresetUseId, string][]) {
      if (!(u in uses) && list.some((p) => p.id === id)) uses[u] = id;
    }

    for (const s of SEEDS) done.add(s.file);
    await write('settings', [
      { key: 'seededPresetFiles', value: [...done] },
      { key: 'presetUpgrades', value: [...upgradesDone] },
      { key: 'presetUses', value: { ...uses } },
    ]);
    for (const b of bs.sort((a, b) => a.createdAt - b.createdAt)) if (!lorebooks.value.some((x) => x.id === b.id)) lorebooks.value.push(b);
    presetSaver.start();
    bookSaver.start();
    useSaver.start();
    // 新放进来的预设要写进本机（start 只记下现在的样子，不会自己写）
    if (fresh.length) await write('presets', fresh.map((s) => ({ key: s.preset.id, value: clone(presets.value.find((p) => p.id === s.preset.id)) })));
    if (touched.length) await write('presets', touched.map((p) => ({ key: p.id, value: clone(p) })));
  }

  function presetById(id: string | null | undefined): Preset | undefined {
    return presets.value.find((p) => p.id === id);
  }

  function presetsOf(category: PresetCategory): Preset[] {
    return presets.value.filter((p) => p.category === category);
  }

  /** 这个角色的对话预设；没选、选的被删了或不是对话预设时用第一个对话预设（一个都没有时为空） */
  function chatPresetFor(character?: Pick<Character, 'presetId'> | null): Preset | undefined {
    const own = presetById(character?.presetId);
    if (own?.category === 'chat') return own;
    return presetsOf('chat')[0];
  }

  /**
   * 这个用途选的预设 id；null = 跟随（对话预设 / 配图）；选的被删了时用这一类的第一个。
   * 一起做事时画的图没选过就跟随配图（自带了这个场景的生图预设的，预设文件里写了默认给它用）
   */
  function useChoice(use: PresetUseId): string | null | undefined {
    const meta = presetUse(use);
    const v = uses[use];
    if (meta?.follow && (v === null || (v === undefined && meta.follow === 'image'))) return null;
    const picked = presetById(v ?? undefined);
    if (picked && picked.category === meta?.category) return picked.id;
    if (meta?.follow === 'image') return null;
    return meta ? presetsOf(meta.category)[0]?.id : undefined;
  }

  /**
   * 这个用途这次用哪个预设。跟随时用对话预设 / 配图的预设；
   * 这一类一个都没有时：能跟随对话的用对话预设，其余为空（调用方说清楚缺什么）
   */
  function presetForUse(use: PresetUseId, character?: Pick<Character, 'presetId'> | null): Preset | undefined {
    const meta = presetUse(use);
    const choice = useChoice(use);
    if (choice === null) return meta?.follow === 'image' ? presetForUse('image', character) : chatPresetFor(character);
    const p = presetById(choice);
    if (p) return p;
    return meta?.follow === 'chat' ? chatPresetFor(character) : undefined;
  }

  function setUse(use: PresetUseId, id: string | null) {
    uses[use] = id;
  }

  /** 用着这个预设的用途 */
  function usesOf(presetId: string): PresetUse[] {
    return PRESET_USES.filter((u) => useChoice(u.id) === presetId);
  }

  function lorebookById(id: string | null | undefined): Lorebook | undefined {
    return lorebooks.value.find((b) => b.id === id);
  }

  function addPreset(p: Preset) {
    presets.value.push(p);
    return presets.value.at(-1) as Preset;
  }

  /** 复制一份；角色扮演类的可以复制成另一类（例如把导入的对话预设复制成功能预设） */
  function duplicatePreset(id: string, category?: PresetCategory): Preset | undefined {
    const src = presetById(id);
    if (!src) return undefined;
    const now = Date.now();
    const { seedFile: _f, ...rest } = clone(src);
    return addPreset({ ...rest, id: uid('preset'), createdAt: now, updatedAt: now, name: `${src.name}（副本）`, category: category ?? src.category });
  }

  /** 从 App 自带的预设文件放进来的：文件里现在的样子（可以恢复成它） */
  function seedOf(id: string): Preset | undefined {
    const p = presetById(id);
    const s = SEEDS.find((x) => x.file === p?.seedFile);
    return s ? clone(s.preset) : undefined;
  }

  /** 恢复成预设文件里的样子（名字、分类、块、参数都按文件） */
  function restoreFromFile(id: string): boolean {
    const i = presets.value.findIndex((p) => p.id === id);
    const s = seedOf(id);
    if (i < 0 || !s) return false;
    presets.value[i] = { ...s, id, createdAt: presets.value[i]!.createdAt, updatedAt: Date.now() };
    return true;
  }

  /** 导出成预设文件（App 自己的格式，带上它现在给哪些用途用） */
  function exportFile(id: string): PresetFile | undefined {
    const p = presetById(id);
    return p ? toPresetFile(p, usesOf(id).map((u) => u.id)) : undefined;
  }

  function addLorebook(b: Lorebook) {
    lorebooks.value.push(b);
    return lorebooks.value.at(-1) as Lorebook;
  }

  /** 删掉一个预设（自带的也能删）；选了它的用途改用这一类的第一个 */
  function removePreset(id: string) {
    presets.value = presets.value.filter((p) => p.id !== id);
    for (const u of PRESET_USES) if (uses[u.id] === id) delete uses[u.id];
  }

  function removeLorebook(id: string) {
    lorebooks.value = lorebooks.value.filter((b) => b.id !== id);
  }

  return {
    presets,
    lorebooks,
    uses,
    hydrate,
    presetById,
    presetsOf,
    chatPresetFor,
    useChoice,
    presetForUse,
    setUse,
    usesOf,
    lorebookById,
    addPreset,
    duplicatePreset,
    seedOf,
    restoreFromFile,
    exportFile,
    addLorebook,
    removePreset,
    removeLorebook,
  };
});
