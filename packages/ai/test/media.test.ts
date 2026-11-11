import assert from 'node:assert/strict';
import { test } from 'node:test';
import { utf8Encode } from '@app/shared';
import { listModels, testConnection } from '../src/connection.ts';
import { AiError } from '../src/core/errors.ts';
import { embedTexts, instructionPrefix } from '../src/embedding/client.ts';
import { decodeVector, encodeVector, fromHalf, l2normalize, modelFamily, sameSpace, toHalf, vectorSpace } from '../src/embedding/vector.ts';
import { generateImage } from '../src/image/client.ts';
import { buildNovelaiPayload, NOVELAI_RETRY, varietySigma } from '../src/image/novelai.ts';
import { freeForOpus } from '../src/image/presets.ts';
import { applyImageStyle } from '../src/image/style.ts';
import { listZip, unzipFirst } from '../src/image/zip.ts';
import { synthesize } from '../src/tts/client.ts';
import { prepareTtsText, splitSentences } from '../src/tts/text.ts';
import { volcengineCloneStatus } from '../src/tts/volcengine.ts';
import { bytesResponse, endpoint, fakeTransport, json, makeZip, tinyPng } from './helpers.ts';

const MP3 = new Uint8Array([0x49, 0x44, 0x33, ...new Array(200).fill(7)]);

// —— 语音合成 ——

test('TTS text options (SillyTavern): actions, quotes only, tags and code blocks', () => {
  assert.equal(prepareTtsText('[expr:shy]（小声）……再摸一下也不是不行 😳 *转过头*[call]'), '……再摸一下也不是不行');
  assert.equal(prepareTtsText('*转过头*好呀<status>好感 72</status>```js\nx```'), '好呀');
  assert.equal(prepareTtsText('*转过头*好呀（笑）', { asterisks: 'keep', parentheses: 'keep' }), '转过头好呀（笑）');
  assert.equal(prepareTtsText('她看着你。“你来啦”她笑了，「再不来我就走了」', { quotedOnly: true }), '你来啦，再不来我就走了');
  assert.equal(prepareTtsText('今天好累。', { quotedOnly: true }), '今天好累。');
  assert.equal(prepareTtsText('苏晚：晚安', { speakerName: '苏晚' }), '晚安');
  assert.equal(prepareTtsText('好呀【旁白】', { regex: '/好/g', parentheses: 'keep' }), '呀【旁白】');
  assert.deepEqual(splitSentences('好呀。我们先去看水母吧！然后再去吃冰淇淋，好不好？嗯'), ['好呀。我们先去看水母吧！', '然后再去吃冰淇淋，好不好？嗯']);
});

test('OpenAI-compatible speech: SiliconFlow voice completed, CosyVoice emotion instruction, gpt-4o-mini-tts instructions', async () => {
  const t = fakeTransport(() => bytesResponse(MP3, 'audio/mpeg'));
  const ep = endpoint('openai', t, { baseUrl: 'https://api.siliconflow.cn/v1', model: 'FunAudioLLM/CosyVoice2-0.5B' });
  const a = await synthesize(ep, { text: '[expr:blush]笨蛋（脸红）……我也是', voice: { voiceId: 'claire', speed: 0.95 }, expression: 'blush' });
  const body = t.calls[0]!.body;
  assert.equal(t.calls[0]!.url, 'https://api.siliconflow.cn/v1/audio/speech');
  assert.equal(body.voice, 'FunAudioLLM/CosyVoice2-0.5B:claire');
  assert.equal(body.input, '请用害羞的语气说<|endofprompt|>笨蛋……我也是');
  assert.equal(a.mime, 'audio/mpeg');
  await synthesize({ ...ep, extra: { emotion: 'off' } }, { text: '好', voice: { voiceId: 'claire' }, expression: 'smile' });
  assert.equal(t.calls[1]!.body.input, '好');
  await synthesize(endpoint('openai', t, { model: 'gpt-4o-mini-tts' }), { text: '早安', voice: { voiceId: 'coral', style: '轻声' }, expression: 'smile' });
  assert.equal(t.calls[2]!.body.instructions, 'Emotion: happy. 轻声');
});

