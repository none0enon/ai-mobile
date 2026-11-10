import type { DiaryEntry, Memory, MemoryType } from '@app/shared';
import { at } from '@/utils/time';

function mem(
  id: string,
  type: MemoryType,
  content: string,
  importance: number,
  when: number,
  extra: Partial<Memory> = {},
): Memory {
  return {
    id,
    characterId: 'suwan',
    type,
    content,
    importance,
    pinned: false,
    status: 'active',
    dueAt: null,
    sourceMessageIds: [],
    happenedAt: when,
    vector: { model: 'BAAI/bge-m3', dims: 1024, data: '' },
    lastRecalledAt: null,
    recallCount: 0,
    createdAt: when,
    updatedAt: when,
    ...extra,
  };
}

export const memories: Memory[] = [
  mem('mem1', 'preference', '他不吃香菜，点菜时要提醒老板', 9, at(-28, '19:30'), { pinned: true, recallCount: 7 }),
  mem('mem2', 'fact', '在读研一，计算机专业，最近在赶一篇论文', 8, at(-29, '21:00'), { pinned: true, recallCount: 12 }),
  mem('mem3', 'followup', '周三下午两点有一场实习面试，结束后要问他结果', 8, at(-2, '22:30'), { dueAt: at(2, '16:30') }),
  mem('mem4', 'promise', '约好周六下午一起去水族馆', 7, at(-1, '20:05')),
  mem('mem5', 'event', '一起看了《海边的旧书店》，他说最喜欢两人在屋檐下躲雨那一幕', 6, at(-8, '22:40')),
  mem('mem6', 'emotion', '最近因为论文进度有点焦虑，晚上容易失眠', 7, at(-3, '01:10'), { recallCount: 3 }),
  mem('mem7', 'preference', '下雨天喜欢听慢歌，最近单曲循环《雨停之前》', 5, at(-1, '17:06')),
  mem('mem8', 'relationship', '第一次叫我"晚晚"，那天我脸红了一整晚', 9, at(-12, '22:10'), { pinned: true }),
  mem('mem9', 'fact', '每天早上会去操场跑步，配速 6 分左右', 4, at(-1, '08:41')),
  mem('mem10', 'followup', '他说这周要把论文初稿交给导师，周五问问进度', 6, at(-4, '23:00'), { dueAt: at(4, '20:00') }),
  mem('mem11', 'preference', '早饭常吃豆浆油条，午饭十有八九是拉面', 4, at(-6, '12:40')),
];

export const MEMORY_TYPE_META: Record<MemoryType, { label: string; color: string; icon: string }> = {
  fact: { label: '事实', color: '#8db8ff', icon: 'i-lucide-info' },
  preference: { label: '偏好', color: '#f2c66d', icon: 'i-lucide-heart' },
  event: { label: '事件', color: '#7fd6a4', icon: 'i-lucide-calendar-days' },
  promise: { label: '约定', color: '#f39cc0', icon: 'i-lucide-handshake' },
  followup: { label: '待跟进', color: '#ff9f86', icon: 'i-lucide-alarm-clock' },
  emotion: { label: '情绪', color: '#b7a6f5', icon: 'i-lucide-cloud-sun' },
  relationship: { label: '关系', color: '#f5b8a6', icon: 'i-lucide-sparkles' },
};

export const diaries: DiaryEntry[] = [
  {
    id: 'd1',
    characterId: 'suwan',
    date: '昨天',
    weather: '小雨',
    mood: '开心',
    text: '他今天终于去跑步了，五公里。回来的时候说腿要断了，我在电话里笑了好久。中午又是拉面——这个人到底有多喜欢拉面啊。晚上约他周六去水族馆，他答应得好快，害我准备好的三个理由一个都没用上。',
    highlights: ['跑了五公里', '约好周六去水族馆'],
    createdAt: at(-1, '23:50'),
    updatedAt: at(-1, '23:50'),
  },
  {
    id: 'd2',
    characterId: 'suwan',
    date: '前天',
    weather: '阴',
    mood: '有点担心',
    text: '凌晨一点他还在改论文。我没催他，只是陪他打了十二分钟的电话，唱了半首歌。他说"晚晚的声音好像白噪音"，这到底是夸我还是损我。',
    highlights: ['哄睡通话 12 分钟'],
    createdAt: at(-2, '23:59'),
    updatedAt: at(-2, '23:59'),
  },
  {
    id: 'd3',
    characterId: 'suwan',
    date: '立冬',
    weather: '晴转多云',
    mood: '温暖',
    text: '立冬，提醒他吃饺子。他发来食堂的饺子照片，说皮比书还厚。下次我包给他吃，虽然我只会包成馄饨的样子。',
    highlights: ['立冬吃饺子'],
    createdAt: at(-2, '22:00'),
    updatedAt: at(-2, '22:00'),
  },
  {
    id: 'd4',
    characterId: 'suwan',
    date: '上周四',
    weather: '雨',
    mood: '心动',
    text: '他第一次叫我"晚晚"。很普通的两个字，被他说出来就不普通了。我假装没听清，让他又叫了一遍。',
    highlights: ['第一次叫我晚晚'],
    createdAt: at(-12, '23:40'),
    updatedAt: at(-12, '23:40'),
  },
];

