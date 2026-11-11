import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anthropicBase, geminiBase, openaiBase } from '../src/core/endpoint.ts';
import { AiError } from '../src/core/errors.ts';
import { claudeModelInfo } from '../src/llm/claude.ts';
import { chatOnce } from '../src/llm/client.ts';
import { fromOpenAIBody, toClaude, toGemini } from '../src/llm/messages.ts';
import { outputTokenCaps, outputTokenLimitFromError } from '../src/llm/retry.ts';
import { readAIStream } from '../src/llm/stream.ts';
import type { StreamState } from '../src/llm/types.ts';
import { chunked, endpoint, fakeTransport, json, sse } from './helpers.ts';

const USER = [{ role: 'user' as const, content: '你好' }];

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
  const deltas: [string, string][] = [];
  const r = await chatOnce(endpoint('openai', t), { messages: USER, temperature: 0.9, maxTokens: 300 }, {
    onDelta: (text, thinking) => deltas.push([text, thinking]),
    onState: (s) => states.push(s),
  });
  assert.equal(r.text, '[expr:smile]今天也想你。');
  assert.equal(r.thinking, '先想想……好');
  assert.deepEqual(r.usage, { inputTokens: 12, outputTokens: 7 });
  assert.equal(r.finishReason, 'stop');
  assert.deepEqual(states, ['sent', 'connected', 'thinking', 'streaming']);
  assert.deepEqual(deltas.at(-1), ['[expr:smile]今天也想你。', '先想想……好']);
  const call = t.calls[0]!;
  assert.equal(call.url, 'https://api.example.com/v1/chat/completions');
  assert.equal(call.headers.authorization, 'Bearer sk-test');
  assert.equal(call.body.stream, true);
  assert.equal(call.body.max_tokens, 300);
  assert.equal(call.body.temperature, 0.9);
});

