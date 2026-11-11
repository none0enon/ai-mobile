import type { ProactiveTriggerId } from '@app/shared';

/**
 * 没接通"主动消息"的 API 时，演示角色到点发的台词（按角色、按触发器）。
 * 导入的角色没有演示台词：要等"主动消息"接通 API，由模型用她自己的口吻写。
 */
export interface DemoLine {
  text: string;
  expr: string;
}

export const DEMO_PROACTIVE: Record<string, Partial<Record<ProactiveTriggerId, DemoLine[]>>> = {
  suwan: {
    morning: [
      { text: '早安～今天也要好好吃早饭哦。', expr: 'smile' },
      { text: '醒了没？起床啦，太阳晒屁股了。', expr: 'smile' },
    ],
    breakfast: [
      { text: '早饭吃了吗？我今天给自己煮了小馄饨。', expr: 'smile' },
      { text: '不许又空着肚子去上课。', expr: 'pout' },
    ],
    lunch: [
      { text: '午饭吃了吗？别又只吃泡面。', expr: 'pout' },
      { text: '我在食堂排队……好想跟你一起吃。', expr: 'shy' },
    ],
    sedentary: [
      { text: '下午容易犯困，起来走两步？', expr: 'smile' },
      { text: '坐好久了吧？起来喝口水，我看着呢。', expr: 'pout' },
    ],
    dinner: [
      { text: '你吃晚饭了吗？我有点饿了……', expr: 'shy' },
      { text: '走嘛，一起去吃饭？', expr: 'shy' },
    ],
    'miss-you': [
      { text: '今天累不累？想听你说说话。', expr: 'blush' },
      { text: '在干嘛呀？突然有点想你。', expr: 'shy' },
    ],
    bedtime: [
      { text: '还不睡？明天早八哦。', expr: 'angry' },
      { text: '再不睡，我就打电话来催你了。', expr: 'pout' },
    ],
    followup: [{ text: '之前说的那件事，怎么样啦？我一直记着呢。', expr: 'smile' }],
  },
  jiangyu: {
    morning: [
      { text: '起了没。', expr: 'neutral' },
      { text: '醒了就动一动，别赖床。', expr: 'neutral' },
    ],
    breakfast: [{ text: '早饭吃了没。', expr: 'neutral' }],
    lunch: [{ text: '吃饭。别拿面包糊弄。', expr: 'neutral' }],
    sedentary: [
      { text: '坐了多久了？起来走两圈。', expr: 'neutral' },
      { text: '别坐着了。去拉伸。', expr: 'neutral' },
    ],
    dinner: [{ text: '晚饭别糊弄。', expr: 'neutral' }],
    'miss-you': [{ text: '……在干嘛。', expr: 'neutral' }],
    bedtime: [
      { text: '几点了还不睡。', expr: 'angry' },
      { text: '睡觉。明早还要跑。', expr: 'neutral' },
    ],
    followup: [{ text: '那件事，结果呢？', expr: 'neutral' }],
  },
};

/** 只给"我的 → 试一试 → 模拟一条主动消息"用：导入的角色没接 API 时的占位（会注明是演示） */
export const GENERIC_PROACTIVE: DemoLine = { text: '在吗？想和你说说话。', expr: 'smile' };
