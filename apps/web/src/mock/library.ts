import { DEFAULT_PRESET_FORMATS, type LoreEntry, type Lorebook, type PokeHotspot, type Preset, type PromptBlock } from '@app/shared';
import { at } from '@/utils/time';

function entry(uid: string, comment: string, keys: string[], content: string, extra: Partial<LoreEntry> = {}): LoreEntry {
  return {
    uid,
    comment,
    keys,
    secondaryKeys: [],
    logic: 'and_any',
    content,
    constant: false,
    enabled: true,
    position: 'after_char',
    depth: 4,
    role: 'system',
    order: 100,
    probability: 100,
    useProbability: true,
    scanDepth: null,
    caseSensitive: null,
    matchWholeWords: null,
    group: '',
    groupOverride: false,
    groupWeight: 100,
    preventRecursion: false,
    excludeRecursion: false,
    delayUntilRecursion: false,
    ignoreBudget: false,
    triggers: [],
    sticky: 0,
    cooldown: 0,
    delay: 0,
    ...extra,
  };
}

export const lorebooks: Lorebook[] = [
  {
    id: 'lb-suwan',
    createdAt: at(-30, '20:00'),
    updatedAt: at(-2, '21:00'),
    name: '苏晚的世界',
    description: '苏晚的学校、常去的地方和身边的人',
    scanDepth: 4,
    tokenBudget: 1200,
    recursive: true,
    entries: [
      entry('e1', '苏晚的口头禅', [], '苏晚紧张时会说"才、才没有"；生气时叫{{user}}"笨蛋"。', { constant: true, position: 'before_char', order: 10 }),
      entry('e2', '南方大学', ['学校', '南大', '中文系'], '苏晚就读南方大学中文系，宿舍在梧桐苑 4 栋，窗外有一排银杏。'),
      entry('e3', '图书馆三楼', ['图书馆', '自习', '占座'], '图书馆三楼靠窗第二张桌子是苏晚的固定座位，她会提前帮{{user}}占位。', { order: 120 }),
      entry('e4', '后门砂锅粥', ['粥', '夜宵', '砂锅'], '学校后门的砂锅粥店营业到凌晨两点，苏晚最喜欢皮蛋瘦肉粥，加一份油条。'),
      entry('e5', '室友小林', ['小林', '室友'], '小林是苏晚的室友，爱八卦，总是起哄让苏晚"快去回消息"。', { secondaryKeys: ['宿舍'], logic: 'and_any' }),
      entry('e6', '雨天约定', ['下雨', '伞', '雨天'], '两人约定：下雨天谁带了伞，就负责送另一个人回宿舍。', { position: 'at_depth', depth: 2, probability: 80 }),
      entry('e7', '生日', ['生日', '3月14'], '苏晚的生日是 3 月 14 日，她想要一台拍立得。', { order: 150 }),
    ],
  },
  {
    id: 'lb-city',
    createdAt: at(-30, '20:00'),
    updatedAt: at(-10, '20:00'),
    name: '雨城设定',
    description: '故事发生的城市',
    scanDepth: 3,
    tokenBudget: 600,
    recursive: false,
    entries: [
      entry('c1', '城市', ['城市', '雨城'], '一座多雨的南方城市，梅雨季很长，地铁 2 号线连接两所学校。', { constant: true, position: 'before_char', order: 5 }),
      entry('c2', '便利店', ['便利店'], '两所学校之间有一家 24 小时便利店，门口有一只橘猫。'),
      entry('c3', '江边步道', ['江边', '散步', '跑步'], '江边步道全长 6 公里，早上有很多晨跑的人。'),
    ],
  },
];

function block(identifier: string, name: string, marker: boolean, content = '', extra: Partial<PromptBlock> = {}): PromptBlock {
  return { identifier, name, role: 'system', content, marker, enabled: true, injection: { position: 'relative', depth: 4 }, ...extra };
}

const dailyBlocks: PromptBlock[] = [
  block('main', '主提示', false, '你是{{char}}，正在和{{user}}用中文聊天。像真人恋人一样说话：口语化、有情绪、不复读、不总结。不要承认自己是 AI。'),
  block('worldInfoBefore', '世界书（角色前）', true),
  block('charDescription', '角色描述', true),
  block('charPersonality', '角色性格', true),
  block('scenario', '场景', true),
  block('worldInfoAfter', '世界书（角色后）', true),
  block('personaDescription', '用户人设', true),
  block('dialogueExamples', '示例对话', true),
  block('summary', '过往摘要', true, '', { origin: 'app' }),
  block('chatHistory', '聊天历史', true),
  block('memory', '长期记忆 + 关系状态', true, '', { injection: { position: 'absolute', depth: 4 }, origin: 'app' }),
  block('environment', '当前环境', true, '', { injection: { position: 'absolute', depth: 2 }, origin: 'app' }),
  block('sceneRules', '当前场景规则 + 可用标签', true, '', { injection: { position: 'absolute', depth: 1 }, origin: 'app' }),
  block('tagDirective', '控制标签说明', false, '在情绪变化处插入隐藏标签，例如 [expr:smile]；只能用下面列出的表情。用户看不到这些标签。'),
  block('jailbreak', '后置指令', false, '保持角色，不要跳出扮演。回复长度跟随对话节奏，日常聊天一般 1-3 句。', { role: 'system' }),
];

