import assert from 'node:assert/strict';
import { test } from 'node:test';
import { base64Decode, base64Encode, utf8Decode, utf8Encode } from '@app/shared';
import { anthropicBase, deepseekBase, geminiBase, openaiBase, vertexBase } from '../src/core/endpoint.ts';
import { AiError } from '../src/core/errors.ts';
import { claudeModelInfo } from '../src/llm/claude.ts';
import { chatOnce } from '../src/llm/client.ts';
import { fromOpenAIBody, postProcessMessages, toClaude, toGemini } from '../src/llm/messages.ts';
import { claudeThinking, deepseekThinking, geminiHasThinkingConfig, geminiThinking, openaiReasoningEffort } from '../src/llm/reasoning.ts';
import { outputTokenCaps } from '../src/llm/retry.ts';
import { readAIStream } from '../src/llm/stream.ts';
import type { ChatMessage, StreamState } from '../src/llm/types.ts';
import { clearVertexTokens } from '../src/llm/vertex.ts';
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

test('Gemini SSE: thought parts, key in URL', async () => {
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
  assert.equal(t.calls.at(-1)!.body.stream, false);
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
  assert.equal(deepseekBase('https://api.deepseek.com/v1/chat/completions'), 'https://api.deepseek.com/v1');
  assert.equal(deepseekBase(''), 'https://api.deepseek.com');
  assert.equal(vertexBase('https://aiplatform.googleapis.com'), 'https://aiplatform.googleapis.com/v1/publishers/google');
  assert.equal(vertexBase('https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-3.7-flash:streamGenerateContent?alt=sse&key=k'), 'https://aiplatform.googleapis.com/v1/publishers/google');
});

/** 流式请求回 SSE，普通请求回 JSON */
function deepseekServer() {
  return fakeTransport((req) =>
    req.body?.stream
      ? sse([{ choices: [{ delta: { reasoning_content: '嗯' } }] }, { choices: [{ delta: { content: '在的' }, finish_reason: 'stop' }] }])
      : json({ choices: [{ message: { content: '在的', reasoning_content: '嗯' } }] }),
  );
}

