import { MOMENT_USER, type Moment } from '@app/shared';
import { at } from '@/utils/time';

/**
 * 第一次打开朋友圈时放进去的几条演示动态（演示角色苏晚、江屿发的）：
 * 一条带单据（一小页 HTML 的小票）、一条带要配的图（接通生图后点一下就画）、一条只有字。
 * 接通"社媒 · 朋友圈"的 API 以后，她们自己发的会排在这几条前面；不想要可以删。
 */

const RECEIPT = `<div style='max-width:340px;margin:0 auto;padding:16px 16px 14px;background:#fffdf7;color:#2b2b2b;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;line-height:1.7'><div style='text-align:center;font-size:15px;font-weight:700;letter-spacing:2px'>老陈砂锅粥</div><div style='text-align:center;color:#8a8478'>师大后门店 · 堂食</div><div style='border-top:1px dashed #b9b2a3;margin:8px 0'></div><div style='display:flex;justify-content:space-between'><span>桌号 A07</span><span>2 人</span></div><div style='display:flex;justify-content:space-between;color:#8a8478'><span>单号 20617</span><span>19:42</span></div><div style='border-top:1px dashed #b9b2a3;margin:8px 0'></div><div style='display:flex;justify-content:space-between'><span>皮蛋瘦肉砂锅粥（小）</span><span>18.00</span></div><div style='display:flex;justify-content:space-between'><span>虾仁干贝砂锅粥（小）</span><span>26.00</span></div><div style='display:flex;justify-content:space-between'><span>油条 ×2</span><span>6.00</span></div><div style='display:flex;justify-content:space-between'><span>凉拌海带丝</span><span>8.00</span></div><div style='display:flex;justify-content:space-between;color:#b4532a'><span>学生证 9 折</span><span>-5.80</span></div><div style='border-top:1px dashed #b9b2a3;margin:8px 0'></div><div style='display:flex;justify-content:space-between;font-size:15px;font-weight:700'><span>合计</span><span>¥52.20</span></div><div style='display:flex;justify-content:space-between;color:#8a8478'><span>微信支付</span><span>已付</span></div><div style='margin-top:10px;height:34px;background:repeating-linear-gradient(90deg,#2b2b2b 0 2px,transparent 2px 5px,#2b2b2b 5px 6px,transparent 6px 9px,#2b2b2b 9px 12px,transparent 12px 14px)'></div><div style='text-align:center;color:#8a8478;margin-top:6px'>粥要趁热喝 · 欢迎再来</div></div>`;

/** 没接通"社媒 · 朋友圈"的 API 时，演示角色给你的朋友圈的回应（占位台词） */
export const DEMO_REACTIONS: Record<string, { comment: string[]; reply: string[] }> = {
  suwan: { comment: ['看到了。今天也有好好吃饭吗？', '嗯？这个回头要跟我说说。', '（偷偷存图）'], reply: ['知道啦。', '那你下次带我去。'] },
  jiangyu: { comment: ['嗯。', '早点睡，明天六点。'], reply: ['行。', '少贫。'] },
};

export function demoMoments(): Moment[] {
  const post = (id: string, authorId: string, createdAt: number, rest: Partial<Moment>): Moment => ({
    id, authorId, text: '', images: [], visibleTo: null, likes: [], comments: [], createdAt, updatedAt: createdAt, source: 'device', ...rest,
  });
  return [
    post('moment-demo-suwan-1', 'suwan', at(-2, '19:58'), {
      text: '后门的砂锅粥今天居然不用排队。某人说自己不饿，然后吃掉了我半碗。',
      html: RECEIPT,
      htmlTitle: '砂锅粥店小票',
      location: '老陈砂锅粥 · 师大后门店',
      likes: [MOMENT_USER],
      comments: [
        { id: 'mc-demo-1', authorId: MOMENT_USER, text: '是你说吃不完的', at: at(-2, '20:06') },
        { id: 'mc-demo-2', authorId: 'suwan', text: '我说的是"可能"吃不完。', replyTo: MOMENT_USER, at: at(-2, '20:09') },
      ],
    }),
    post('moment-demo-jiangyu-1', 'jiangyu', at(-1, '06:21'), {
      text: '6:03。有人迟到三分钟，加一圈。',
      location: '东操场',
    }),
    post('moment-demo-suwan-2', 'suwan', at(-1, '15:40'), {
      text: '下雨了。图书馆靠窗的位置今天归我。',
      images: [{ caption: '图书馆靠窗的座位，玻璃上挂着雨珠，桌上摊开的书和一杯热拿铁，俯拍，没有人', assetKey: null }],
    }),
  ];
}
