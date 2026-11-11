import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentRoute, FeatureApi, Memory } from '@app/shared';
import { AiError, errorReport } from '../src/core/errors.ts';
import type { Transport } from '../src/core/http.ts';
import { encodeVector, l2normalize } from '../src/embedding/vector.ts';
import { buildImagePromptMessages, parseImagePrompt, toImageRequest } from '../src/agents/imagePrompt.ts';
import { illustrate } from '../src/agents/illustrate.ts';
import { rankMemories, staleMemories } from '../src/agents/retrieval.ts';
import { AgentRouter, type AgentConfig } from '../src/agents/router.ts';
import { buildSidestoryMessages, parseSidestory } from '../src/agents/sidestory.ts';
import { parseSummary } from '../src/agents/summary.ts';
import { AgentSystem, MemoryAudioCache } from '../src/agents/system.ts';
import { bytesResponse, fakeTransport, json } from './helpers.ts';

function api(id: string, over: Partial<FeatureApi> = {}): FeatureApi {
  return { channel: 'openai', baseUrl: `https://${id}.example/v1`, model: 'm', models: ['m'], ...over };
}

function route(role: AgentRoute['role'], over: Partial<AgentRoute> = {}): AgentRoute {
  return { role, api: null, backup: null, runsOn: 'device', ...over };
}

/** 一个假的配置：每个功能的 Key 默认都有（key-api:main 这样），keys 里写 '' 表示没填 */
function setup(routes: AgentRoute[], keys: Record<string, string> = {}): AgentConfig {
  return { routes: () => routes, keyOf: (id) => (id in keys ? keys[id] || null : `key-${id}`) };
}

/** 路由出来的端点没有 transport（用全局 fetch）：测试里把全局 fetch 换成假的 */
async function withFetch<T>(t: Transport, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string, init: RequestInit) => t(String(url), init ?? {})) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test('router status explains why a feature cannot run; text features follow the main chat', () => {
  const r = new AgentRouter(
    setup(
      [
        route('main'),
        route('sidestory', { sameAsMain: true }),
        route('imagePrompt', { api: api('nai', { channel: 'novelai' }) }),
        route('summary', { api: api('x', { baseUrl: ' ' }) }),
        route('proactive', { api: api('a') }),
        route('vision', { api: api('local', { baseUrl: 'http://192.168.1.5:8787/v1' }) }),
        route('tts', { api: api('sv', { channel: 'gpt-sovits', baseUrl: 'https://tts.example', model: '' }) }),
        route('stt', { api: api('sf', { channel: 'siliconflow' }) }),
      ],
      { 'api:proactive': '', 'api:vision': '', 'api:tts': '' },
    ),
  );
  assert.match((r.status('main') as { reason: string }).reason, /主对话还没设置 API/);
  assert.match((r.status('sidestory') as { reason: string }).reason, /主对话还没设置 API（跟随主对话）/);
  assert.match((r.status('imagePrompt') as { reason: string }).reason, /NovelAI不能做对话/);
  assert.match((r.status('summary') as { reason: string }).reason, /还没填地址/);
  assert.equal((r.status('proactive') as { code: string }).code, 'no_key');
  // 局域网地址、自建 GPT-SoVITS 不填 Key 也能用
  assert.equal(r.status('vision').live, true);
  assert.equal(r.status('tts').live, true);
  assert.match((r.status('stt') as { reason: string }).reason, /还没接入/);
  // 自定义渠道的文本功能默认按 Gemini 格式（同 math-reader 的自定义渠道），其他功能按 OpenAI 格式
  const custom = new AgentRouter(setup([route('main', { api: api('c', { channel: 'custom' }) }), route('summary', { sameAsMain: true }), route('embedding', { api: api('e', { channel: 'custom' }) })]));
  const a = custom.attempts('summary')[0]!;
  assert.equal(a.endpoint.kind, 'gemini');
  assert.equal(a.source, 'main');
  assert.equal(a.endpoint.key, 'key-api:main');
  assert.equal(custom.attempts('embedding')[0]!.endpoint.kind, 'openai');
});