test('DeepSeek (official docs): thinking switch and effort, room for thinking, prefix completion on /beta', async () => {
  const t = deepseekServer();
  const ep = endpoint('deepseek', t, { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' });
  const r = await chatOnce(ep, { messages: USER, maxTokens: 800, reasoningEffort: 'medium', temperature: 0.8 }, { onDelta: () => undefined });
  assert.equal(r.text, '在的');
  assert.equal(r.thinking, '嗯');
  let call = t.calls[0]!;
  assert.equal(call.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(call.headers.authorization, 'Bearer sk-test');
  assert.deepEqual(call.body.thinking, { type: 'enabled' });
  assert.equal(call.body.reasoning_effort, 'high');
  // 思考模式下回复上限也算思考：留出空间
  assert.equal(call.body.max_tokens, 16384);

  await chatOnce(ep, { messages: USER, maxTokens: 800, reasoningEffort: 'none' }, { stream: false });
  call = t.calls[1]!;
  assert.deepEqual(call.body.thinking, { type: 'disabled' });
  assert.equal('reasoning_effort' in call.body, false);
  assert.equal(call.body.max_tokens, 800);

  await chatOnce(ep, { messages: USER, maxTokens: 800, reasoningEffort: 'max' }, { stream: false });
  assert.equal(t.calls[2]!.body.reasoning_effort, 'max');
  assert.equal(t.calls[2]!.body.max_tokens, 65536);

  // 预设的助手预填 → 前缀续写（Beta）
  await chatOnce(ep, { messages: USER, prefill: '「笨蛋 ', reasoningEffort: 'none' }, { stream: false });
  call = t.calls[3]!;
  assert.equal(call.url, 'https://api.deepseek.com/beta/chat/completions');
  assert.deepEqual(call.body.messages.at(-1), { role: 'assistant', content: '「笨蛋', prefix: true });

  // 选成"OpenAI 兼容"、地址是 DeepSeek 官方的旧设置也按 DeepSeek 的规则发；reasoner 不再被当成"模型名开思考"强制 temperature 1
  await chatOnce(endpoint('openai', t, { baseUrl: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-reasoner' }), { messages: USER, temperature: 0.9 }, { stream: false });
  call = t.calls.at(-1)!;
  assert.equal(call.body.temperature, 0.9);
});

test('Vertex Agent with an API key (math-reader): key in the URL, pasted full URL accepted; open models need a service account', async () => {
  const t = fakeTransport(() => sse([{ candidates: [{ content: { parts: [{ text: '好' }] } }] }], { done: false }));
  const ep = endpoint('vertex', t, {
    baseUrl: 'https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-3.7-flash:streamGenerateContent?alt=sse',
    key: 'AQ.test-key',
    model: 'gemini-3.7-flash',
  });
  const r = await chatOnce(ep, { messages: USER, reasoningEffort: 'high' }, { onDelta: () => undefined });
  assert.equal(r.text, '好');
  const call = t.calls[0]!;
  assert.equal(call.url, 'https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-3.7-flash:streamGenerateContent?alt=sse&key=AQ.test-key');
  assert.equal(call.headers.authorization, undefined);
  assert.equal(call.body.generationConfig.thinkingConfig.thinkingLevel, 'HIGH');
  await assert.rejects(
    chatOnce(endpoint('vertex', t, { key: 'AQ.test-key', model: 'deepseek-ai/deepseek-v4.1-flash-maas' }), { messages: USER }, { stream: false }),
    (e: unknown) => e instanceof AiError && e.code === 'no_key' && /服务账号/.test(e.message),
  );
});

/** 测试用的服务账号：现生成一对 RSA 密钥，私钥按 Google 的格式写成 PEM */
async function makeServiceAccount() {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const pem = `-----BEGIN PRIVATE KEY-----\n${base64Encode(der).replace(/(.{64})/g, '$1\n')}\n-----END PRIVATE KEY-----\n`;
  const sa = {
    type: 'service_account',
    project_id: 'demo-project',
    private_key_id: 'kid-1',
    private_key: pem,
    client_email: 'bot@demo-project.iam.gserviceaccount.com',
    token_uri: 'https://oauth2.googleapis.com/token',
  };
  return { json: JSON.stringify(sa, null, 2), publicKey: pair.publicKey };
}

const fromBase64url = (x: string) => base64Decode(x.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (x.length % 4)) % 4));

test('Vertex Agent with a service account: signed JWT → access token (cached), project endpoint for Gemini, OpenAI-compatible endpoint for DeepSeek', async () => {
  clearVertexTokens();
  const { json: key, publicKey } = await makeServiceAccount();
  const t = fakeTransport((req) => {
    if (req.url === 'https://oauth2.googleapis.com/token') return json({ access_token: 'ya29.test', expires_in: 3600, token_type: 'Bearer' });
    if (req.url.includes('/endpoints/openapi/')) return json({ choices: [{ message: { content: 'deepseek 在', reasoning_content: '想' } }] });
    return json({ candidates: [{ content: { parts: [{ text: 'gemini 在' }] } }] });
  });
  const r1 = await chatOnce(endpoint('vertex', t, { baseUrl: 'https://aiplatform.googleapis.com/v1/publishers/google', key, model: 'gemini-3.7-flash' }), { messages: USER }, { stream: false });
  assert.equal(r1.text, 'gemini 在');
  const [tokenCall, geminiCall] = t.calls;
  const form = new URLSearchParams(tokenCall!.rawBody as string);
  assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const [h, c, sig] = form.get('assertion')!.split('.') as [string, string, string];
  assert.deepEqual(JSON.parse(utf8Decode(fromBase64url(h))), { alg: 'RS256', typ: 'JWT', kid: 'kid-1' });
  const claims = JSON.parse(utf8Decode(fromBase64url(c)));
  assert.equal(claims.iss, 'bot@demo-project.iam.gserviceaccount.com');
  assert.equal(claims.scope, 'https://www.googleapis.com/auth/cloud-platform');
  assert.equal(claims.aud, 'https://oauth2.googleapis.com/token');
  assert.equal(claims.exp - claims.iat, 3600);
  assert.ok(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, new Uint8Array(fromBase64url(sig)), new Uint8Array(utf8Encode(`${h}.${c}`))));
  assert.equal(geminiCall!.url, 'https://aiplatform.googleapis.com/v1/projects/demo-project/locations/global/publishers/google/models/gemini-3.7-flash:generateContent');
  assert.equal(geminiCall!.headers.authorization, 'Bearer ya29.test');

  // DeepSeek：令牌复用，地区按连接的设置，模型名补上发布方，消息整理成 user 开头、轮流发言
  const ds = endpoint('vertex', t, { key, model: 'deepseek-v4.1-flash-maas', extra: { location: 'us-central1' } });
  const messages: ChatMessage[] = [
    { role: 'system', content: '设定' },
    { role: 'assistant', content: '开场白' },
    { role: 'user', content: '你好' },
  ];
  const r2 = await chatOnce(ds, { messages }, { stream: false });
  assert.equal(r2.text, 'deepseek 在');
  assert.equal(r2.thinking, '想');
  assert.equal(t.calls.length, 3);
  const dsCall = t.calls[2]!;
  assert.equal(dsCall.url, 'https://us-central1-aiplatform.googleapis.com/v1/projects/demo-project/locations/us-central1/endpoints/openapi/chat/completions');
  assert.equal(dsCall.headers.authorization, 'Bearer ya29.test');
  assert.equal(dsCall.body.model, 'deepseek-ai/deepseek-v4.1-flash-maas');
  assert.deepEqual(
    dsCall.body.messages.map((m: { role: string }) => m.role),
    ['system', 'user', 'assistant', 'user'],
  );
});

test('thinking levels: Gemini 4 takes levels only, "none" turns thinking off where it can', () => {
  assert.equal(geminiHasThinkingConfig('gemini-4-flash'), true);
  assert.equal(geminiHasThinkingConfig('gemini-3.1-flash-image'), false);
  assert.deepEqual(geminiThinking('gemini-4-pro', 8192, 'min'), { thinkingLevel: 'low' });
  assert.deepEqual(geminiThinking('gemini-4-flash', 8192, 'auto'), {});
  assert.deepEqual(geminiThinking('gemini-2.5-flash', 8192, 'none'), { thinkingBudget: 0 });
  assert.deepEqual(geminiThinking('gemini-2.5-pro', 8192, 'none'), { thinkingBudget: 128 });
  assert.deepEqual(deepseekThinking('none'), { thinking: { type: 'disabled' } });
  assert.deepEqual(deepseekThinking('min'), { thinking: { type: 'enabled' }, effort: 'low' });
  assert.deepEqual(deepseekThinking(undefined, 'reasoner'), { thinking: { type: 'enabled' } });
  assert.deepEqual(claudeThinking(claudeModelInfo('claude-sonnet-4-5'), 4096, 'none', true, true), {});
  assert.equal(openaiReasoningEffort('none'), 'none');
});
