import type { Character } from '@app/shared';

/**
 * 语音通话的演示台词（通话还没接主对话之前用）：按角色写，导入的角色用不带人设的通用台词。
 */
export interface CallScript {
  /** 来电时的一句话：早上 / 深夜 / 其他时候 */
  reason: { morning: string; late: string; other: string };
  lines: { who: 'her' | 'you'; text: string }[];
  /** 没接时她发来的消息 */
  missed: { text: string; expr: string };
}

const SCRIPTS: Record<string, CallScript> = {
  suwan: {
    reason: { morning: '早上好～该起床啦（叫醒来电）', late: '还不睡？我来催你了', other: '想你了，接一下嘛' },
    lines: [
      { who: 'her', text: '喂？……嗯，是我。' },
      { who: 'you', text: '怎么突然打电话来了' },
      { who: 'her', text: '没什么，就是想听听你的声音。' },
      { who: 'you', text: '今天论文写得好累' },
      { who: 'her', text: '辛苦啦。先别想了，深呼吸……对，就这样。' },
      { who: 'you', text: '嗯……' },
      { who: 'her', text: '我陪你一会儿，你困了就直接睡，不用挂。' },
    ],
    missed: { text: '……不接我电话。好吧，你忙完记得回我。', expr: 'pout' },
  },
  jiangyu: {
    reason: { morning: '起床。别让我等。', late: '几点了，还不睡？', other: '……有事找你。' },
    lines: [
      { who: 'her', text: '喂。' },
      { who: 'you', text: '怎么突然打电话来了' },
      { who: 'her', text: '明早六点，别迟到。' },
      { who: 'you', text: '今天论文写得好累' },
      { who: 'her', text: '……那就早点睡，别硬撑。' },
      { who: 'you', text: '嗯……' },
      { who: 'her', text: '挂了。……晚安。' },
    ],
    missed: { text: '不接？行。看到回我。', expr: 'neutral' },
  },
};

function generic(c: Character): CallScript {
  return {
    reason: { morning: '早上好，该起床了', late: '这么晚了，还没睡吗？', other: `${c.name}想和你说说话` },
    lines: [
      { who: 'her', text: '喂？是我。' },
      { who: 'you', text: '怎么突然打电话来了' },
      { who: 'her', text: '没什么事，就是想听听你的声音。' },
      { who: 'you', text: '今天有点累' },
      { who: 'her', text: '辛苦了。先休息一会儿吧。' },
      { who: 'you', text: '嗯……' },
      { who: 'her', text: '我在这儿，你想说话的时候就说。' },
    ],
    missed: { text: '刚才打给你没接……忙完了回我一下。', expr: 'neutral' },
  };
}

export function callScriptOf(c: Character): CallScript {
  return SCRIPTS[c.id] ?? generic(c);
}
