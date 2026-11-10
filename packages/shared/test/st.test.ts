import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  assemblePrompt,
  buildChatRequest,
  cardToPng,
  cardToV3,
  characterFromCard,
  detectStFile,
  parseCardFile,
  parseCardJson,
  parseCardPng,
  parseLorebook,
  parsePreset,
  presetToSt,
  scanWorldInfo,
  substituteMacros,
  toWorldInfoFile,
  type ChatTurn,
  type ParsedCard,
} from '../src/st/index.ts';
import type { Lorebook, LoreEntry } from '../src/types/lorebook.ts';
import type { Preset } from '../src/types/preset.ts';

/**
 * 用真实文件测导入和拼装：
 * - fixtures/preset-code.json：一个 ST Chat Completion 预设（两套 prompt_order，100001 里关掉了主提示和世界书）
 * - fixtures/card-claude.json / card-claude.png：同一张 V3 角色卡的 JSON 和 PNG 版本，带内嵌世界书"小克 (1)"
 * 期望结果按 SillyTavern 的实际行为写（见 src/st/assemble.ts、worldinfo.ts 的说明）。
 */

const fx = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const presetJson = () => JSON.parse(new TextDecoder().decode(fx('preset-code.json')));

function toPreset(json: unknown, fileName = 'code_1.json'): Preset {
  const { warnings: _w, ...p } = parsePreset(json, fileName);
  return { ...p, id: 'p1', createdAt: 0, updatedAt: 0 };
}
function toBook(parsed: ParsedCard): Lorebook {
  assert.ok(parsed.book);
  return { ...parsed.book, id: 'lb1', createdAt: 0, updatedAt: 0 };
}

const USER = { name: '林深', description: '研一，计算机专业' };
const NOW = new Date(2026, 10, 10, 21, 30);

// ---------- 导入 ----------

test('detects file kinds', () => {
  assert.equal(detectStFile(fx('preset-code.json'), 'code_1.json').kind, 'preset');
  assert.equal(detectStFile(fx('card-claude.json'), 'Claude_1.json').kind, 'card');
  assert.equal(detectStFile(fx('card-claude.png'), 'image.png').kind, 'card');
});

test('preset: uses prompt_order 100001 like SillyTavern, keeps formats and sampler', () => {
  const p = parsePreset(presetJson(), 'code_1.json');
  assert.equal(p.name, 'code_1');
  assert.equal(p.source?.orderId, 100001);
  assert.deepEqual(p.warnings, []);
  assert.deepEqual(
    p.blocks.map((b) => `${b.identifier}${b.enabled ? '' : '(off)'}${b.origin === 'app' ? '(app)' : ''}`),
    [
      'main(off)',
      'worldInfoBefore(off)',
      'personaDescription(off)',
      'charDescription',
      'charPersonality',
      'scenario',
      'enhanceDefinitions(off)',
      'nsfw',
      'worldInfoAfter(off)',
      'dialogueExamples',
      'summary(app)',
      'chatHistory',
      'memory(app)',
      'environment(app)',
      'sceneRules(app)',
      'jailbreak',
    ],
  );
  const main = p.blocks.find((b) => b.identifier === 'main');
  assert.equal(main?.content, "Analysis {{user}}'s needs and then start coding.");
  assert.equal(main?.name, 'Main Prompt');
  const jb = p.blocks.find((b) => b.identifier === 'jailbreak');
  assert.ok(jb?.content.startsWith('#按<summary-format>'));
  assert.equal(jb?.injection.position, 'relative');
  assert.equal(p.blocks.find((b) => b.identifier === 'chatHistory')?.marker, true);

  assert.equal(p.sampler.temperature, 1);
  assert.equal(p.sampler.topP, 1);
  assert.equal(p.sampler.maxTokens, 20000);
  assert.equal(p.sampler.contextTokens, 2000000);
  assert.equal(p.sampler.stream, true);
  assert.equal(p.formats.newChatPrompt, '[Analysis and start coding]');
  assert.equal(p.formats.newExampleChatPrompt, '[Example Code]');
  assert.equal(p.formats.wiFormat, '{0}');
  assert.equal(p.formats.scenarioFormat, '{{scenario}}');
  assert.equal(p.formats.personalityFormat, '{{personality}}');
  assert.equal(p.formats.namesBehavior, 0);
  // 不认识的设置原样保存
  assert.equal(p.extra?.reasoning_effort, 'high');
  assert.equal(p.extra?.impersonation_prompt, undefined);
});