test('Claude SSE: thinking blocks are separated, usage merged from two events', async () => {
  const t = fakeTransport(() =>
    sse(
      [
        { type: 'message_start', message: { usage: { input_tokens: 30 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '第一段' } },
        { type: 'content_block_start', index: 1, content_block: { type: 'thinking' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: '第二段' } },
        { type: 'content_block_start', index: 2, content_block: { type: 'text' } },
        { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: '晚安，' } },
        { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: '笨蛋。' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } },
        { type: 'message_stop' },
      ],
      { done: false },
    ),
  );
  const r = await chatOnce(endpoint('anthropic', t, { baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5-5' }), { messages: USER }, { onDelta: () => undefined });
  assert.equal(r.text, '晚安，笨蛋。');
  assert.equal(r.thinking, '第一段\n\n第二段');
  assert.deepEqual(r.usage, { inputTokens: 30, outputTokens: 9 });
  assert.equal(r.finishReason, 'end_turn');
  const call = t.calls[0]!;
  assert.equal(call.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(call.headers['x-api-key'], 'sk-test');
  assert.equal(call.headers['anthropic-dangerous-direct-browser-access'], 'true');
  // Sonnet 5 不接受 temperature、默认会思考：流式时要思考摘要
  assert.equal(call.body.temperature, undefined);
  assert.deepEqual(call.body.thinking, { type: 'adaptive', display: 'summarized' });
  assert.equal(call.body.max_tokens, 4096);
});

test('Gemini SSE: thought parts go to thinking; key in URL; system instruction', async () => {
  const t = fakeTransport(() =>
    sse(
      [
        { candidates: [{ content: { parts: [{ text: '嗯……', thought: true }] } }] },
        { candidates: [{ content: { parts: [{ text: '下雨了，' }] } }] },
        { candidates: [{ content: { parts: [{ text: '带伞。' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 4 } },
      ],
      { done: false },
    ),
  );
  const ep = endpoint('gemini', t, { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/', model: 'models/gemini-2.5-flash', key: 'g-key' });
  const r = await chatOnce(ep, { messages: [{ role: 'system', content: '你是苏晚' }, ...USER], temperature: 1 }, { onDelta: () => undefined });
  assert.equal(r.text, '下雨了，带伞。');
  assert.equal(r.thinking, '嗯……');
  assert.deepEqual(r.usage, { inputTokens: 5, outputTokens: 4 });
  const call = t.calls[0]!;
  assert.equal(call.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=g-key');
  assert.deepEqual(call.body.systemInstruction, { parts: [{ text: '你是苏晚' }] });
  assert.deepEqual(call.body.contents, [{ role: 'user', parts: [{ text: '你好' }] }]);
  assert.deepEqual(call.body.generationConfig.thinkingConfig, { includeThoughts: true });
});

test('JSON array stream (Gemini without alt=sse) and newline-delimited JSON', async () => {
  const arr = JSON.stringify([
    { candidates: [{ content: { parts: [{ text: '一' }] } }] },
    { candidates: [{ content: { parts: [{ text: '二"}]' }] } }] },
  ]);
  const r1 = await readAIStream(chunked(arr, 5));
  assert.equal(r1.text, '一二"}]');
  const ndjson = [{ choices: [{ delta: { content: 'a' } }] }, { choices: [{ delta: { content: 'b' } }] }].map((x) => JSON.stringify(x)).join('\n');
  const r2 = await readAIStream(chunked(ndjson, 4));
  assert.equal(r2.text, 'ab');
  assert.equal(r2.streamed, true);
});

test('server ignores stream: single JSON → unstreamed, final text still delivered via onDelta', async () => {
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
  const t = fakeTransport(() =>
    sse(['<thi', 'nk>先', '想</th', 'ink>', '\n\n正文'].map((c) => ({ choices: [{ delta: { content: c } }] }))),
  );
  const seen: string[] = [];
  const r = await chatOnce(endpoint('openai', t), { messages: USER }, { onDelta: (text) => seen.push(text) });
  assert.equal(r.text, '正文');
  assert.equal(r.thinking, '先想');
  // 标签没收完整之前不把半截标签当正文显示
  assert.ok(seen.every((s) => !s.includes('<')));
});

test('stream fails before any text → same endpoint retried without streaming', async () => {
  const t = fakeTransport((req) =>
    req.body.stream ? json({ error: { message: 'stream not supported' } }, 400) : json({ choices: [{ message: { content: '普通请求的回复' } }] }),
  );
  const states: [StreamState, string | undefined][] = [];
  const r = await chatOnce(endpoint('openai', t), { messages: USER }, { onDelta: () => undefined, onState: (s, d) => states.push([s, d]) });
  assert.equal(r.text, '普通请求的回复');
  assert.equal(t.calls.length, 2);
  assert.equal(t.calls[1]!.body.stream, false);
  const fb = states.find(([s]) => s === 'fallback');
  assert.ok(fb && /stream not supported/.test(fb[1] ?? ''));
});

test('error event in the middle of the stream after text: no retry, error surfaces', async () => {
  const t = fakeTransport(() =>
    sse([{ type: 'content_block_delta', delta: { type: 'text_delta', text: '说到一半' } }, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }], {
      done: false,
    }),
  );
  await assert.rejects(
    chatOnce(endpoint('anthropic', t, { model: 'claude-opus-4-1' }), { messages: USER }, { onDelta: () => undefined }),
    (e: unknown) => e instanceof AiError && /Overloaded/.test(e.message),
  );
  assert.equal(t.calls.length, 1);
});

test('401 is hopeless: no non-stream retry', async () => {
  const t = fakeTransport(() => json({ error: { message: 'invalid api key' } }, 401));
  await assert.rejects(
    chatOnce(endpoint('openai', t), { messages: USER }, { onDelta: () => undefined }),
    (e: unknown) => e instanceof AiError && e.status === 401 && /Key 不对/.test(e.message) && /invalid api key/.test(e.message),
  );
  assert.equal(t.calls.length, 1);
});

test('output token limit read from the error, retried and remembered per model', async () => {
  outputTokenCaps.clear();
  const t = fakeTransport((req) =>
    req.body.max_tokens > 8192
      ? json({ error: { message: 'Invalid max_tokens value, the valid range of max_tokens is [1, 8192]' } }, 400)
      : json({ choices: [{ message: { content: 'ok' } }] }),
  );
  const ep = endpoint('openai', t, { model: 'deepseek-chat' });
  await chatOnce(ep, { messages: USER, maxTokens: 32800 });
  assert.deepEqual(t.calls.map((c) => c.body.max_tokens), [32800, 8192]);
  await chatOnce(ep, { messages: USER, maxTokens: 32800 });
  assert.equal(t.calls.at(-1)!.body.max_tokens, 8192);
  assert.equal(t.calls.length, 3);
  assert.deepEqual(outputTokenLimitFromError(400, 'This model\'s maximum context length is 65536 tokens. However, you requested 70000 tokens (8000 in the messages, 62000 in the completion).', 62000), { tokens: 57536, perModel: false });
});

test('rejected optional parameters are dropped one by one', async () => {
  const t = fakeTransport((req) => {
    if (req.body.top_k !== undefined) return json({ error: { message: 'Unrecognized request argument supplied: top_k' } }, 400);
    if (req.body.max_tokens !== undefined) return json({ error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } }, 400);
    if (req.body.temperature !== undefined) return json({ error: { message: "Unsupported value: 'temperature' does not support 0.9 with this model." } }, 400);
    return json({ choices: [{ message: { content: 'done' } }] });
  });
  const r = await chatOnce(endpoint('openai', t), { messages: USER, temperature: 0.9, topK: 40, maxTokens: 500 });
  assert.equal(r.text, 'done');
  const final = t.calls.at(-1)!.body;
  assert.equal(final.top_k, undefined);
  assert.equal(final.max_tokens, undefined);
  assert.equal(final.max_completion_tokens, 500);
  assert.equal(final.temperature, undefined);
});

test('empty reply is an error carrying the finish reason', async () => {
  const t = fakeTransport(() => json({ candidates: [], promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }));
  await assert.rejects(
    chatOnce(endpoint('gemini', t), { messages: USER }),
    (e: unknown) => e instanceof AiError && e.code === 'empty' && /PROHIBITED_CONTENT/.test(e.message),
  );
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
  const p = chatOnce(endpoint('openai', t), { messages: USER }, { signal: ctrl.signal, onDelta: () => ctrl.abort() });
  await assert.rejects(p, (e: unknown) => e instanceof AiError && e.code === 'aborted');
  assert.equal(t.calls.length, 1);
});

test('Claude conversion: system run, mid system → user, names, merged turns, placeholder', () => {
  const r = toClaude(
    [
      { role: 'system', content: '主提示' },
      { role: 'system', content: '我好想你', name: 'example_assistant' },
      { role: 'assistant', content: '开场白' },
      { role: 'system', content: '【当前环境】小雨' },
      { role: 'user', content: '在吗' },
      { role: 'user', content: '' },
    ],
    { user: '阿远', char: '苏晚' },
  );
  assert.equal(r.system, '主提示\n\n苏晚: 我好想你');
  assert.deepEqual(r.messages, [
    { role: 'user', content: '[Start a new chat]' },
    { role: 'assistant', content: '开场白' },
    { role: 'user', content: '【当前环境】小雨\n\n在吗' },
  ]);
  const g = toGemini([{ role: 'system', content: 'S' }, { role: 'user', content: 'u' }, { role: 'assistant', content: 'a' }]);
  assert.deepEqual(g.contents, [
    { role: 'user', parts: [{ text: 'u' }] },
    { role: 'model', parts: [{ text: 'a' }] },
  ]);
});

test('preset request body → unified request', () => {
  const r = fromOpenAIBody({
    model: 'x',
    messages: [{ role: 'system', content: 's', name: 'example_user' }],
    temperature: 1.1,
    top_p: 0.9,
    max_tokens: 400,
    stop: '\n用户:',
    stream: true,
    repetition_penalty: 1.05,
  });
  assert.equal(r.temperature, 1.1);
  assert.equal(r.topP, 0.9);
  assert.equal(r.maxTokens, 400);
  assert.deepEqual(r.stop, ['\n用户:']);
  assert.deepEqual(r.extraBody, { repetition_penalty: 1.05 });
  assert.equal(r.messages[0]!.name, 'example_user');
});

test('Claude model recognition (date suffix is not a version)', () => {
  assert.equal(claudeModelInfo('claude-3-5-sonnet-20241022'), null);
  assert.equal(claudeModelInfo('claude-3-7-sonnet-20250219'), null);
  assert.deepEqual(claudeModelInfo('claude-opus-4-1-20250805'), { noSampling: false, thinksByDefault: false });
  assert.deepEqual(claudeModelInfo('claude-opus-4-7'), { noSampling: true, thinksByDefault: false });
  assert.deepEqual(claudeModelInfo('anthropic/claude-sonnet-5.5'), { noSampling: true, thinksByDefault: true });
  assert.deepEqual(claudeModelInfo('claude-haiku-4-5-20251001'), { noSampling: false, thinksByDefault: false });
});

test('base URL normalization tolerates pasted endpoints', () => {
  assert.equal(openaiBase('https://api.deepseek.com/v1/chat/completions'), 'https://api.deepseek.com/v1');
  assert.equal(openaiBase('https://api.siliconflow.cn/v1/'), 'https://api.siliconflow.cn/v1');
  assert.equal(openaiBase('https://relay.example.com'), 'https://relay.example.com/v1');
  assert.equal(openaiBase('https://open.bigmodel.cn/api/paas/v4'), 'https://open.bigmodel.cn/api/paas/v4');
  assert.equal(anthropicBase('https://api.anthropic.com/v1/messages'), 'https://api.anthropic.com/v1');
  assert.equal(geminiBase('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=abc'), 'https://generativelanguage.googleapis.com/v1beta');
  assert.equal(geminiBase('https://generativelanguage.googleapis.com'), 'https://generativelanguage.googleapis.com/v1beta');
});