test('MiniMax: GroupId, emotion, hex audio, business error codes', async () => {
  const hex = Array.from(MP3, (b) => b.toString(16).padStart(2, '0')).join('');
  const t = fakeTransport((_r, i) =>
    i === 0 ? json({ data: { audio: hex }, base_resp: { status_code: 0 } }) : json({ base_resp: { status_code: 1008, status_msg: 'insufficient balance' } }),
  );
  const ep = endpoint('minimax', t, { baseUrl: 'https://api.minimaxi.com/v1', model: 'speech-02-hd', extra: { groupId: 'g1' } });
  const a = await synthesize(ep, { text: '难过', voice: { voiceId: 'female-shaonv' }, expression: 'sad' });
  assert.equal(t.calls[0]!.url, 'https://api.minimaxi.com/v1/t2a_v2?GroupId=g1');
  assert.equal(t.calls[0]!.body.voice_setting.emotion, 'sad');
  assert.deepEqual(a.bytes, MP3);
  await assert.rejects(synthesize(ep, { text: '再来', voice: { voiceId: 'x' } }), (e: unknown) => e instanceof AiError && e.status === 402);
});

test('Volcengine (SleepTogether): streamed base64 lines, App Id header fallback, cloned voices use seed-icl', async () => {
  const lines = [{ code: 0, data: Buffer.from(MP3.subarray(0, 100)).toString('base64') }, { code: 0, data: Buffer.from(MP3.subarray(100)).toString('base64') }, { code: 20000000, message: 'ok' }];
  const t = fakeTransport((req) =>
    req.headers['x-api-app-key'] ? json({ message: 'unauthorized' }, 401) : new Response(lines.map((l) => JSON.stringify(l)).join('\n'), { headers: { 'content-type': 'application/json' } }),
  );
  const ep = endpoint('volcengine', t, { baseUrl: 'https://openspeech.bytedance.com', model: 'seed-tts-2.0', key: 'Bearer; tok', extra: { appId: 'app1' } });
  const a = await synthesize(ep, { text: '你好呀', voice: { voiceId: 'S_abc123', speed: 1.2 } });
  assert.deepEqual(a.bytes, MP3);
  assert.equal(t.calls.length, 2);
  const call = t.calls[1]!;
  assert.equal(call.url, 'https://openspeech.bytedance.com/api/v3/tts/unidirectional');
  assert.equal(call.headers['x-api-app-id'], 'app1');
  assert.equal(call.headers['x-api-access-key'], 'tok');
  assert.equal(call.headers['x-api-resource-id'], 'seed-icl-2.0');
  assert.equal(call.body.req_params.speaker, 'S_abc123');
  assert.equal(call.body.req_params.audio_params.speech_rate, 20);
  const t2 = fakeTransport(() => json({ BaseResp: { StatusCode: 0 }, status: 2 }));
  assert.deepEqual(await volcengineCloneStatus(endpoint('volcengine', t2, { extra: { appId: 'app1' }, baseUrl: '' }), 'S_abc123'), { status: 2, text: '训练成功' });
  assert.equal(t2.calls[0]!.url, 'https://openspeech.bytedance.com/api/v1/mega_tts/status');
});

test('Fish Audio S1 emotion marker; GPT-SoVITS body', async () => {
  const t = fakeTransport(() => bytesResponse(MP3, 'audio/mpeg'));
  await synthesize(endpoint('fish-audio', t, { baseUrl: 'https://api.fish.audio', model: 's1' }), { text: '哈哈', voice: { voiceId: 'ref123' }, expression: 'laugh' });
  assert.equal(t.calls[0]!.headers.model, 's1');
  assert.equal(t.calls[0]!.body.text, '(joyful) 哈哈');
  const wav = new Uint8Array([...utf8Encode('RIFF'), 0, 0, 0, 0, ...utf8Encode('WAVE'), ...new Array(100).fill(0)]);
  const t2 = fakeTransport(() => bytesResponse(wav, 'audio/wav'));
  await synthesize(endpoint('gpt-sovits', t2, { baseUrl: 'http://127.0.0.1:9880', key: null }), { text: 'おはよう', voice: { voiceId: '/data/ref/suwan.wav', refText: '早上好呀' } });
  const b = t2.calls[0]!.body;
  assert.equal(b.text_lang, 'ja');
  assert.equal(b.ref_audio_path, '/data/ref/suwan.wav');
  assert.equal(t2.calls[0]!.headers.authorization, undefined);
});