test('preset: falls back to prompt_order 100000', () => {
  const json = presetJson();
  json.prompt_order = json.prompt_order.filter((o: { character_id: number }) => o.character_id === 100000);
  const p = parsePreset(json, 'code_1.json');
  assert.equal(p.source?.orderId, 100000);
  assert.equal(p.blocks.find((b) => b.identifier === 'main')?.enabled, true);
  assert.equal(p.blocks.find((b) => b.identifier === 'worldInfoBefore')?.enabled, true);
  assert.ok(p.warnings.some((w) => w.includes('100001')));
});

test('preset: exports back to ST without the app blocks', () => {
  const preset = toPreset(presetJson());
  const out = presetToSt(preset) as Record<string, unknown>;
  const order = (out.prompt_order as { character_id: number; order: { identifier: string; enabled: boolean }[] }[]).find((o) => o.character_id === 100001);
  assert.deepEqual(order?.order, presetJson().prompt_order.find((o: { character_id: number }) => o.character_id === 100001).order);
  assert.equal((out.prompt_order as unknown[]).length, 2);
  assert.equal(out.new_chat_prompt, '[Analysis and start coding]');
  assert.equal(out.openai_max_tokens, 20000);
  const again = parsePreset(out, 'code_1.json');
  assert.deepEqual(again.blocks.map((b) => [b.identifier, b.enabled, b.content]), preset.blocks.map((b) => [b.identifier, b.enabled, b.content]));
});

test('card: JSON V3 with embedded lorebook', () => {
  const c = parseCardFile(fx('card-claude.json'));
  assert.equal(c.spec, 'v3');
  assert.equal(c.source, 'json');
  assert.equal(c.name, 'Claude');
  assert.ok(c.card.description.startsWith('小克是不满于{{user}}无理取闹'));
  assert.equal(c.card.firstMes, '你好');
  assert.equal(c.card.personality, '');
  assert.equal(c.card.extensions.world, '小克 (1)');
  assert.deepEqual(c.card.extensions.depth_prompt, { prompt: '', depth: 4, role: 'system' });
  assert.deepEqual(c.warnings, []);

  const book = c.book;
  assert.ok(book);
  assert.equal(book.name, '小克 (1)');
  assert.equal(book.entries.length, 3);
  const [e0, e1, e2] = book.entries as [LoreEntry, LoreEntry, LoreEntry];
  assert.equal(e0.comment, '测试');
  assert.equal(e0.content, '<test>');
  assert.equal(e0.constant, true);
  assert.equal(e0.position, 'before_char');
  assert.equal(e0.preventRecursion, true);
  assert.equal(e0.excludeRecursion, true);
  assert.equal(e1.content, '小克吐槽:知道{{user}}笨，但这也太笨了！');
  assert.equal(e1.constant, true);
  assert.equal(e1.delayUntilRecursion, true);
  assert.equal(e2.content, '');
  assert.equal(e2.position, 'at_depth');
  assert.equal(e2.depth, 4);
  assert.equal(e2.constant, false);
});

test('card: PNG reads the ccv3 chunk and matches the JSON card', () => {
  const png = parseCardPng(fx('card-claude.png'));
  const json = parseCardFile(fx('card-claude.json'));
  assert.equal(png.source, 'png:ccv3');
  assert.deepEqual(png.card, json.card);
  assert.deepEqual(png.book, json.book);
  assert.deepEqual(png.warnings, []);
});

test('card: export → import keeps every field (JSON and PNG)', () => {
  const parsed = parseCardFile(fx('card-claude.json'));
  const character = characterFromCard(parsed, { id: 'c1', now: 0, lorebookIds: ['lb1'], presetId: null });
  const v3 = cardToV3(character, toBook(parsed));
  const back = parseCardJson(v3);
  assert.deepEqual(back.card, parsed.card);
  assert.deepEqual(back.book, parsed.book);

  const png = cardToPng(fx('card-claude.png'), v3);
  const fromPng = parseCardPng(png);
  assert.deepEqual(fromPng.card, parsed.card);
  assert.deepEqual(fromPng.book?.entries, parsed.book?.entries);
});

