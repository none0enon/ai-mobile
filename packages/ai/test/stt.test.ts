import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentSystem } from '../src/agents/system.ts';
import { listModels, testConnection } from '../src/connection.ts';
import { AiError, errorReport } from '../src/core/errors.ts';
import { sttTestAudio, transcribeAudio } from '../src/stt/client.ts';
import { endpoint, fakeTransport, json } from './helpers.ts';

test('STT uploads real audio as multipart with the configured model, filename and bearer key', async () => {
  const transport = fakeTransport(() => json({ text: '  你好，今天怎么样？  ' }));
  const audio = new Blob(['recorded audio bytes'], { type: 'audio/mp4' });
  const ep = endpoint('openai', transport, {
    baseUrl: 'https://api.siliconflow.cn/v1/audio/transcriptions',
    model: 'FunAudioLLM/SenseVoiceSmall',
    headers: { 'content-type': 'application/json', 'X-Custom': 'keep' },
  });
  assert.deepEqual(await transcribeAudio(ep, { audio }), { text: '你好，今天怎么样？' });
  const call = transport.calls[0]!;
  assert.equal(call.url, 'https://api.siliconflow.cn/v1/audio/transcriptions');
  assert.equal(call.method, 'POST');
  assert.equal(call.headers.authorization, 'Bearer sk-test');
  assert.equal(call.headers['content-type'], undefined);
  assert.equal(call.headers['x-custom'], 'keep');
  assert.ok(call.body instanceof FormData);
  assert.equal(call.body.get('model'), 'FunAudioLLM/SenseVoiceSmall');
  const file = call.body.get('file') as File;
  assert.equal(file.name, 'recording.m4a');
  assert.equal(file.type, 'audio/mp4');
  assert.equal(await file.text(), await audio.text());
});

test('STT handles WebM, empty recordings, silence, invalid responses and cancellation', async () => {
  const transport = fakeTransport(() => json({ text: '' }));
  const ep = endpoint('openai', transport);
  const audio = new Blob(['opus'], { type: 'audio/webm;codecs=opus' });
  assert.equal((await transcribeAudio(ep, { audio })).text, '');
  assert.equal((transport.calls[0]!.body.get('file') as File).name, 'recording.webm');
  await assert.rejects(transcribeAudio(ep, { audio: new Blob() }), (e: unknown) => e instanceof AiError && e.code === 'empty');
  await assert.rejects(transcribeAudio(ep, { audio, signal: AbortSignal.abort() }), (e: unknown) => e instanceof AiError && e.code === 'aborted');
  assert.equal(transport.calls.length, 1);
  const bad = fakeTransport(() => json({ unexpected: 'missing text' }));
  await assert.rejects(transcribeAudio(endpoint('openai', bad), { audio }), (e: unknown) => {
    return e instanceof AiError && e.code === 'bad_response' && /missing text/.test(errorReport(e));
  });
});

test('SiliconFlow lists speech-to-text models; custom OpenAI providers keep their standard models endpoint', async () => {
  const transport = fakeTransport(() => json({ data: [{ id: 'FunAudioLLM/SenseVoiceSmall' }] }));
  const sf = endpoint('openai', transport, { baseUrl: 'https://api.siliconflow.cn/v1' });
  assert.deepEqual(await listModels(sf, undefined, 'stt'), ['FunAudioLLM/SenseVoiceSmall']);
  assert.equal(transport.calls[0]!.url, 'https://api.siliconflow.cn/v1/models?sub_type=speech-to-text');
  await listModels(endpoint('openai', transport), undefined, 'stt');
  assert.equal(transport.calls[1]!.url, 'https://api.example.com/v1/models');
});

test('STT connection test posts a valid WAV and distinguishes upstream failures', async () => {
  const audio = sttTestAudio();
  const bytes = new Uint8Array(await audio.arrayBuffer());
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 4)), 'RIFF');
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint32(40, true), 32000);
  const transport = fakeTransport(() => json({ text: '' }));
  const result = await testConnection(endpoint('openai', transport), 'stt');
  assert.equal(result.ok, true);
  assert.match(result.message, /静音样本/);
  assert.equal((transport.calls[0]!.body.get('file') as File).size, audio.size);
  const failed = await testConnection(endpoint('openai', fakeTransport(() => json({ message: 'Invalid token' }, 401))), 'stt');
  assert.equal(failed.ok, false);
  assert.match(failed.detail!, /401/);
  assert.match(failed.detail!, /Invalid token/);
  assert.match(failed.detail!, /audio\/transcriptions/);
});

test('STT uses the configured route, reports real failures, and allows independent requests concurrently', async (t) => {
  const transport = fakeTransport(async (req) => {
    await Promise.resolve();
    if (req.headers.authorization !== 'Bearer configured-key') return json({ message: 'wrong key' }, 401);
    return json({ text: await (req.body.get('file') as File).text() });
  });
  t.mock.method(globalThis, 'fetch', (url: string, init: RequestInit) => transport(String(url), init));
  const outcomes: boolean[] = [];
  const sys = new AgentSystem({
    config: {
      routes: () => [{ role: 'stt', runsOn: 'device', api: { channel: 'siliconflow', baseUrl: 'https://api.siliconflow.cn/v1', model: 'FunAudioLLM/SenseVoiceSmall', models: [] }, backup: null }],
      keyOf: () => 'configured-key',
    },
    onCall: (role, outcome) => { assert.equal(role, 'stt'); outcomes.push(outcome.ok); },
  });
  const results = await Promise.all(['第一句', '第二句'].map((text) => sys.transcribe({ audio: new Blob([text], { type: 'audio/webm' }) })));
  assert.deepEqual(results.map((r) => r.text), ['第一句', '第二句']);
  assert.equal(results[0]!.connectionId, 'api:stt');
  assert.equal(results[0]!.model, 'FunAudioLLM/SenseVoiceSmall');
  assert.deepEqual(outcomes, [true, true]);
  await assert.rejects(sys.transcribe({ audio: new Blob() }));
  assert.deepEqual(outcomes, [true, true, false]);
});