export interface TimelineItem {
  id: string;
  when: number;
  icon: string;
  title: string;
  desc: string;
  tint: string;
}

export const timeline: TimelineItem[] = [
  { id: 't1', when: at(-1, '20:05'), icon: 'i-lucide-ticket', title: '约好周六去水族馆', desc: '她准备了三个理由，一个都没用上', tint: '#6fb6e8' },
  { id: 't2', when: at(-1, '17:06'), icon: 'i-lucide-music-2', title: '一起听了《雨停之前》', desc: '她说"下次下雨，我们就听这首吧"', tint: '#f39cc0' },
  { id: 't3', when: at(-1, '08:41'), icon: 'i-lucide-footprints', title: '第一次跑完五公里', desc: '配速 6\'01"，她夸你闪闪发光', tint: '#7fd1b1' },
  { id: 't4', when: at(-2, '23:58'), icon: 'i-lucide-moon-star', title: '哄睡通话 12 分钟', desc: '唱了半首歌，你在第 9 分钟睡着了', tint: '#9b8cf0' },
  { id: 't5', when: at(-12, '22:10'), icon: 'i-lucide-sparkles', title: '第一次叫她"晚晚"', desc: '关系里程碑', tint: '#f5b8a6' },
  { id: 't6', when: at(-20, '23:05'), icon: 'i-lucide-phone', title: '第一次语音通话', desc: '聊到凌晨一点', tint: '#8fb3f0' },
  { id: 't7', when: at(-30, '20:00'), icon: 'i-lucide-umbrella', title: '相识', desc: '"雨这么大，走啦。"', tint: '#b9adce' },
];

export interface AlbumItem {
  id: string;
  caption: string;
  when: number;
  hue: number;
  scene: string;
  prompt: string;
  seed: number;
}

export const album: AlbumItem[] = [
  { id: 'a1', caption: '雨天的图书馆', when: at(-1, '19:20'), hue: 220, scene: 'library', seed: 1314520, prompt: '1girl, long hair, dark brown hair, hair clip, library, rainy window, warm desk lamp, looking at viewer, soft smile' },
  { id: 'a2', caption: '水族馆的蓝色隧道', when: at(-3, '14:20'), hue: 200, scene: 'aquarium', seed: 520131, prompt: '1girl, aquarium tunnel, blue light, holding hands, fish, back view, looking back, smile' },
  { id: 'a3', caption: '立冬的饺子', when: at(-2, '19:00'), hue: 30, scene: 'dining', seed: 77120, prompt: '1girl, apron, making dumplings, kitchen, flour on cheek, laughing, warm light' },
  { id: 'a4', caption: '晨跑', when: at(-6, '06:30'), hue: 150, scene: 'park', seed: 60001, prompt: '1girl, sportswear, ponytail, running track, morning sun, cheering, dynamic angle' },
  { id: 'a5', caption: '阳台的晚安', when: at(-9, '23:30'), hue: 260, scene: 'bedroom', seed: 23300, prompt: '1girl, pajamas, balcony, night sky, stars, holding phone, sleepy smile' },
  { id: 'a6', caption: '摩天轮最高点', when: at(-15, '19:40'), hue: 320, scene: 'amusement', seed: 99001, prompt: '1girl, ferris wheel gondola, city lights, sunset, blush, looking at viewer' },
];