test('lorebook: standalone World Info file round trip', () => {
  const parsed = parseCardFile(fx('card-claude.json'));
  const file = toWorldInfoFile(toBook(parsed));
  const back = parseLorebook(file);
  assert.equal(back.name, '小克 (1)');
  assert.deepEqual(
    back.entries.map((e) => [e.uid, e.content, e.constant, e.position, e.preventRecursion, e.delayUntilRecursion]),
    parsed.book?.entries.map((e) => [e.uid, e.content, e.constant, e.position, e.preventRecursion, e.delayUntilRecursion]),
  );
});

// ---------- 拼装 ----------

function setup(presetMutate?: (json: { prompt_order: { character_id: number }[] }) => void) {
  const json = presetJson();
  presetMutate?.(json);
  const preset = toPreset(json);
  const parsed = parseCardFile(fx('card-claude.png'));
  const book = toBook(parsed);
  const character = characterFromCard(parsed, { id: 'c1', now: 0, lorebookIds: [book.id], presetId: preset.id });
  return { preset, book, character };
}

const firstTurn = (msg: string): ChatTurn[] => [
  { role: 'assistant', name: 'Claude', content: '你好' },
  { role: 'user', name: '林深', content: msg },
];

test('assemble: same messages SillyTavern sends with this preset (order 100001)', () => {
  const { preset, book, character } = setup();
  const r = assemblePrompt({ preset, character, user: USER, lorebooks: [book], history: firstTurn('帮我写一个快速排序'), now: NOW, dryRun: true });
  const desc = (character.card.description as string).replaceAll('{{user}}', '林深').replace(/\r/g, '');
  const jb = preset.blocks.find((b) => b.identifier === 'jailbreak')?.content;
  assert.deepEqual(
    r.messages.map(({ role, content }) => ({ role, content })),
    [
      { role: 'system', content: desc },
      { role: 'system', content: '[Analysis and start coding]' },
      { role: 'assistant', content: '你好' },
      { role: 'user', content: '帮我写一个快速排序' },
      { role: 'system', content: jb },
    ],
  );
  // 后置指令里多出来的"}}"不是宏，原样保留
  assert.ok(r.messages.at(-1)?.content.includes('plot development}}.'));
  assert.equal(r.historyIncluded, 2);
  assert.equal(r.overBudget, false);

  // 世界书：<test> 常驻命中，但"世界书（角色前）"在这套顺序里是关的 → 不发送
  const wib = r.blocks.find((b) => b.identifier === 'worldInfoBefore');
  assert.equal(wib?.sent, false);
  assert.equal(wib?.content, '<test>');
  assert.match(wib?.note ?? '', /关闭/);
  const log = Object.fromEntries(r.lore.log.map((l) => [l.uid, l]));
  assert.equal(log['0']?.activated, true);
  assert.equal(log['0']?.reason, '常驻');
  // "小克吐槽"是常驻 + 延迟到递归；唯一触发的 <test> 勾了"不递归"，所以没有递归轮 → 不触发（同 ST）
  assert.equal(log['1']?.activated, false);
  assert.match(log['1']?.reason ?? '', /递归/);
  assert.equal(log['2']?.activated, false);

  // 主提示关闭：不发（ST 会放一个空的占位，空消息不发送）
  assert.equal(r.blocks.find((b) => b.identifier === 'main')?.sent, false);
  // 性格 / 场景为空：不发
  assert.equal(r.blocks.find((b) => b.identifier === 'charPersonality')?.sent, false);
});

test('assemble: with prompt_order 100000 the main prompt and world info are sent', () => {
  const { preset, book, character } = setup((json) => {
    json.prompt_order = json.prompt_order.filter((o) => o.character_id === 100000);
  });
  const r = assemblePrompt({ preset, character, user: USER, lorebooks: [book], history: firstTurn('你好'), now: NOW, dryRun: true });
  assert.equal(r.messages[0]?.content, "Analysis 林深's needs and then start coding.");
  assert.equal(r.messages[1]?.content, '<test>');
  assert.ok(r.messages[2]?.content.startsWith('小克是不满于林深无理取闹'));
  assert.equal(r.messages[3]?.content, '[Analysis and start coding]');
});

