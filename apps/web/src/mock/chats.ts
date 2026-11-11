import type { Chat, Message, MessagePart, MessageRole } from '@app/shared';
import { at } from '@/utils/time';

let seq = 0;

function m(
  chatId: string,
  role: MessageRole,
  ts: number,
  content: string | MessagePart[],
  extra: Partial<Message> = {},
): Message {
  const parts: MessagePart[] = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
  const text = parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
  seq += 1;
  return {
    id: `${chatId}-m${seq}`,
    chatId,
    role,
    createdAt: ts,
    updatedAt: ts,
    text,
    parts,
    expression: null,
    swipes: [],
    swipeIndex: 0,
    proactive: false,
    read: true,
    meta: {},
    ...extra,
  };
}

/**
 * 今天的主动消息不写在演示数据里：苏晚、江屿和导入的角色一样，由 stores/proactive.ts 按各自的计划到点发
 * （以前这里只给苏晚造了两条"刚刚"发来的消息，打开 App 时就只有她来找你）。
 */
function buildSuwan(): Message[] {
  const c = 'chat-suwan';
  return [
    // 三天前：在电影院约会。约会是这条聊天里的一段，不再单独开一条会话
    m(c, 'narrator', at(-3, '19:30'), [
      { type: 'scene', event: 'enter', sceneId: 'date', locationId: 'cinema', title: '和苏晚来到电影院 · 约会', mode: 'visit' },
      { type: 'text', text: '（周五晚上的电影院。灯暗下来的时候，她悄悄把爆米花推到你这边。）' },
    ]),
    m(c, 'assistant', at(-3, '21:40'), '……这部也太好哭了吧。', { expression: 'sad' }),
    m(c, 'user', at(-3, '21:41'), '给你纸巾'),
    m(c, 'assistant', at(-3, '21:42'), '才、才没哭。（却把脸埋进了你的肩膀）', { expression: 'blush' }),
    m(c, 'narrator', at(-3, '22:05'), [
      { type: 'scene', event: 'leave', sceneId: 'date', locationId: 'cinema', title: '离开电影院', summary: '一起看了《海边的旧书店》· 存进了回忆', mode: 'visit' },
    ]),

    m(c, 'assistant', at(-2, '23:41'), '还不睡？明天早八哦。', { expression: 'pout' }),
    m(c, 'user', at(-2, '23:42'), '马上马上……再看一集'),
    m(c, 'assistant', at(-2, '23:44'), [
      { type: 'voice', assetKey: null, durationMs: 6000, transcript: '那我给你唱首歌，听完就去睡，好不好～' },
    ], { expression: 'smile' }),
    m(c, 'assistant', at(-2, '23:58'), [{ type: 'call-log', durationSec: 723, scene: '哄睡' }]),

    m(c, 'assistant', at(-1, '07:30'), '早安～外面在下小雨，记得带伞。', { proactive: true, expression: 'smile' }),
    m(c, 'user', at(-1, '07:52'), '收到！今天早上还要去跑步'),
    m(c, 'user', at(-1, '08:40'), [
      { type: 'workout', logId: 'w1', sport: '跑步', distanceKm: 5.2, durationSec: 1880, pace: `6'01"` },
    ]),
    m(c, 'assistant', at(-1, '08:41'), '五公里！今天的你闪闪发光。记得拉伸，不然明天腿会哭的。', { expression: 'laugh' }),
    m(c, 'user', at(-1, '12:31'), [{ type: 'meal', logId: 'meal1', meal: 'lunch', food: '牛肉拉面', photo: null }]),
    m(c, 'assistant', at(-1, '12:33'), '又吃拉面……下次我带你去吃后门那家砂锅粥，不许拒绝。', { expression: 'pout' }),
    m(c, 'user', at(-1, '15:10'), [{ type: 'poke', actor: 'user', target: '头' }]),
    m(c, 'assistant', at(-1, '15:10'), '干嘛啦……头发要被你揉乱了。', { expression: 'blush' }),
    m(c, 'narrator', at(-1, '16:10'), [
      { type: 'scene', event: 'enter', sceneId: 'study', locationId: 'library', title: '和苏晚连线 · 陪伴学习', summary: '你在家，她在图书馆', mode: 'remote', youAt: 'real:home' },
    ]),
    m(c, 'narrator', at(-1, '17:05'), [
      { type: 'scene', event: 'leave', sceneId: 'study', locationId: 'library', title: '结束连线', summary: '学了 50 分钟', mode: 'remote', youAt: 'real:home' },
      { type: 'study', logId: 'st1', pomodoros: 2, minutes: 50 },
    ]),
    m(c, 'assistant', at(-1, '17:06'), [
      { type: 'text', text: '今天也很专注嘛，奖励你听首歌：' },
      { type: 'music', songId: 's1', title: '雨停之前', artist: '林知夏' },
    ], { expression: 'smile' }),
    m(c, 'assistant', at(-1, '19:20'), [
      { type: 'text', text: '刚刚想起第一次见你的样子，画下来了。' },
      {
        type: 'image',
        assetKey: null,
        caption: '雨天的图书馆',
        prompt: '1girl, long hair, dark brown hair, hair clip, library, rainy window, warm desk lamp, looking at viewer, soft smile',
        seed: 1314520,
        generated: true,
      },
    ], { expression: 'shy' }),
    m(c, 'assistant', at(-1, '20:02'), [
      { type: 'text', text: '周六……要不要一起去水族馆？' },
      { type: 'date', place: '水族馆', when: '周六 14:00', status: 'invite' },
    ], { expression: 'shy' }),
    m(c, 'user', at(-1, '20:05'), '好呀，周六见'),
    m(c, 'assistant', at(-1, '20:06'), '那说好了！我去查查水族馆几点有喂食秀。', {
      expression: 'laugh',
      swipes: ['那说好了！我去查查水族馆几点有喂食秀。', '一言为定～不许临时说要写论文。', '好！那我周六穿那条你说好看的裙子。'].map((text, i) => ({ text, createdAt: at(-1, '20:06') + i, expression: 'laugh' })),
      swipeIndex: 0,
    }),
  ];
}

