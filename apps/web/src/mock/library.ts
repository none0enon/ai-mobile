import type { LoreEntry, Lorebook, PokeHotspot } from '@app/shared';
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

// 预设不在这里：App 自带的预设是 src/presets/ 里的预设文件，第一次打开时放进预设库（stores/library.ts）

/** 占位立绘上的戳戳乐热区（坐标相对立绘框 0-1）；台词也是导入立绘后默认热区的台词。有立绘时在"立绘"页里拖 */
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