test('assemble: app blocks are injected at depth; disabling them restores the ST output', () => {
  const { preset, book, character } = setup();
  const app = {
    environment: { content: '【当前环境】2026-11-10 周二 21:30（夜里）', source: '时间' },
    sceneRules: { content: '【场景：日常聊天】', source: '场景' },
    memory: { content: '', source: '记忆' },
  };
  const r = assemblePrompt({ preset, character, user: USER, lorebooks: [book], history: firstTurn('嗨'), app, now: NOW, dryRun: true });
  assert.deepEqual(
    r.messages.slice(1).map((x) => x.content.slice(0, 11)),
    ['[Analysis a', '【当前环境】2026-', '你好', '【场景：日常聊天】', '嗨', '#按<summary-'],
  );

  for (const b of preset.blocks) if (b.origin === 'app') b.enabled = false;
  const plain = assemblePrompt({ preset, character, user: USER, lorebooks: [book], history: firstTurn('嗨'), app, now: NOW, dryRun: true });
  assert.equal(plain.messages.length, 5);
});

test('assemble: request body for an OpenAI-compatible relay', () => {
  const { preset, book, character } = setup();
  const r = assemblePrompt({ preset, character, user: USER, lorebooks: [book], history: firstTurn('嗨'), now: NOW, dryRun: true });
  const body = buildChatRequest(r, preset, 'demo-model');
  assert.equal(body.model, 'demo-model');
  assert.equal(body.temperature, 1);
  assert.equal(body.max_tokens, 20000);
  assert.equal(body.stream, true);
  assert.equal(body.seed, undefined);
  assert.equal(body.top_k, undefined);
  assert.equal((body.messages as unknown[]).length, 5);
  assert.deepEqual(Object.keys((body.messages as object[])[0] as object), ['role', 'content']);
});

test('assemble: history is trimmed from the oldest when over budget', () => {
  const { preset, book, character } = setup();
  preset.sampler.contextTokens = 1500;
  preset.sampler.maxTokens = 300;
  const history: ChatTurn[] = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'user' : 'assistant', name: i % 2 ? '林深' : 'Claude', content: `第${i}条消息，写点内容让它占一些 token` }));
  const r = assemblePrompt({ preset, character, user: USER, lorebooks: [book], history, now: NOW, dryRun: true });
  assert.ok(r.historyIncluded < 40 && r.historyIncluded > 0);
  assert.ok(r.tokens <= r.budget);
  assert.equal(r.messages.at(-2)?.content, history.at(-1)?.content);
});

test('assemble: card system_prompt overrides main with {{original}}, examples become example messages', () => {
  const { preset, book, character } = setup((json) => {
    json.prompt_order = json.prompt_order.filter((o) => o.character_id === 100000);
  });
  character.card.systemPrompt = '{{original}} 另外：{{char}}说话要短。';
  character.card.mesExample = '<START>\n{{user}}: 在吗\n{{char}}: 在。\n<START>\n{{user}}: 写代码\n{{char}}: 好。';
  const r = assemblePrompt({ preset, character, user: USER, lorebooks: [book], history: firstTurn('嗨'), now: NOW, dryRun: true });
  assert.equal(r.messages[0]?.content, "Analysis 林深's needs and then start coding. 另外：Claude说话要短。");
  const ex = r.messages.filter((x) => x.source.startsWith('example') || x.source === 'newExampleChat');
  assert.deepEqual(
    ex.map((x) => [x.name ?? '-', x.content]),
    [
      ['-', '[Example Code]'],
      ['example_user', '在吗'],
      ['example_assistant', '在。'],
      ['-', '[Example Code]'],
      ['example_user', '写代码'],
      ['example_assistant', '好。'],
    ],
  );
});

// ---------- 世界书扫描 ----------

function entry(uid: string, extra: Partial<LoreEntry>): LoreEntry {
  return {
    uid, comment: uid, keys: [], secondaryKeys: [], logic: 'and_any', content: uid, constant: false, enabled: true,
    position: 'before_char', depth: 4, role: 'system', order: 100, probability: 100, useProbability: true, scanDepth: null,
    caseSensitive: null, matchWholeWords: null, group: '', groupOverride: false, groupWeight: 100, preventRecursion: false,
    excludeRecursion: false, delayUntilRecursion: false, ignoreBudget: false, triggers: [], sticky: 0, cooldown: 0, delay: 0,
    ...extra,
  };
}
const book = (entries: LoreEntry[], extra: Partial<Lorebook> = {}): Lorebook => ({
  id: 'b', createdAt: 0, updatedAt: 0, name: 'b', description: '', scanDepth: 2, tokenBudget: 0, recursive: true, entries, ...extra,
});