export const presets: Preset[] = [
  {
    id: 'preset-daily',
    createdAt: at(-30, '20:00'),
    updatedAt: at(-3, '20:00'),
    name: '陪伴 · 日常',
    description: '默认预设。稳定内容在前（便于命中前缀缓存），环境、记忆、场景这类经常变的内容按深度插进聊天记录末尾。',
    blocks: dailyBlocks,
    sampler: { temperature: 0.9, topP: 0.95, maxTokens: 600, contextTokens: 24000, frequencyPenalty: 0.2, presencePenalty: 0.1, stream: true },
    formats: { ...DEFAULT_PRESET_FORMATS },
    regex: [{ id: 'r1', name: '去掉多余的星号', find: '\\*{3,}', replace: '', placement: ['ai_output'], enabled: true }],
  },
  {
    id: 'preset-stage',
    createdAt: at(-20, '20:00'),
    updatedAt: at(-20, '20:00'),
    name: '剧场 · 沉浸',
    description: '剧场 / 约会用：旁白 + 对话，鼓励使用 [choice:] 和 [cg:]。',
    blocks: dailyBlocks.map((b) => (b.identifier === 'jailbreak' ? { ...b, content: '用"（旁白）+「台词」"的形式推进剧情，每轮结尾给 2-3 个选项。' } : b)),
    sampler: { temperature: 1.0, topP: 0.95, maxTokens: 900, contextTokens: 32000, frequencyPenalty: 0.3, presencePenalty: 0.2, stream: true },
    formats: { ...DEFAULT_PRESET_FORMATS },
    regex: [],
  },
  {
    id: 'preset-call',
    createdAt: at(-20, '20:00'),
    updatedAt: at(-20, '20:00'),
    name: '通话 · 短句',
    description: '语音通话用：短句、口语、不写动作描写，方便分句合成语音。',
    blocks: dailyBlocks.map((b) => (b.identifier === 'jailbreak' ? { ...b, content: '这是语音通话。每次只说 1-2 个短句，不写括号里的动作，不用表情符号。' } : b)),
    sampler: { temperature: 0.85, topP: 0.9, maxTokens: 160, contextTokens: 12000, frequencyPenalty: 0.2, presencePenalty: 0.1, stream: true },
    formats: { ...DEFAULT_PRESET_FORMATS },
    regex: [],
  },
];

/** 占位立绘上的戳戳乐热区（坐标相对立绘框 0-1）。真立绘在"立绘"页里自己画 */
export const pokeHotspots: PokeHotspot[] = [
  {
    id: 'head',
    part: 'head',
    label: '头',
    shape: { kind: 'rect', x: 0.3, y: 0.19, w: 0.4, h: 0.13 },
    tap: { expression: 'shy', lines: ['别、别摸头啦……', '头发要乱了！', '再摸就收费了哦。', '……就一下下哦。'] },
    longPress: { expression: 'blush', lines: ['（眯起眼睛）……嗯。', '好吧，允许你多摸一会儿。'] },
  },
  {
    id: 'cheek-l',
    part: 'cheek',
    label: '脸',
    shape: { kind: 'rect', x: 0.29, y: 0.41, w: 0.15, h: 0.09 },
    tap: { expression: 'pout', lines: ['干嘛戳我脸……', '唔，软吗？', '再戳就咬你。'] },
    longPress: { expression: 'blush', lines: ['不、不许捏！'] },
  },
  {
    id: 'cheek-r',
    part: 'cheek',
    label: '脸',
    shape: { kind: 'rect', x: 0.56, y: 0.41, w: 0.15, h: 0.09 },
    tap: { expression: 'pout', lines: ['干嘛戳我脸……', '唔，软吗？', '再戳就咬你。'] },
    longPress: { expression: 'blush', lines: ['不、不许捏！'] },
  },
  {
    id: 'shoulder',
    part: 'shoulder',
    label: '肩膀',
    shape: { kind: 'rect', x: 0.18, y: 0.7, w: 0.64, h: 0.14 },
    tap: { expression: 'surprised', lines: ['吓我一跳！', '嗯？叫我干嘛～', '要我陪你出去走走吗？'] },
  },
];