function buildJiangyu(): Message[] {
  const c = 'chat-jiangyu';
  return [
    m(c, 'assistant', at(-2, '18:10'), '训练结束。你今天的步数，还不如我热身。'),
    m(c, 'user', at(-2, '18:12'), '……谢谢关心'),
    m(c, 'assistant', at(-2, '18:13'), '明早六点，操场。迟到一分钟，加一圈。', { expression: 'smile' }),
    m(c, 'assistant', at(-1, '06:02'), '到了吗？', { proactive: true }),
    m(c, 'user', at(-1, '06:05'), '在路上了！！'),
    // 你在真实的公园跑，他在他世界的田径场跑：连线晨跑
    m(c, 'narrator', at(-1, '06:08'), [
      { type: 'scene', event: 'enter', sceneId: 'exercise', locationId: 'jy-track', title: '和江屿连线 · 晨跑', summary: '你在社区公园，他在田径场', mode: 'remote', youAt: 'real:park' },
    ]),
    m(c, 'narrator', at(-1, '06:50'), [
      { type: 'workout', logId: 'w0', sport: '跑步', distanceKm: 3.1, durationSec: 1210, pace: `6'30"` },
    ]),
    m(c, 'narrator', at(-1, '06:51'), [
      { type: 'scene', event: 'leave', sceneId: 'exercise', locationId: 'jy-track', title: '结束连线', summary: '跑了 3.1 km', mode: 'remote', youAt: 'real:park' },
    ]),
    m(c, 'assistant', at(-1, '06:52'), '还行。明天继续。', { expression: 'smile' }),
  ];
}

export function buildMessages(): Record<string, Message[]> {
  seq = 0;
  return {
    'chat-suwan': buildSuwan(),
    'chat-jiangyu': buildJiangyu(),
  };
}

/** 消息按人分：每个角色只有一条聊天 */
export function buildChats(messages: Record<string, Message[]>): Chat[] {
  const last = (id: string) => messages[id]?.at(-1)?.createdAt ?? 0;
  const base = { personaId: 'me', currentScene: null, togetherAt: null, togetherMode: null, summaryUntilMessageId: null, pinned: false, mode: 'im' as const, background: null };
  return [
    { ...base, id: 'chat-suwan', characterId: 'suwan', title: '苏晚', pinned: true, createdAt: at(-30, '20:00'), updatedAt: last('chat-suwan'), lastMessageAt: last('chat-suwan') },
    { ...base, id: 'chat-jiangyu', characterId: 'jiangyu', title: '江屿', createdAt: at(-9, '18:00'), updatedAt: last('chat-jiangyu'), lastMessageAt: last('chat-jiangyu') },
  ];
}