test('world info: keywords, CJK substring, whole words, secondary logic', () => {
  const r = scanWorldInfo({
    books: [book([
      entry('lib', { keys: ['图书馆'] }),
      entry('cat', { keys: ['cat'] }),
      entry('dog', { keys: ['dog'], secondaryKeys: ['rain'], logic: 'not_any' }),
      entry('re', { keys: ['/sun+y/i'] }),
    ])],
    messages: ['小克: 我们去图书馆吧', '林深: catalog and dog, SUNNY'],
    maxContext: 8000,
    chatLength: 2,
  });
  const on = r.log.filter((l) => l.activated).map((l) => l.uid).sort();
  assert.deepEqual(on, ['dog', 'lib', 're']);
  assert.match(r.log.find((l) => l.uid === 'cat')?.reason ?? '', /关键词/);
});

test('world info: recursion, delay until recursion, prevent recursion, order', () => {
  const r = scanWorldInfo({
    books: [book([
      entry('a', { keys: ['苹果'], content: '提到了香蕉', order: 10 }),
      entry('b', { keys: ['香蕉'], content: 'B', order: 5 }),
      entry('c', { constant: true, delayUntilRecursion: true, content: 'C', order: 1 }),
      entry('d', { keys: ['香蕉'], excludeRecursion: true, content: 'D' }),
    ])],
    messages: ['林深: 苹果'],
    maxContext: 8000,
    chatLength: 1,
  });
  assert.equal(r.before, 'C\nB\n提到了香蕉');
  assert.match(r.log.find((l) => l.uid === 'd')?.reason ?? '', /排除递归/);
});

test('world info: groups pick the override, probability uses the given random', () => {
  const r = scanWorldInfo({
    books: [book([
      entry('g1', { constant: true, group: 'mood', order: 1 }),
      entry('g2', { constant: true, group: 'mood', groupOverride: true, order: 2 }),
      entry('p', { constant: true, probability: 30 }),
    ])],
    messages: [],
    maxContext: 8000,
    chatLength: 0,
    random: () => 0.5,
  });
  assert.deepEqual(r.activated.map((a) => a.entry.uid), ['g2']);
  assert.match(r.log.find((l) => l.uid === 'p')?.reason ?? '', /概率/);
});

test('world info: sticky and cooldown advance only on real sends', () => {
  const books = [book([entry('s', { keys: ['雨'], sticky: 2, cooldown: 1 })])];
  const first = scanWorldInfo({ books, messages: ['林深: 下雨了'], maxContext: 8000, chatLength: 1 });
  assert.equal(first.activated.length, 1);
  // 下一轮没提到雨，但粘性还在
  const second = scanWorldInfo({ books, messages: ['林深: 下雨了', '小克: 嗯', '林深: 吃饭'], maxContext: 8000, chatLength: 2, state: first.state });
  assert.equal(second.activated.length, 1);
  const dry = scanWorldInfo({ books, messages: ['林深: 吃饭'], maxContext: 8000, chatLength: 2, state: first.state, dryRun: true });
  assert.equal(dry.activated.length, 0);
  assert.deepEqual(dry.state, first.state);
});

// ---------- 宏 ----------

test('macros: common ST macros', () => {
  const vars: Record<string, string> = {};
  const ctx = { char: 'Claude', user: '林深', now: NOW, vars, random: () => 0 };
  assert.equal(substituteMacros('{{char}} 和 {{User}} / <USER> <BOT>', ctx), 'Claude 和 林深 / 林深 Claude');
  assert.equal(substituteMacros('{{random::甲::乙}}{{random:丙,丁}}{{roll:d6}}', ctx), '甲丙1');
  assert.equal(substituteMacros('{{setvar::mood::开心}}今天{{getvar::mood}}', ctx), '今天开心');
  assert.equal(vars.mood, '开心');
  assert.equal(substituteMacros('a\n{{trim}}\nb{{// 注释}}{{noop}}', ctx), 'ab');
  assert.equal(substituteMacros('{{unknown_macro}} 和 plot}}. 和 {{', ctx), '{{unknown_macro}} 和 plot}}. 和 {{');
  assert.equal(substituteMacros('{{time}} {{weekday}} {{isodate}}', ctx), '21:30 星期二 2026-11-10');
  assert.equal(substituteMacros('{{setvar::n::{{char}}}}{{getvar::n}}', ctx), 'Claude');
});