test('chat failover: fallback gets a minimal request (SleepTogether), meta and callbacks report it, output is trimmed', async () => {
  const t = fakeTransport((req) =>
    req.url.startsWith('https://a.example')
      ? json({ error: { message: 'upstream down' } }, 502)
      : json({ choices: [{ message: { content: '我在想……</think>备用的回复' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
  );
  const routes = [route('main', { api: api('a', { model: 'big' }), backup: api('b', { model: 'small' }), params: { temperature: 0.8, reasoningEffort: 'high' }, extra: { top_a: 0.2 } })];
  const seen: string[] = [];
  const calls: string[] = [];
  const sys = new AgentSystem({
    config: setup(routes),
    onFailover: (role, from, to, e) => seen.push(`${role}:${from.endpoint.connectionId}→${to.endpoint.connectionId}:${(e as Error).message}`),
    onCall: (role, o) => calls.push(`${role}:${o.ok ? `ok${o.fellBack ? ' fellBack' : ''}` : 'failed'}`),
  });
  const r = await withFetch(t, () => sys.chat('main', { messages: [{ role: 'user', content: '在吗' }], topP: 0.9 }));
  // 只有结束标签的思考内容被修剪掉（SleepTogether 的默认规则）
  assert.equal(r.text, '备用的回复');
  assert.equal(r.fellBack, true);
  assert.equal(r.model, 'small');
  const first = t.calls[0]!.body;
  assert.equal(first.temperature, 0.8);
  assert.equal(first.reasoning_effort, 'high');
  assert.equal(first.top_a, 0.2);
  assert.deepEqual(Object.keys(t.calls.at(-1)!.body).sort(), ['messages', 'model', 'stream', 'temperature']);
  assert.match(seen[0]!, /^main:api:main→api:main:backup:.*502/);
  assert.deepEqual(calls, ['main:ok fellBack']);
  assert.equal(sys.usedToday('main'), 15);
});

test('both connections fail: error mentions both; aborted calls never fail over', async () => {
  const t = fakeTransport((req) => json({ error: { message: req.url.includes('a.example') ? 'first broke' : 'second broke' } }, 500));
  const sys = new AgentSystem({ config: setup([route('main', { api: api('a'), backup: api('b') })]) });
  await withFetch(t, () =>
    assert.rejects(sys.chat('main', { messages: [{ role: 'user', content: 'x' }] }), (e: unknown) => {
      if (!(e instanceof AiError) || !/first broke/.test(e.message) || !/备用 API 也失败了.*second broke/s.test(e.message)) return false;
      // 完整报错：两边的请求地址、状态码、服务端原文都在
      const report = errorReport(e);
      return /POST https:\/\/b\.example\/v1\/chat\/completions/.test(report) && /先失败的那个 API[\s\S]*POST https:\/\/a\.example\/v1\/chat\/completions/.test(report) && /"message": "second broke"/.test(report);
    }),
  );
  const ctrl = new AbortController();
  ctrl.abort();
  const before = t.calls.length;
  await withFetch(t, () => assert.rejects(sys.chat('main', { messages: [{ role: 'user', content: 'x' }] }, { signal: ctrl.signal }), (e: unknown) => e instanceof AiError && e.code === 'aborted'));
  assert.equal(t.calls.length, before);
});

test('daily token budget blocks background agents', async () => {
  const t = fakeTransport(() => json({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 60, completion_tokens: 50 } }));
  const sys = new AgentSystem({ config: setup([route('summary', { api: api('a'), dailyTokenBudget: 150 })]) });
  await withFetch(t, () => sys.chat('summary', { messages: [{ role: 'user', content: '总结一下' }] }));
  assert.equal(sys.usedToday('summary'), 110);
  await withFetch(t, () => assert.rejects(sys.chat('summary', { messages: [{ role: 'user', content: '再来'.repeat(30) }] }), (e: unknown) => e instanceof AiError && e.code === 'budget'));
});

test('json agent: prose answer gets one reminder, then JSON is parsed', async () => {
  let n = 0;
  const t = fakeTransport(() => json({ choices: [{ message: { content: n++ === 0 ? '好的，我来写一段番外！' : '```json\n{"title":"借充电器","story":"' + '室友又来借充电器了。'.repeat(3) + '","time":"傍晚","place":"宿舍","mood":"无奈","people":["室友"],"hook":"你充电器带了吗","cg":null}\n```' } }] }));
  const sys = new AgentSystem({ config: setup([route('sidestory', { api: api('a') })]) });
  const { value } = await withFetch(t, () => sys.json('sidestory', { messages: [{ role: 'user', content: '写' }] }, parseSidestory));
  assert.equal(value.title, '借充电器');
  assert.equal(value.cg, null);
  assert.equal(value.hook, '你充电器带了吗');
  assert.equal(t.calls.length, 2);
  assert.equal(t.calls[0]!.body.response_format.type, 'json_object');
  assert.match(t.calls[1]!.body.messages.at(-1).content, /只输出一个符合要求的 JSON/);
});

test('speak: cached by sentence; character model override; no cross-provider fallback', async () => {
  const mp3 = new Uint8Array([0x49, 0x44, 0x33, ...new Array(100).fill(1)]);
  const t = fakeTransport(() => bytesResponse(mp3, 'audio/mpeg'));
  const sf = api('sf', { channel: 'siliconflow', model: 'FunAudioLLM/CosyVoice2-0.5B' });
  const mm = api('mm', { channel: 'minimax', model: 'speech-02-hd' });
  const sys = new AgentSystem({ config: setup([route('tts', { api: sf, backup: mm })]), audioCache: new MemoryAudioCache() });
  const voice = { voiceId: 'claire' };
  const quoted = new AgentSystem({ config: setup([route('tts', { api: sf, ttsText: { quotedOnly: true, asterisks: 'drop', parentheses: 'drop', skipCodeBlocks: true, skipTags: true } })]) });
  await withFetch(t, () => quoted.speak({ text: '她小声说：“晚安。”然后关了灯。', voice }));
  assert.equal(t.calls.shift()!.body.input, '晚安。');
  const a = await withFetch(t, () => sys.speak({ text: '晚安', voice, expression: 'sleepy' }));
  const b = await withFetch(t, () => sys.speak({ text: '（打哈欠）晚安', voice, expression: 'sleepy' }));
  assert.equal(a.cached, false);
  assert.equal(b.cached, true);
  assert.equal(t.calls.length, 1);
  await withFetch(t, () => sys.speak({ text: '早', voice: { ...voice, model: 'tts-own' } }));
  assert.ok(t.calls.at(-1)!.url.startsWith('https://sf.example'));
  assert.equal(t.calls.at(-1)!.body.model, 'tts-own');
  // 自己的 API 坏了也不会把 CosyVoice 的音色发给 MiniMax
  const t2 = fakeTransport(() => json({ error: { message: 'down' } }, 503));
  const sys2 = new AgentSystem({ config: setup([route('tts', { api: { ...sf, model: 'x' }, backup: mm })]) });
  await withFetch(t2, () => assert.rejects(sys2.speak({ text: '嗯', voice })));
  assert.equal(t2.calls.length, 1);
});

test('embed: fallback only within the same model family; query vectors cached', async () => {
  const t = fakeTransport((req) => (req.url.includes('sf.example') ? json({ error: { message: 'busy' } }, 503) : json({ data: req.body.input.map((_: string, i: number) => ({ index: i, embedding: [1, 2, 2] })) })));
  const sameFamily = new AgentSystem({ config: setup([route('embedding', { api: api('sf', { model: 'BAAI/bge-m3' }), backup: api('other', { model: 'Pro/BAAI/bge-m3' }) })]) });
  const r = await withFetch(t, () => sameFamily.embed(['他不吃香菜'], { purpose: 'query' }));
  assert.equal(r.fellBack, true);
  assert.equal(r.space, 'bge-m3@3');
  const calls = t.calls.length;
  const again = await withFetch(t, () => sameFamily.embed(['他不吃香菜'], { purpose: 'query' }));
  assert.equal(again.cached, true);
  assert.equal(t.calls.length, calls);
  const otherFamily = new AgentSystem({ config: setup([route('embedding', { api: api('sf', { model: 'BAAI/bge-m3' }), backup: api('other', { model: 'text-embedding-3-small' }) })]) });
  await withFetch(t, () => assert.rejects(otherFamily.embed(['x']), /503/));
  await withFetch(t, () => assert.rejects(otherFamily.embed(['x'], { family: 'gemini-embedding-001' }), /不是同一个模型/));
});

test('illustrate: image prompt agent writes tags, appearance tags go first, NovelAI draws', async () => {
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
  const t = fakeTransport((req) =>
    req.url.includes('/chat/completions')
      ? json({ choices: [{ message: { content: '{"caption":"雨夜窗边","tags":"1girl, upper body, 回头, looking back, hugging pillow, bedroom, rainy window, warm lamp light, masterpiece","negative":"bad hands","size":"portrait"}' } }] })
      : bytesResponse(png, 'image/png'),
  );
  const nai = api('nai', { channel: 'novelai', baseUrl: 'https://image.novelai.net', model: 'nai-diffusion-4-5-full' });
  const style = { prefix: 'best quality', suffix: '', negative: 'lowres', naiQuality: false, sampler: 'k_euler', schedule: 'native' };
  const sys = new AgentSystem({ config: setup([route('imagePrompt', { api: api('ds', { model: 'deepseek-chat' }) }), route('image', { api: nai, imageStyle: style })]) });
  const stages: string[] = [];
  const input = { character: { name: '苏晚', appearanceTags: 'brown hair, long hair, brown eyes', negativeTags: 'extra fingers' }, caption: '雨夜的窗边，她抱着靠垫回头看' };
  const r = await withFetch(t, () => illustrate(sys, input, { seed: 7, onStage: (s) => stages.push(s) }));
  assert.deepEqual(stages, ['prompt', 'image']);
  assert.equal(r.prompt.caption, '雨夜窗边');
  assert.equal(r.request.prompt, 'brown hair, long hair, brown eyes, 1girl, upper body, looking back, hugging pillow, bedroom, rainy window, warm lamp light');
  assert.equal(r.request.negative, 'extra fingers, bad hands');
  const draw = t.calls.at(-1)!;
  assert.equal(draw.url, 'https://image.novelai.net/ai/generate-image');
  assert.equal(draw.body.parameters.seed, 7);
  // 生图风格：前缀在最前、负面词合并、采样器和调度器
  assert.ok(draw.body.input.startsWith('best quality, brown hair, long hair, brown eyes, 1girl'));
  assert.equal(draw.body.parameters.negative_prompt, 'lowres, extra fingers, bad hands');
  assert.equal(draw.body.parameters.sampler, 'k_euler');
  assert.equal(draw.body.parameters.noise_schedule, 'native');
  assert.equal(r.image.provider, 'novelai');
  // 没设置生图提示词：外观 tags + 原文
  const sys2 = new AgentSystem({ config: setup([route('image', { api: nai })]) });
  const r2 = await withFetch(t, () => illustrate(sys2, input));
  assert.equal(r2.promptBy, null);
  assert.equal(r2.request.prompt, 'brown hair, long hair, brown eyes, 雨夜的窗边, 她抱着靠垫回头看');
});

test('image prompt modes: background draws no people (SillyTavern modes); two people become V4 character prompts', () => {
  const bg = { mode: 'background' as const, character: { name: '苏晚', appearanceTags: 'brown hair' }, caption: '雨天的图书馆' };
  assert.match(buildImagePromptMessages(bg)[0]!.content as string, /no humans, scenery/);
  const bgReq = toImageRequest(parseImagePrompt({ caption: '图书馆', tags: 'library, rain, window', size: 'portrait' })!, bg);
  assert.equal(bgReq.prompt, 'no humans, scenery, library, rain, window');
  assert.equal(bgReq.size, 'landscape');
  const input = { character: { name: '苏晚', appearanceTags: 'brown hair' }, caption: '并排坐在江边', withUser: { name: '阿远', appearanceTags: 'black hair, glasses' } };
  const msgs = buildImagePromptMessages(input);
  assert.match(msgs[0]!.content as string, /"characters"/);
  const out = parseImagePrompt({ caption: '江边', tags: '1girl, 1boy, riverside, sunset', size: 'landscape', characters: [{ who: 'char', tags: 'smile, sitting', position: 'left' }, { who: 'user', tags: 'sitting', position: 'right' }] })!;
  const req = toImageRequest(out, input);
  assert.equal(req.prompt, '1girl, 1boy, riverside, sunset');
  assert.deepEqual(req.characters, [
    { prompt: 'brown hair, smile, sitting', center: { x: 0.3, y: 0.5 } },
    { prompt: 'black hair, glasses, sitting', center: { x: 0.7, y: 0.5 } },
  ]);
});

test('sidestory prompt carries her world and avoids repeats; summary output is clamped', () => {
  const msgs = buildSidestoryMessages({
    character: { name: '苏晚', pronoun: '她', description: '中文系研一学生，温柔、有点慢热。' },
    user: { name: '阿远' },
    now: new Date(2026, 10, 11, 15, 20),
    world: { name: '苏晚的小世界', schedule: ['12:30–17:30 图书馆 · 写论文'], studyTask: '宋词里的雨', people: [{ name: '林冉', relation: '室友' }] },
    current: { place: '图书馆', status: '写论文' },
    previous: ['借充电器'],
  });
  const user = msgs[1]!.content as string;
  assert.match(user, /2026-11-11 周三 15:20；苏晚在图书馆（写论文）/);
  assert.match(user, /林冉（室友）/);
  assert.match(user, /最近写过的番外】借充电器/);
  assert.equal(parseSidestory({ title: 't', story: '太短' }), null);
  const s = parseSummary(
    {
      summary: '他说周三下午两点有面试。',
      memories: [
        { type: 'followup', content: '周三下午两点面试，结束后问结果', importance: 14, dueAt: '2026-11-11T16:30:00+08:00', supersedes: ['mem3', 'made-up'] },
        { type: 'gossip', content: '不该出现' },
      ],
      relationship: { affectionDelta: 9, mood: '有点担心', nicknames: { user: '笨蛋' } },
    },
    new Set(['mem3']),
  )!;
  assert.equal(s.memories.length, 1);
  assert.equal(s.memories[0]!.importance, 10);
  assert.equal(s.memories[0]!.dueAt, Date.parse('2026-11-11T08:30:00Z'));
  assert.deepEqual(s.memories[0]!.supersedes, ['mem3']);
  assert.equal(s.relationship.affectionDelta, 3);
  assert.deepEqual(s.relationship.nicknames, { user: '笨蛋' });
});

test('memory ranking: pinned and due always included, similarity only within the same space', () => {
  const now = Date.UTC(2026, 10, 11);
  const DAY = 86_400_000;
  const vec = (xs: number[]) => ({ model: 'BAAI/bge-m3', dims: xs.length, data: encodeVector(l2normalize(xs)) });
  const mem = (id: string, over: Partial<Memory>): Memory => ({
    id,
    createdAt: now - 10 * DAY,
    updatedAt: now,
    characterId: 'suwan',
    type: 'fact',
    content: id,
    importance: 5,
    pinned: false,
    status: 'active',
    dueAt: null,
    sourceMessageIds: [],
    happenedAt: null,
    vector: null,
    lastRecalledAt: null,
    recallCount: 0,
    ...over,
  });
  const memories = [
    mem('coriander', { vector: vec([1, 0, 0]), importance: 6 }),
    mem('thesis', { vector: vec([0, 1, 0]), importance: 9 }),
    mem('pinned', { pinned: true, importance: 1, vector: vec([0, 0, 1]) }),
    mem('interview', { type: 'followup', dueAt: now - DAY, importance: 2 }),
    mem('old-model', { vector: { model: 'text-embedding-3-small', dims: 3, data: encodeVector([1, 0, 0]) } }),
    mem('archived', { status: 'archived', vector: vec([1, 0, 0]) }),
  ];
  const ranked = rankMemories({ memories, query: { vector: l2normalize([1, 0.1, 0]), model: '@cf/baai/bge-m3', dims: 3 }, now, topK: 2 });
  assert.deepEqual(ranked.map((r) => r.memory.id).sort(), ['coriander', 'interview', 'pinned', 'thesis']);
  // 相似度下限（SillyTavern 的 score_threshold）：不相关的不进 Top-K，必带的照样带
  const strict = rankMemories({ memories, query: { vector: l2normalize([1, 0.1, 0]), model: 'BAAI/bge-m3', dims: 3 }, now, topK: 5, minSimilarity: 0.25 });
  assert.ok(!strict.some((r) => r.memory.id === 'thesis'));
  assert.ok(strict.some((r) => r.memory.id === 'pinned'));
  assert.equal(ranked.find((r) => r.memory.id === 'interview')!.reason, 'due');
  assert.ok(ranked.find((r) => r.memory.id === 'coriander')!.similarity! > 0.99);
  const scores = Object.fromEntries(ranked.map((r) => [r.memory.id, r.score]));
  assert.ok(scores.coriander! > scores.thesis!);
  assert.deepEqual(staleMemories(memories, { model: 'BAAI/bge-m3', dims: 3 }).map((m) => m.id), ['interview', 'old-model']);
});
