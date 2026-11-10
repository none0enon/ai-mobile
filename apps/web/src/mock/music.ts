/**
 * 示例歌曲全部是虚构的，歌词是原创占位，不使用任何真实歌曲的歌词。
 * 正式版从网易云 Worker 的 /search、/song、/lyric 取数据。
 */
export interface MockSong {
  id: string;
  title: string;
  artist: string;
  durationMs: number;
  hue: number;
}

export const songs: MockSong[] = [
  { id: 's1', title: '雨停之前', artist: '林知夏', durationMs: 140_000, hue: 210 },
  { id: 's2', title: '晚风信箱', artist: '夏屿', durationMs: 236_000, hue: 18 },
  { id: 's3', title: '便利店的猫', artist: '南风乐队', durationMs: 198_000, hue: 150 },
  { id: 's4', title: '第七个夏天', artist: '白鹭', durationMs: 251_000, hue: 45 },
  { id: 's5', title: '月亮邮差', artist: '枕边', durationMs: 222_000, hue: 265 },
  { id: 's6', title: '慢慢走', artist: '陈一', durationMs: 205_000, hue: 330 },
];

export const lyricLrc = `{"t":0,"c":[{"tx":"作词: "},{"tx":"示例"}]}
[ti:雨停之前]
[00:00.00]雨停之前 - 林知夏（示例歌曲）
[00:06.00]（前奏）
[00:12.20]便利店的灯 还亮着
[00:17.60]玻璃上 起了一层雾
[00:23.10]你用手指写下 我的名字
[00:28.80]又笑着 把它擦掉
[00:34.40]雨落在伞的边缘
[00:39.90]像一句 没说完的话
[00:45.30]我们走得很慢很慢
[00:50.70]慢到 整条街都安静了
[00:56.40]如果雨停之前 你还在
[01:02.10]我就把心事 一件件告诉你
[01:07.80]如果雨停之前 你还在
[01:13.60]晚风会替我 先说喜欢你
[01:20.00]（间奏）
[01:31.50]路灯一盏一盏 亮起来
[01:37.10]影子 被拉得很长
[01:42.60]你说下次下雨 还要一起
[01:48.20]我说好 雨天归你
[01:53.90]如果雨停之前 你还在
[01:59.60]我就不撑伞 陪你淋一会儿
[02:05.30]如果雨停以后 你也在
[02:11.10]那就把每个晴天 都分给我`;

export const lyricTranslation = `[00:56.40]If you're still here before the rain stops
[01:07.80]If you're still here before the rain stops`;

/** 一起听歌时她的"弹幕"：唱到第几行时出现 */
export const danmaku: Record<number, string> = {
  6: '像那天你把伞偏向我',
  10: '这句好戳我……',
  13: '（小声）喜欢你',
  18: '雨天归你，晴天也归你',
  21: '下次下雨，我们就听这首吧',
};
