import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anthropicBase, geminiBase, openaiBase } from '../src/core/endpoint.ts';
import { AiError } from '../src/core/errors.ts';
import { claudeModelInfo } from '../src/llm/claude.ts';
import { chatOnce } from '../src/llm/client.ts';
import { fromOpenAIBody, postProcessMessages, toClaude, toGemini } from '../src/llm/messages.ts';
import { outputTokenCaps } from '../src/llm/retry.ts';
import { readAIStream } from '../src/llm/stream.ts';
import type { ChatMessage, StreamState } from '../src/llm/types.ts';
import { chunked, endpoint, fakeTransport, json, sse } from './helpers.ts';

const USER = [{ role: 'user' as const, content: '你好' }];
const OK = () => json({ choices: [{ message: { content: 'ok' } }] });

test('OpenAI SSE: reasoning, text, states and usage', async () => {
  const t = fakeTransport(() =>
    sse([
      { choices: [{ delta: { reasoning_content: '先想想' } }] },
      { choices: [{ delta: { reasoning_content: '……好' } }] },
      { choices: [{ delta: { content: '[expr:smile]今天' } }] },
      { choices: [{ delta: { content: '也想你。' }, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 7 } },
    ]),
  );
  const states: StreamState[] = [];
  const r = await chatOnce(endpoint('openai', t), { messages: USER, temperature: 0.9, maxTokens: 300 }, { onDelta: () => undefined, onState: (s) => states.push(s) });
  assert.equal(r.text, '[expr:smile]今天也想你。');
  assert.equal(r.thinking, '先想想……好');
  assert.deepEqual(r.usage, { inputTokens: 12, outputTokens: 7 });
  assert.deepEqual(states, ['sent', 'connected', 'thinking', 'streaming']);
  const call = t.calls[0]!;
  assert.equal(call.url, 'https://api.example.com/v1/chat/completions');
  assert.equal(call.headers.authorization, 'Bearer sk-test');
  assert.equal(call.body.max_tokens, 300);
});

test('Claude SSE: thinking blocks separated, usage merged; Sonnet 5 asks for a summary instead of temperature', async () => {
  const t = fakeTransport(() =>
    sse(
      [
        { type: 'message_start', message: { usage: { input_tokens: 30 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '第一段' } },
        { type: 'content_block_start', index: 1, content_block: { type: 'thinking' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: '第二段' } },
        { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: '晚安，笨蛋。' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } },
      ],
      { done: false },
    ),
  );
  const r = await chatOnce(endpoint('anthropic', t, { baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5-5' }), { messages: USER, temperature: 0.8 }, { onDelta: () => undefined });
  assert.equal(r.text, '晚安，笨蛋。');
  assert.equal(r.thinking, '第一段\n\n第二段');
  assert.deepEqual(r.usage, { inputTokens: 30, outputTokens: 9 });
  const call = t.calls[0]!;
  assert.equal(call.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(call.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(call.body.temperature, undefined);
  assert.deepEqual(call.body.thinking, { type: 'adaptive', display: 'summarized' });
});

test('Gemini SSE: thought parts, key in URL, safety off like SillyTavern', async () => {
  const t = fakeTransport(() =>
    sse(
      [
        { candidates: [{ content: { parts: [{ text: '嗯……', thought: true }] } }] },
        { candidates: [{ content: { parts: [{ text: '下雨了，带伞。' }] }, finishReason: 'STOP' }] },
      ],
      { done: false },
    ),
  );
  const ep = endpoint('gemini', t, { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/', model: 'models/gemini-2.5-flash', key: 'g-key' });
  const r = await chatOnce(ep, { messages: [{ role: 'system', content: '你是苏晚' }, ...USER] }, { onDelta: () => undefined });
  assert.equal(r.text, '下雨了，带伞。');
  assert.equal(r.thinking, '嗯……');
  const call = t.calls[0]!;
  assert.equal(call.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=g-key');
  assert.deepEqual(call.body.systemInstruction, { parts: [{ text: '你是苏晚' }] });
  assert.deepEqual(call.body.generationConfig.thinkingConfig, { includeThoughts: true });
  assert.equal(call.body.safetySettings.length, 5);
  assert.ok(call.body.safetySettings.every((s: { threshold: string }) => s.threshold === 'OFF'));
});

test('stream formats: JSON array, newline-delimited JSON, relays that send message chunks', async () => {
  const arr = JSON.stringify([{ candidates: [{ content: { parts: [{ text: '一' }] } }] }, { candidates: [{ content: { parts: [{ text: '二"}]' }] } }] }]);
  assert.equal((await readAIStream(chunked(arr, 5))).text, '一二"}]');
  const ndjson = [{ choices: [{ delta: { content: 'a' } }] }, { choices: [{ delta: { content: 'b' } }] }].map((x) => JSON.stringify(x)).join('\n');
  assert.equal((await readAIStream(chunked(ndjson, 4))).text, 'ab');
  const messages = sse([{ choices: [{ message: { content: '整段' } }] }, { choices: [{ text: '补全' }] }]);
  assert.equal((await readAIStream(messages)).text, '整段补全');
});

test('server ignores stream: single JSON is unstreamed, final text still delivered via onDelta', async () => {
  const t = fakeTransport(() => json({ choices: [{ message: { content: '<think>想一下</think>\n好呀' }, finish_reason: 'stop' }] }));
  const states: StreamState[] = [];
  let last = '';
  const r = await chatOnce(endpoint('openai', t), { messages: USER }, { onDelta: (text) => (last = text), onState: (s) => states.push(s) });
  assert.equal(r.text, '好呀');
  assert.equal(r.thinking, '想一下');
  assert.equal(last, '好呀');
  assert.ok(states.includes('unstreamed'));
});

test('<think> tag streamed in pieces is split from the reply', async () => {
  const t = fakeTransport(() => sse(['<thi', 'nk>先', '想</th', 'ink>', '\n\n正文'].map((c) => ({ choices: [{ delta: { content: c } }] }))));
  const seen: string[] = [];
  const r = await chatOnce(endpoint('openai', t), { messages: USER }, { onDelta: (text) => seen.push(text) });
  assert.equal(r.text, '正文');
  assert.equal(r.thinking, '先想');
  assert.ok(seen.every((s) => !s.includes('<')));
});

test('stream failure before text retries without streaming; 401 does not retry', async () => {
  const t = fakeTransport((req) => (req.body.stream ? json({ error: { message: 'stream not supported' } }, 400) : json({ choices: [{ message: { content: '普通请求的回复' } }] })));
  const states: [StreamState, string | undefined][] = [];
  const r = await chatOnce(endpoint('openai', t), { messages: USER }, { onDelta: () => undefined, onState: (s, d) => states.push([s, d]) });
  assert.equal(r.text, '普通请求的回复');
  assert.equal(t.calls[1]!.body.stream, false);
  assert.ok(/stream not supported/.test(states.find(([s]) => s === 'fallback')?.[1] ?? ''));
  const t2 = fakeTransport(() => json({ error: { message: 'invalid api key' } }, 401));
  await assert.rejects(chatOnce(endpoint('openai', t2), { messages: USER }, { onDelta: () => undefined }), (e: unknown) => e instanceof AiError && e.status === 401 && /Key 不对/.test(e.message));
  assert.equal(t2.calls.length, 1);
});

test('error event after text has arrived: no retry, error surfaces', async () => {
  const t = fakeTransport(() =>
    sse([{ type: 'content_block_delta', delta: { type: 'text_delta', text: '说到一半' } }, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }], { done: false }),
  );
  await assert.rejects(chatOnce(endpoint('anthropic', t, { model: 'claude-opus-4-1' }), { messages: USER }, { onDelta: () => undefined }), /Overloaded/);
  assert.equal(t.calls.length, 1);
});

test('output token limit read from the error, retried and remembered; rejected parameters dropped', async () => {
  outputTokenCaps.clear();
  const t = fakeTransport((req) => (req.body.max_tokens > 8192 ? json({ error: { message: 'Invalid max_tokens value, the valid range of max_tokens is [1, 8192]' } }, 400) : OK()));
  const ep = endpoint('openai', t, { model: 'deepseek-chat' });
  await chatOnce(ep, { messages: USER, maxTokens: 32800 });
  await chatOnce(ep, { messages: USER, maxTokens: 32800 });
  assert.deepEqual(t.calls.map((c) => c.body.max_tokens), [32800, 8192, 8192]);
  const t2 = fakeTransport((req) => {
    if (req.body.top_k !== undefined) return json({ error: { message: 'Unrecognized request argument supplied: top_k' } }, 400);
    if (req.body.max_tokens !== undefined) return json({ error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } }, 400);
    if (req.body.temperature !== undefined) return json({ error: { message: "Unsupported value: 'temperature' does not support 0.9 with this model." } }, 400);
    return OK();
  });
  await chatOnce(endpoint('openai', t2), { messages: USER, temperature: 0.9, topK: 40, maxTokens: 500 });
  const final = t2.calls.at(-1)!.body;
  assert.equal(final.top_k, undefined);
  assert.equal(final.max_completion_tokens, 500);
  assert.equal(final.temperature, undefined);
});

test('abort while streaming: aborted error, no fallback request', async () => {
  const ctrl = new AbortController();
  const t = fakeTransport(() => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"半"}}]}\n\n'));
        ctrl.signal.addEventListener('abort', () => c.error(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      },
    });
    return new Response(stream);
  });
  await assert.rejects(chatOnce(endpoint('openai', t), { messages: USER }, { signal: ctrl.signal, onDelta: () => ctrl.abort() }), (e: unknown) => e instanceof AiError && e.code === 'aborted');
  assert.equal(t.calls.length, 1);
});

test('reasoning effort per provider (SillyTavern mapping) and relay thinking aliases (SleepTogether)', async () => {
  const t = fakeTransport(() => OK());
  // OpenAI 兼容：min → minimal
  await chatOnce(endpoint('openai', t), { messages: USER, reasoningEffort: 'min' });
  assert.equal(t.calls.at(-1)!.body.reasoning_effort, 'minimal');
  // 中转的思考别名：temperature 只能 1，去掉 top_p，输出上限大过预算
  await chatOnce(endpoint('openai', t, { model: 'claude-sonnet-4-5-thinking-high' }), { messages: USER, temperature: 0.7, topP: 0.9, maxTokens: 2000 });
  let b = t.calls.at(-1)!.body;
  assert.equal(b.temperature, 1);
  assert.equal(b.top_p, undefined);
  assert.equal(b.max_tokens, 28096);
  // Claude 传统思考：预算按比例，不带采样参数，预填改成 user
  const ct = fakeTransport(() => json({ content: [{ type: 'text', text: 'ok' }] }));
  await chatOnce(endpoint('anthropic', ct, { model: 'claude-sonnet-4-5' }), { messages: USER, reasoningEffort: 'medium', maxTokens: 8000, temperature: 0.7, topK: 40, prefill: '好的，' });
  b = ct.calls.at(-1)!.body;
  assert.deepEqual(b.thinking, { type: 'enabled', budget_tokens: 2000 });
  assert.equal(b.temperature, undefined);
  assert.equal(b.top_k, undefined);
  assert.equal(b.messages.at(-1).role, 'user');
  // Claude 自适应思考：effort 写进 output_config
  await chatOnce(endpoint('anthropic', ct, { model: 'claude-opus-4-7' }), { messages: USER, reasoningEffort: 'high' });
  b = ct.calls.at(-1)!.body;
  assert.deepEqual(b.thinking, { type: 'adaptive' });
  assert.deepEqual(b.output_config, { effort: 'high' });
  // temperature 和 top_p 只能二选一的型号
  await chatOnce(endpoint('anthropic', ct, { model: 'claude-haiku-4-5' }), { messages: USER, temperature: 0.8, topP: 0.9 });
  b = ct.calls.at(-1)!.body;
  assert.equal(b.temperature, undefined);
  assert.equal(b.top_p, 0.9);
  // Gemini：2.5 用预算，3 Pro 用等级
  const gt = fakeTransport(() => json({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }));
  await chatOnce(endpoint('gemini', gt, { model: 'gemini-2.5-flash' }), { messages: USER, reasoningEffort: 'low', maxTokens: 4000 });
  assert.deepEqual(gt.calls.at(-1)!.body.generationConfig.thinkingConfig, { thinkingBudget: 400 });
  await chatOnce(endpoint('gemini', gt, { model: 'gemini-3-pro-preview' }), { messages: USER, reasoningEffort: 'medium' });
  assert.deepEqual(gt.calls.at(-1)!.body.generationConfig.thinkingConfig, { thinkingLevel: 'low' });
});

test('connection options: prompt post-processing, include / exclude body (SillyTavern custom source)', async () => {
  const t = fakeTransport(() => OK());
  const ep = endpoint('openai', t, { promptProcessing: 'strict', includeBody: { top_a: 0.1 }, excludeBody: ['max_tokens'] });
  await chatOnce(ep, { messages: [{ role: 'system', content: 'S' }, { role: 'assistant', content: '开场白' }, { role: 'system', content: '环境' }, { role: 'user', content: '在吗' }], maxTokens: 500 });
  const b = t.calls[0]!.body;
  assert.equal(b.top_a, 0.1);
  assert.equal(b.max_tokens, undefined);
  assert.deepEqual(b.messages, [
    { role: 'system', content: 'S' },
    { role: 'user', content: "Let's get started." },
    { role: 'assistant', content: '开场白' },
    { role: 'user', content: '环境\n\n在吗' },
  ]);
  // 备用连接的最简请求：只有模型、消息、temperature、输出上限
  await chatOnce(endpoint('openai', t), { messages: USER, temperature: 0.5, topP: 0.9, seed: 1, extraBody: { foo: 1 }, minimal: true, maxTokens: 100 });
  assert.deepEqual(Object.keys(t.calls.at(-1)!.body).sort(), ['max_tokens', 'messages', 'model', 'stream', 'temperature']);
});

test('message conversion: post-processing modes, Claude prefill and placeholder, Gemini roles', () => {
  const msgs: ChatMessage[] = [
    { role: 'system', content: '主提示' },
    { role: 'system', content: '我好想你', name: 'example_assistant' },
    { role: 'assistant', content: '开场白' },
    { role: 'user', content: '在吗', name: '阿远' },
  ];
  const names = { user: '阿远', char: '苏晚' };
  assert.deepEqual(postProcessMessages(msgs, 'merge', names), [
    { role: 'system', content: '主提示\n\n苏晚: 我好想你' },
    { role: 'assistant', content: '开场白' },
    { role: 'user', content: '阿远: 在吗' },
  ]);
  // single：名字已经在正文里就不再加（同 SillyTavern 的 startsWith 检查）
  assert.deepEqual(postProcessMessages(msgs, 'single', names), [{ role: 'user', content: '主提示\n\n苏晚: 我好想你\n\n苏晚: 开场白\n\n阿远: 在吗' }]);
  assert.equal(postProcessMessages(msgs, 'none', names), msgs);
  const c = toClaude(msgs, names, { prefill: '（小声）  ' });
  assert.equal(c.system, '主提示\n\n苏晚: 我好想你');
  assert.deepEqual(c.messages, [
    { role: 'user', content: "Let's get started." },
    { role: 'assistant', content: '开场白' },
    { role: 'user', content: '阿远: 在吗' },
    { role: 'assistant', content: '（小声）' },
  ]);
  assert.equal(toClaude(msgs, names, { prefill: '好的', noPrefill: true }).messages.at(-1)?.role, 'user');
  const g = toGemini([{ role: 'system', content: 'S' }, { role: 'user', content: 'u' }, { role: 'assistant', content: 'a' }]);
  assert.deepEqual(g.contents, [
    { role: 'user', parts: [{ text: 'u' }] },
    { role: 'model', parts: [{ text: 'a' }] },
  ]);
});

test('preset request body → unified request, including SillyTavern preset settings', () => {
  const r = fromOpenAIBody({
    model: 'x',
    messages: [{ role: 'system', content: 's', name: 'example_user' }],
    temperature: 1.1,
    max_tokens: 400,
    stop: '\n用户:',
    repetition_penalty: 1.05,
    reasoning_effort: 'high',
    include_reasoning: true,
    assistant_prefill: '好的',
    custom_prompt_post_processing: 'semi_tools',
  });
  assert.equal(r.temperature, 1.1);
  assert.equal(r.maxTokens, 400);
  assert.deepEqual(r.stop, ['\n用户:']);
  assert.deepEqual(r.extraBody, { repetition_penalty: 1.05 });
  assert.equal(r.reasoningEffort, 'high');
  assert.equal(r.includeReasoning, true);
  assert.equal(r.prefill, '好的');
  assert.equal(r.processing, 'semi');
});

test('Claude model table (SillyTavern rules; a date suffix is not a version)', () => {
  const pick = (m: string) => {
    const i = claudeModelInfo(m);
    return i && { thinking: i.thinking, adaptive: i.adaptive, noSampling: i.noSampling, limited: i.limitedSampling, noPrefill: i.noPrefill };
  };
  assert.deepEqual(pick('claude-3-5-sonnet-20241022'), { thinking: false, adaptive: false, noSampling: false, limited: false, noPrefill: false });
  assert.deepEqual(pick('claude-3-7-sonnet-20250219'), { thinking: true, adaptive: false, noSampling: false, limited: false, noPrefill: false });
  assert.deepEqual(pick('claude-opus-4-1-20250805'), { thinking: true, adaptive: false, noSampling: false, limited: true, noPrefill: false });
  assert.deepEqual(pick('claude-sonnet-4-6'), { thinking: true, adaptive: false, noSampling: false, limited: true, noPrefill: true });
  assert.deepEqual(pick('claude-opus-4-7'), { thinking: true, adaptive: true, noSampling: true, limited: false, noPrefill: true });
  assert.deepEqual(pick('anthropic/claude-sonnet-5.5'), { thinking: true, adaptive: true, noSampling: true, limited: false, noPrefill: true });
  assert.equal(claudeModelInfo('claude-fable')?.thinksByDefault, true);
  assert.equal(claudeModelInfo('gpt-4o'), null);
});

test('base URL normalization tolerates pasted endpoints', () => {
  assert.equal(openaiBase('https://api.deepseek.com/v1/chat/completions'), 'https://api.deepseek.com/v1');
  assert.equal(openaiBase('https://relay.example.com'), 'https://relay.example.com/v1');
  assert.equal(openaiBase('https://open.bigmodel.cn/api/paas/v4'), 'https://open.bigmodel.cn/api/paas/v4');
  assert.equal(anthropicBase('https://api.anthropic.com/v1/messages'), 'https://api.anthropic.com/v1');
  assert.equal(geminiBase('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=abc'), 'https://generativelanguage.googleapis.com/v1beta');
});
