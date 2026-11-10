import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTagStripper, parseControlTags, stripControlTags, type TagStreamEvent } from '../src/tags.ts';
import { formatEnvironmentBlock, solarTermNote, timeOfDay } from '../src/environment.ts';
import { lrcIndexAt, parseLrc } from '../src/lrc.ts';

function run(chunks: string[]) {
  const s = createTagStripper();
  const events: TagStreamEvent[] = [];
  for (const c of chunks) events.push(...s.consume(c));
  events.push(...s.flush());
  const text = events.map((e) => (e.type === 'text' ? e.text : '')).join('');
  const tags = events.flatMap((e) => (e.type === 'tag' ? [e.tag] : []));
  return { text, tags };
}

test('strips a whole tag inside one chunk', () => {
  const r = run(['才没有[expr:blush]在等你呢']);
  assert.equal(r.text, '才没有在等你呢');
  assert.deepEqual(r.tags, [{ kind: 'expr', value: 'blush' }]);
});

test('reassembles a tag split across chunks', () => {
  const r = run(['好呀[e', 'xpr:sm', 'ile]我们走吧']);
  assert.equal(r.text, '好呀我们走吧');
  assert.deepEqual(r.tags, [{ kind: 'expr', value: 'smile' }]);
});

test('parses music, choice and call tags', () => {
  const r = run(['听这首[music:雨停之前 - 林知夏]', '[choice:去看海|去吃粥]', '[call]']);
  assert.equal(r.text, '听这首');
  assert.deepEqual(r.tags, [
    { kind: 'music', title: '雨停之前', artist: '林知夏' },
    { kind: 'choice', options: ['去看海', '去吃粥'] },
    { kind: 'call' },
  ]);
});

test('keeps ordinary brackets that are not tags', () => {
  const r = run(['[笑] 你看', '这个[链接]']);
  assert.equal(r.text, '[笑] 你看这个[链接]');
  assert.equal(r.tags.length, 0);
});

test('flushes an unfinished tag-like tail as text', () => {
  const r = run(['结尾是 [exp']);
  assert.equal(r.text, '结尾是 [exp');
});

test('stripControlTags trims and collects tags', () => {
  const r = stripControlTags('[expr:smile]\n早安～ [cg:窗边的晨光]');
  assert.equal(r.text, '早安～');
  assert.equal(r.tags.length, 2);
});

test('accepts full-width brackets and colon', () => {
  const r = run(['嗯【expr：shy】', '好的']);
  assert.equal(r.text, '嗯好的');
  assert.deepEqual(r.tags, [{ kind: 'expr', value: 'shy' }]);
});

test('parseControlTags works on accumulated text with offsets', () => {
  const full = '才没有[expr:blush]在等你呢[cg:窗边]';
  const p = parseControlTags(full);
  assert.equal(p.visible, '才没有在等你呢');
  assert.deepEqual(
    p.tags.map((t) => [t.tag.kind, t.at]),
    [
      ['expr', 3],
      ['cg', 7],
    ],
  );
  assert.equal(p.pending, false);
});

test('parseControlTags hides a half-received tag while streaming', () => {
  const p = parseControlTags('好呀[expr:sm');
  assert.equal(p.visible, '好呀');
  assert.equal(p.pending, true);
  const done = parseControlTags('好呀[expr:smile]走吧');
  assert.equal(done.visible, '好呀走吧');
  assert.equal(done.pending, false);
});

test('parseControlTags drops tags that the scene does not allow', () => {
  const p = parseControlTags('安静点[cg:图书馆][expr:smile]', ['expr']);
  assert.equal(p.visible, '安静点');
  assert.deepEqual(
    p.tags.map((t) => t.tag.kind),
    ['expr'],
  );
});

test('parseLrc handles ms precision, multi-stamps, credits and translations', () => {
  const lrc = [
    '{"t":0,"c":[{"tx":"作词: "},{"tx":"某人"}]}',
    '[ti:雨停之前]',
    '[00:12.50]便利店的灯 还亮着',
    '[00:45.00][01:30.250]如果雨停之前 你还在',
    '[00:17.8]玻璃上 写着你的名字',
  ].join('\n');
  const lines = parseLrc(lrc, '[00:12.50]The store lights are still on');
  assert.deepEqual(
    lines.map((l) => l.timeMs),
    [12500, 17800, 45000, 90250],
  );
  assert.equal(lines[0]?.translation, 'The store lights are still on');
  assert.equal(lines[3]?.text, '如果雨停之前 你还在');
  assert.equal(lrcIndexAt(lines, 0), -1);
  assert.equal(lrcIndexAt(lines, 46000), 2);
  assert.equal(lrcIndexAt(lines, 999999), 3);
});

test('environment block', () => {
  assert.equal(timeOfDay(21), 'night');
  assert.equal(solarTermNote(new Date(2026, 10, 9)), '立冬后第 2 天');
  const block = formatEnvironmentBlock({
    now: new Date(2026, 10, 9, 21, 30),
    weather: { city: '上海', text: '小雨', tempC: 12, outlook: '明天降到 6°C' },
    todayLine: '你今天走了 8,432 步',
    sinceLastChatMin: 180,
  });
  assert.equal(
    block,
    '【当前环境】2026-11-09 周一 21:30（夜里） · 立冬后第 2 天 · 上海 小雨 12°C，明天降到 6°C · 你今天走了 8,432 步 · 距上次聊天 3 小时',
  );
});
