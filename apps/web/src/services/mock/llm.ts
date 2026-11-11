import { estimateTokens } from '@app/shared';
import type { LLMClient, LLMRequest, LLMResult, StreamState } from '../types';
import { pick, sleep } from '@/utils/id';

/**
 * 假的主对话模型：按最后一句话里的关键词挑一条预写的回复，然后像真的流式接口一样
 * 先"思考"一会儿，再每次吐 1-3 个字。回复里夹带控制标签，用来演示换表情、发歌、要配图、来电。
 */
const RULES: { test: RegExp; replies: string[] }[] = [
  {
    test: /戳|拍了拍|摸/,
    replies: [
      '[expr:pout]再戳我就要生气了哦。',
      '[expr:blush]……干嘛啦，想我了就直说。',
      '[expr:laugh]哈哈哈好痒！停、停一下！',
      '[expr:shy]（小声）……再摸一下也不是不行。',
    ],
  },
  {
    test: /饿|吃饭|晚饭|午饭|早饭|夜宵/,
    replies: [
      '[expr:smile]那正好，[expr:shy]我也还没吃……要不要一起？我想吃后门那家砂锅粥。',
      '[expr:pout]又没吃饭？快去！[expr:smile]吃完拍给我看，我要检查。',
    ],
  },
  {
    test: /累|困|烦|焦虑|论文|难受/,
    replies: [
      '[expr:sad]辛苦啦。[expr:smile]先别想论文了，过来，我给你讲个超级无聊的故事，保证你三分钟睡着。',
      '[expr:shy]那……要不要打个电话？我陪你一会儿。[call]',
    ],
  },
  {
    test: /喜欢|爱你|想你/,
    replies: ['[expr:blush]……笨蛋，突然说这个干嘛。[expr:shy]我、我也是啦。', '[expr:blush]再说一遍，我刚刚没听清。'],
  },
  {
    test: /歌|音乐|听/,
    replies: ['[expr:smile]我最近一直在听这首，你也听听？[music:雨停之前-林知夏]'],
  },
  {
    test: /画|照片|自拍|样子|看看你/,
    replies: ['[expr:shy]那……只给你一个人看哦。[cg:雨夜的窗边，她抱着靠垫回头看，台灯暖光]'],
  },
  {
    test: /约会|周六|水族馆|出去玩/,
    replies: ['[expr:laugh]好呀！[expr:smile]那我们先去哪儿？[choice:先去看水母|先吃冰淇淋|去拍大头贴]'],
  },
  {
    test: /晚安|睡了|睡觉/,
    replies: ['[expr:sleepy]嗯……晚安。[expr:sleep]梦里也要见面哦。'],
  },
];

const FALLBACK = [
  '[expr:smile]嗯嗯，我在听。[expr:shy]然后呢？',
  '[expr:neutral]……[expr:smile]你今天话好多，不过我喜欢听。',
  '[expr:laugh]哈哈，你怎么这么可爱。[expr:smile]继续说～',
  '[expr:shy]（托着下巴看你）[expr:smile]你说什么我都爱听。',
];

/** 演示台词是给苏晚、江屿写的 */
const DEMO_CHARACTERS = new Set(['suwan', 'jiangyu']);

/**
 * 导入的角色还没接真实模型时：不说演示台词，而是报告这一轮实际拼出来的提示词，方便核对。
 */
function echo(req: LLMRequest): string {
  const n = (role: string) => req.messages.filter((m) => m.role === role).length;
  const tokens = req.messages.reduce((t, m) => t + estimateTokens(m.content), 0);
  const lastUser = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const quote = lastUser.length > 24 ? `${lastUser.slice(0, 24)}…` : lastUser;
  return `（演示模型，还没接真实 API）这一轮拼好了 ${req.messages.length} 条消息，约 ${tokens} tokens：系统 ${n('system')} 条、你 ${n('user')} 条、角色 ${n('assistant')} 条。你最后说的是「${quote}」。右上角 ⋯ → 查看提示词 能看到每一条。`;
}

function choose(req: LLMRequest): string {
  if (req.characterId && !DEMO_CHARACTERS.has(req.characterId)) return echo(req);
  const lastUser = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const rule = RULES.find((r) => r.test.test(lastUser));
  return pick(rule ? rule.replies : FALLBACK);
}

export class MockLLM implements LLMClient {
  async chat(
    req: LLMRequest,
    cb?: { onText?(full: string): void; onState?(state: StreamState): void },
  ): Promise<LLMResult> {
    const reply = choose(req);
    cb?.onState?.('sent');
    await sleep(220, req.signal);
    cb?.onState?.('thinking');
    await sleep(380 + Math.random() * 300, req.signal);
    cb?.onState?.('streaming');
    let full = '';
    let i = 0;
    while (i < reply.length) {
      const step = 1 + Math.floor(Math.random() * 3);
      full += reply.slice(i, i + step);
      i += step;
      cb?.onText?.(full);
      await sleep(38 + Math.random() * 40, req.signal);
    }
    return { text: full, thinking: '', model: '演示模型', connectionId: '', fellBack: false, demo: true };
  }
}