// —— 生图 ——

test('zip reader: stored and deflated entries, CRC checked', async () => {
  const data = utf8Encode('苏晚的配图'.repeat(50));
  for (const method of [0, 8] as const) {
    const zip = await makeZip('image_0.png', data, method);
    assert.equal(listZip(zip)[0]!.name, 'image_0.png');
    assert.deepEqual((await unzipFirst(zip))?.data, data);
  }
  await assert.rejects(unzipFirst(await makeZip('image_0.png', data, 8, true)), /校验失败/);
});

test('NovelAI payload: no quality tags by default (like SleepTogether / ST), opt-in NAI presets, variety boost, schedule', () => {
  const plain = buildNovelaiPayload('nai-diffusion-4-5-full', { prompt: '1girl, library', negative: 'bad hands', size: 'portrait', seed: 42 });
  const p = plain.body.parameters as any;
  assert.equal(plain.prompt, '1girl, library');
  assert.equal(plain.negative, 'bad hands');
  assert.equal(p.qualityToggle, false);
  assert.equal(p.v4_prompt.caption.base_caption, '1girl, library');
  assert.equal(p.skip_cfg_above_sigma, null);
  assert.ok(freeForOpus(p));
  const styled = buildNovelaiPayload('nai-diffusion-4-5-full', {
    prompt: '1girl',
    quality: true,
    varietyBoost: true,
    noiseSchedule: 'native',
    characters: [{ prompt: 'girl, long hair', center: { x: 0.3, y: 0.5 } }],
  });
  const q = styled.body.parameters as any;
  assert.equal(styled.prompt, '1girl, very aesthetic, masterpiece, no text');
  assert.ok(styled.negative.startsWith('lowres, artistic error'));
  assert.equal(q.noise_schedule, 'native');
  assert.equal(q.skip_cfg_above_sigma, varietySigma(832, 1216, 'nai-diffusion-4-5-full'));
  assert.equal(Math.round(varietySigma(832, 1216, 'nai-diffusion-4-5-full')), 58);
  assert.equal(q.use_coords, true);
  assert.equal((buildNovelaiPayload('nai-diffusion-3', { prompt: 'x' }).body.parameters as any).v4_prompt, undefined);
});

test('image style: prefix with {prompt} macro, suffix and negative (SillyTavern / SleepTogether)', () => {
  const r = applyImageStyle({ prompt: '1girl, smile', negative: 'extra fingers' }, { prefix: 'masterpiece, {prompt}, detailed', suffix: 'soft light', negative: 'lowres', naiQuality: false, sampler: 'k_euler' });
  assert.equal(r.prompt, 'masterpiece, 1girl, smile, detailed, soft light');
  assert.equal(r.negative, 'lowres, extra fingers');
  assert.equal(r.sampler, 'k_euler');
  assert.equal(applyImageStyle({ prompt: 'x' }, { prefix: 'best quality', suffix: '', negative: '', naiQuality: true }).prompt, 'best quality, x');
});

test('NovelAI: 429 retried, zip unpacked, seed read back; public site returning JSON also works', async () => {
  NOVELAI_RETRY.delayMs = 5;
  const png = tinyPng({ Comment: JSON.stringify({ seed: 777 }) });
  const zip = await makeZip('image_0.png', png, 8);
  const t = fakeTransport((_r, i) => (i === 0 ? json({ message: 'Concurrent generation is locked' }, 429) : bytesResponse(zip, 'application/x-zip-compressed')));
  const r = await generateImage(endpoint('novelai', t, { baseUrl: 'https://image.novelai.net', model: 'nai-diffusion-4-5-full', key: 'pst-x' }), { prompt: '1girl', seed: 1 });
  assert.equal(t.calls.length, 2);
  assert.equal(t.calls[1]!.headers.authorization, 'Bearer pst-x');
  assert.deepEqual(r.images[0]!.bytes, png);
  assert.equal(r.seed, 777);
  const t2 = fakeTransport(() => json({ output: [{ image: `data:image/png;base64,${Buffer.from(png).toString('base64')}` }] }));
  const r2 = await generateImage(endpoint('novelai', t2, { baseUrl: 'https://nai-proxy.example.com/' }), { prompt: '1girl' });
  assert.equal(t2.calls[0]!.url, 'https://nai-proxy.example.com/ai/generate-image');
  assert.deepEqual(r2.images[0]!.bytes, png);
});

test('OpenAI-compatible images: SiliconFlow fields and url; gpt-image size by ratio, quality, negative as "Avoid:"', async () => {
  const png = tinyPng();
  const t = fakeTransport((req) => (req.url.endsWith('/images/generations') ? json({ images: [{ url: 'https://cdn.example/x.png' }], seed: 99 }) : bytesResponse(png, 'image/png')));
  const r = await generateImage(endpoint('openai', t, { baseUrl: 'https://api.siliconflow.cn/v1', model: 'Kwai-Kolors/Kolors' }), { prompt: '雨夜的窗边', negative: 'lowres', size: 'portrait', steps: 25 });
  assert.equal(t.calls[0]!.body.image_size, '832x1216');
  assert.equal(t.calls[0]!.body.negative_prompt, 'lowres');
  assert.deepEqual(r.images[0]!.bytes, png);
  assert.equal(r.seed, 99);
  const t2 = fakeTransport(() => json({ data: [{ b64_json: Buffer.from(png).toString('base64') }] }));
  const r2 = await generateImage(endpoint('openai', t2, { model: 'gpt-image-1' }), { prompt: 'a girl', negative: 'text', size: 'landscape', extra: { quality: 'high' } });
  const b = t2.calls[0]!.body;
  assert.equal(b.size, '1536x1024');
  assert.equal(b.quality, 'high');
  assert.equal(b.prompt, 'a girl\n\nAvoid: text');
  assert.equal(b.negative_prompt, undefined);
  assert.deepEqual(r2.images[0]!.bytes, png);
});

// —— 向量化 ——

test('float16 round trip and special values', () => {
  for (const x of [0, 1, -1, 0.5, 0.1234, -0.0007, 65504, 1e-6, 3.14159]) {
    const y = fromHalf(toHalf(x));
    assert.ok(Math.abs(y - x) <= Math.abs(x) * 1e-3 + 6e-8, `${x} → ${y}`);
  }
  assert.equal(fromHalf(toHalf(1e6)), Infinity);
  assert.ok(Number.isNaN(fromHalf(toHalf(NaN))));
  const v = l2normalize([3, 4, 0, -12]);
  decodeVector(encodeVector(v)).forEach((x, i) => assert.ok(Math.abs(x - (v[i] as number)) < 1e-3));
});

test('OpenAI-compatible embeddings: batches, index order, normalization, usage, query prefix override', async () => {
  const t = fakeTransport((req) => {
    const input: string[] = req.body.input;
    return json({ data: input.map((s, i) => ({ index: i, embedding: [s.length, 0, 0] })).reverse(), usage: { prompt_tokens: input.length * 3 } });
  });
  const r = await embedTexts(endpoint('openai', t, { model: 'BAAI/bge-m3' }), { texts: ['a', 'bb', 'ccc', '', 'eeeee'], batchSize: 2 });
  assert.equal(t.calls.length, 3);
  assert.equal(t.calls[1]!.body.input[1], ' ');
  assert.equal(r.dims, 3);
  assert.deepEqual(Array.from(r.vectors[1]!), [1, 0, 0]);
  assert.deepEqual(r.usage, { inputTokens: 15 });
  await embedTexts(endpoint('openai', t), { texts: ['x'], extra: { queryPrefix: 'Q: ' }, purpose: 'query' });
  assert.equal(t.calls.at(-1)!.body.input[0], 'Q: x');
  assert.equal(t.calls.at(-1)!.body.queryPrefix, undefined);
});

test('Gemini embeddings; Workers AI through the OpenAI-compatible endpoint (like SillyTavern); count mismatch errors', async () => {
  const t = fakeTransport(() => json({ embeddings: [{ values: [1, 1] }, { values: [2, 0] }] }));
  await embedTexts(endpoint('gemini', t, { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-embedding-001', key: 'k' }), { texts: ['他不吃香菜', '不要放芫荽'], purpose: 'query', dimensions: 768 });
  assert.equal(t.calls[0]!.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents?key=k');
  assert.equal(t.calls[0]!.body.requests[0].taskType, 'RETRIEVAL_QUERY');
  const t2 = fakeTransport(() => json({ data: [{ index: 0, embedding: [0, 2] }] }));
  const r2 = await embedTexts(endpoint('workers-ai', t2, { baseUrl: '经自己的 Worker', model: '@cf/baai/bge-m3', extra: { accountId: 'abc' } }), { texts: ['x'] });
  assert.equal(t2.calls[0]!.url, 'https://api.cloudflare.com/client/v4/accounts/abc/ai/v1/embeddings');
  assert.deepEqual(Array.from(r2.vectors[0]!), [0, 1]);
  await assert.rejects(embedTexts(endpoint('openai', t2), { texts: ['a', 'b'] }), /返回了 1 个向量/);
});

test('instruction prefixes and vector spaces', () => {
  assert.equal(instructionPrefix('intfloat/multilingual-e5-large', 'query'), 'query: ');
  assert.match(instructionPrefix('Qwen/Qwen3-Embedding-8B', 'query'), /^Instruct: /);
  assert.equal(instructionPrefix('BAAI/bge-m3', 'query'), '');
  assert.equal(modelFamily('@cf/baai/bge-m3'), 'bge-m3');
  assert.ok(sameSpace({ model: 'BAAI/bge-m3', dims: 1024 }, { model: '@cf/baai/bge-m3', dims: 1024 }));
  assert.ok(!sameSpace({ model: 'Qwen/Qwen3-Embedding-8B', dims: 1024 }, { model: 'Qwen/Qwen3-Embedding-8B', dims: 4096 }));
  assert.equal(vectorSpace('Pro/BAAI/bge-m3', 1024), 'bge-m3@1024');
});

// —— 连接 ——

test('model lists from three protocols; connection tests report instead of throwing', async () => {
  const t = fakeTransport((req) => {
    if (req.url.includes('generativelanguage')) return json({ models: [{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }, { name: 'models/imagen', supportedGenerationMethods: ['predict'] }] });
    if (req.url.includes('anthropic')) return json({ data: [{ id: 'claude-sonnet-5-5' }] });
    return json({ data: [{ id: 'deepseek-reasoner' }, { id: 'deepseek-chat' }] });
  });
  assert.deepEqual(await listModels(endpoint('openai', t, { baseUrl: 'https://api.deepseek.com' })), ['deepseek-chat', 'deepseek-reasoner']);
  assert.deepEqual(await listModels(endpoint('gemini', t, { baseUrl: 'https://generativelanguage.googleapis.com/v1beta' })), ['gemini-2.5-flash']);
  assert.deepEqual(await listModels(endpoint('anthropic', t, { baseUrl: 'https://api.anthropic.com' })), ['claude-sonnet-5-5']);
  assert.ok((await listModels(endpoint('volcengine', t))).includes('seed-tts-2.0'));
  const ok = await testConnection(endpoint('openai', fakeTransport(() => json({ choices: [{ message: { content: '在' } }] }))), 'chat');
  assert.equal(ok.message, '回复：在');
  const bad = await testConnection(endpoint('openai', fakeTransport(() => json({ error: { message: 'no such model' } }, 404))), 'chat');
  assert.equal(bad.ok, false);
  assert.match(bad.message, /404.*no such model/);
  const nai = fakeTransport(() => json({ tier: 3, active: true, perks: { unlimitedImageGeneration: true }, trainingStepsLeft: { fixedTrainingStepsLeft: 1000, purchasedTrainingSteps: 20 } }));
  assert.equal((await testConnection(endpoint('novelai', nai, { baseUrl: 'https://image.novelai.net' }), 'image')).message, 'Opus · 剩 1020 点 · 小图免点数');
  assert.equal(nai.calls[0]!.url, 'https://image.novelai.net/user/subscription');
  const site = await testConnection(endpoint('novelai', fakeTransport(() => json({}, 404)), { baseUrl: 'https://nai-proxy.example.com' }), 'image');
  assert.match(site.message, /查不到订阅/);
});
