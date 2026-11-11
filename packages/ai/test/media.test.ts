import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crc32, utf8Encode, writePngText } from '@app/shared';
import { listModels, testConnection } from '../src/connection.ts';
import { AiError } from '../src/core/errors.ts';
import { embedTexts, instructionPrefix } from '../src/embedding/client.ts';
import { decodeVector, encodeVector, fromHalf, l2normalize, modelFamily, sameSpace, toHalf, vectorSpace } from '../src/embedding/vector.ts';
import { generateImage } from '../src/image/client.ts';
import { buildNovelaiPayload, NOVELAI_RETRY } from '../src/image/novelai.ts';
import { joinTags, freeForOpus } from '../src/image/presets.ts';
import { listZip, unzipFirst } from '../src/image/zip.ts';
import { synthesize, ttsCacheKey } from '../src/tts/client.ts';
import { prepareTtsText, splitSentences } from '../src/tts/text.ts';
import { bytesResponse, endpoint, fakeTransport, json } from './helpers.ts';

// —— 测试素材 ——

/** 一个只有文件头和 IHDR / IEND 的 PNG（readPngText 只看块结构） */
function tinyPng(meta?: Record<string, string>): Uint8Array {
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(utf8Encode(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length) >>> 0);
    return out;
  };
  const ihdr = new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk('IHDR', ihdr), chunk('IEND', new Uint8Array())];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    png.set(p, o);
    o += p.length;
  }
  return meta ? writePngText(png, meta) : png;
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const s = new Response(new Uint8Array(data)).body!.pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/** 手工拼一个 zip（单个文件），method 0 不压缩、8 deflate */
async function makeZip(name: string, data: Uint8Array, method: 0 | 8, corruptCrc = false): Promise<Uint8Array> {
  const comp = method === 8 ? await deflateRaw(data) : data;
  const nameBytes = utf8Encode(name);
  const crc = (crc32(data) >>> 0) ^ (corruptCrc ? 1 : 0);
  const local = new Uint8Array(30 + nameBytes.length);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true);
  lv.setUint16(4, 20, true);
  lv.setUint16(8, method, true);
  lv.setUint32(14, crc, true);
  lv.setUint32(18, comp.length, true);
  lv.setUint32(22, data.length, true);
  lv.setUint16(26, nameBytes.length, true);
  local.set(nameBytes, 30);
  const central = new Uint8Array(46 + nameBytes.length);
  const cv = new DataView(central.buffer);
  cv.setUint32(0, 0x02014b50, true);
  cv.setUint16(10, method, true);
  cv.setUint32(16, crc, true);
  cv.setUint32(20, comp.length, true);
  cv.setUint32(24, data.length, true);
  cv.setUint16(28, nameBytes.length, true);
  cv.setUint32(42, 0, true);
  central.set(nameBytes, 46);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, 1, true);
  ev.setUint16(10, 1, true);
  ev.setUint32(12, central.length, true);
  ev.setUint32(16, local.length + comp.length, true);
  const out = new Uint8Array(local.length + comp.length + central.length + eocd.length);
  out.set(local, 0);
  out.set(comp, local.length);
  out.set(central, local.length + comp.length);
  out.set(eocd, local.length + comp.length + central.length);
  return out;
}

const MP3 = new Uint8Array([0x49, 0x44, 0x33, ...new Array(200).fill(7)]);

// —— 语音合成 ——

test('TTS text: control tags, stage directions, emoji and markdown are removed', () => {
  assert.equal(prepareTtsText('[expr:shy]（小声）……再摸一下也不是不行 😳 *转过头*[call]'), '……再摸一下也不是不行');
  assert.equal(prepareTtsText('(托着下巴看你)你说什么我都爱听~ https://x.y/z'), '你说什么我都爱听');
  assert.deepEqual(splitSentences('好呀。我们先去看水母吧！然后再去吃冰淇淋，好不好？嗯'), ['好呀。我们先去看水母吧！', '然后再去吃冰淇淋，好不好？嗯']);
});

test('OpenAI-compatible speech: SiliconFlow voice name completed, CosyVoice emotion instruction', async () => {
  const t = fakeTransport(() => bytesResponse(MP3, 'audio/mpeg'));
  const ep = endpoint('openai', t, { baseUrl: 'https://api.siliconflow.cn/v1', model: 'FunAudioLLM/CosyVoice2-0.5B' });
  const a = await synthesize(ep, { text: '[expr:blush]笨蛋（脸红）……我也是', voice: { voiceId: 'claire', speed: 0.95, emotionMap: {} }, expression: 'blush' });
  const body = t.calls[0]!.body;
  assert.equal(t.calls[0]!.url, 'https://api.siliconflow.cn/v1/audio/speech');
  assert.equal(body.voice, 'FunAudioLLM/CosyVoice2-0.5B:claire');
  assert.equal(body.input, '请用害羞的语气说<|endofprompt|>笨蛋……我也是');
  assert.equal(body.speed, 0.95);
  assert.equal(a.mime, 'audio/mpeg');
  assert.equal(a.emotion, 'shy');
  assert.equal(a.text, '笨蛋……我也是');
  // 连接里关掉情绪指令
  await synthesize({ ...ep, extra: { emotion: 'off' } }, { text: '好', voice: { voiceId: 'claire' }, expression: 'smile' });
  assert.equal(t.calls[1]!.body.input, '好');
});

test('gpt-4o-mini-tts gets instructions; a JSON body with 200 is treated as an error', async () => {
  const t = fakeTransport((_r, i) => (i === 0 ? bytesResponse(MP3, 'application/octet-stream') : json({ error: { message: 'quota exceeded' } })));
  const ep = endpoint('openai', t, { model: 'gpt-4o-mini-tts' });
  await synthesize(ep, { text: '早安', voice: { voiceId: 'coral', style: '轻声、温柔' }, expression: 'smile' });
  assert.equal(t.calls[0]!.body.instructions, 'Emotion: happy. 轻声、温柔');
  await assert.rejects(synthesize(ep, { text: '早安', voice: { voiceId: 'coral' } }), (e: unknown) => e instanceof AiError && /quota exceeded/.test(e.message));
});

test('MiniMax: GroupId, emotion, hex audio, and business error codes', async () => {
  const hex = Array.from(MP3, (b) => b.toString(16).padStart(2, '0')).join('');
  const t = fakeTransport((_r, i) =>
    i === 0 ? json({ data: { audio: hex, status: 2 }, base_resp: { status_code: 0, status_msg: 'success' } }) : json({ base_resp: { status_code: 1008, status_msg: 'insufficient balance' } }),
  );
  const ep = endpoint('minimax', t, { baseUrl: 'https://api.minimaxi.com/v1', model: 'speech-02-hd', extra: { groupId: 'g1' } });
  const a = await synthesize(ep, { text: '难过', voice: { voiceId: 'female-shaonv', pitch: 1.4 }, expression: 'sad' });
  assert.equal(t.calls[0]!.url, 'https://api.minimaxi.com/v1/t2a_v2?GroupId=g1');
  assert.equal(t.calls[0]!.body.voice_setting.emotion, 'sad');
  assert.equal(t.calls[0]!.body.voice_setting.pitch, 1);
  assert.deepEqual(a.bytes, MP3);
  await assert.rejects(synthesize(ep, { text: '再来', voice: { voiceId: 'x' } }), (e: unknown) => e instanceof AiError && e.status === 402 && /insufficient balance/.test(e.message));
});

test('Fish Audio S1 emotion marker and model header; GPT-SoVITS body', async () => {
  const t = fakeTransport(() => bytesResponse(MP3, 'audio/mpeg'));
  await synthesize(endpoint('fish-audio', t, { baseUrl: 'https://api.fish.audio', model: 's1' }), { text: '哈哈', voice: { voiceId: 'ref123' }, expression: 'laugh' });
  assert.equal(t.calls[0]!.url, 'https://api.fish.audio/v1/tts');
  assert.equal(t.calls[0]!.headers.model, 's1');
  assert.equal(t.calls[0]!.body.text, '(joyful) 哈哈');
  assert.equal(t.calls[0]!.body.reference_id, 'ref123');
  const wav = new Uint8Array([...utf8Encode('RIFF'), 0, 0, 0, 0, ...utf8Encode('WAVE'), ...new Array(100).fill(0)]);
  const t2 = fakeTransport(() => bytesResponse(wav, 'audio/wav'));
  const a = await synthesize(endpoint('gpt-sovits', t2, { baseUrl: 'http://127.0.0.1:9880', key: null }), {
    text: 'おはよう',
    voice: { voiceId: '/data/ref/suwan.wav', refText: '早上好呀', refLang: 'zh', speed: 1.1 },
  });
  const b = t2.calls[0]!.body;
  assert.equal(t2.calls[0]!.url, 'http://127.0.0.1:9880/tts');
  assert.equal(b.text_lang, 'ja');
  assert.equal(b.ref_audio_path, '/data/ref/suwan.wav');
  assert.equal(b.prompt_text, '早上好呀');
  assert.equal(b.speed_factor, 1.1);
  assert.equal(t2.calls[0]!.headers.authorization, undefined);
  assert.equal(a.mime, 'audio/wav');
});

test('TTS cache key depends on emotion and cleaned text only', () => {
  const ep = endpoint('openai', fakeTransport(() => json({})), { model: 'm' });
  const k1 = ttsCacheKey(ep, { text: '（笑）你好', voice: { voiceId: 'v' }, expression: 'smile' });
  const k2 = ttsCacheKey(ep, { text: '你好', voice: { voiceId: 'v' }, expression: 'laugh' });
  const k3 = ttsCacheKey(ep, { text: '你好', voice: { voiceId: 'v' }, expression: 'sad' });
  assert.equal(k1, k2);
  assert.notEqual(k1, k3);
});

// —— 生图 ——

test('zip reader: stored and deflated entries, CRC checked', async () => {
  const data = utf8Encode('苏晚的配图'.repeat(50));
  for (const method of [0, 8] as const) {
    const zip = await makeZip('image_0.png', data, method);
    assert.equal(listZip(zip)[0]!.name, 'image_0.png');
    const file = await unzipFirst(zip);
    assert.deepEqual(file?.data, data);
  }
  await assert.rejects(unzipFirst(await makeZip('image_0.png', data, 8, true)), /校验失败/);
});

test('NovelAI V4.5 payload: quality tags, UC preset, characters, seed', () => {
  const { body, prompt, negative, seed } = buildNovelaiPayload('nai-diffusion-4-5-full', {
    prompt: '1girl, library, rainy window, very aesthetic',
    negative: 'bad hands',
    size: 'portrait',
    seed: 42,
    characters: [{ prompt: 'girl, long hair', center: { x: 0.3, y: 0.5 } }],
  });
  assert.equal(seed, 42);
  assert.equal(prompt, '1girl, library, rainy window, very aesthetic, masterpiece, no text');
  assert.ok(negative.startsWith('lowres, artistic error'));
  assert.ok(negative.endsWith('bad hands'));
  const p = body.parameters as any;
  assert.equal(body.model, 'nai-diffusion-4-5-full');
  assert.equal(p.width, 832);
  assert.equal(p.height, 1216);
  assert.equal(p.steps, 28);
  assert.equal(p.use_coords, true);
  assert.equal(p.v4_prompt.caption.base_caption, prompt);
  assert.deepEqual(p.v4_prompt.caption.char_captions, [{ char_caption: 'girl, long hair', centers: [{ x: 0.3, y: 0.5 }] }]);
  assert.equal(p.v4_negative_prompt.caption.base_caption, negative);
  assert.ok(freeForOpus(p));
  assert.equal(joinTags('a, B', 'b, c，d'), 'a, B, c, d');
  const v3 = buildNovelaiPayload('nai-diffusion-3', { prompt: 'x', quality: false, ucPreset: 'none' });
  assert.equal(v3.prompt, 'x');
  assert.equal(v3.negative, '');
  assert.equal((v3.body.parameters as any).v4_prompt, undefined);
});

test('NovelAI: 429 retried, zip unpacked, seed read back from PNG metadata', async () => {
  NOVELAI_RETRY.delayMs = 5;
  const png = tinyPng({ Comment: JSON.stringify({ seed: 777, steps: 28 }) });
  const zip = await makeZip('image_0.png', png, 8);
  const t = fakeTransport((_r, i) => (i === 0 ? json({ statusCode: 429, message: 'Concurrent generation is locked' }, 429) : bytesResponse(zip, 'application/x-zip-compressed')));
  const r = await generateImage(endpoint('novelai', t, { baseUrl: 'https://image.novelai.net', model: 'nai-diffusion-4-5-full', key: 'pst-x' }), { prompt: '1girl', seed: 1 });
  assert.equal(t.calls.length, 2);
  assert.equal(t.calls[1]!.url, 'https://image.novelai.net/ai/generate-image');
  assert.equal(t.calls[1]!.headers.authorization, 'Bearer pst-x');
  assert.deepEqual(r.images[0]!.bytes, png);
  assert.equal(r.seed, 777);
});

test('OpenAI-compatible images: SiliconFlow url result fetched; OpenAI b64', async () => {
  const png = tinyPng();
  const t = fakeTransport((req) =>
    req.url.endsWith('/images/generations') ? json({ images: [{ url: 'https://cdn.example/x.png' }], seed: 99 }) : bytesResponse(png, 'image/png'),
  );
  const r = await generateImage(endpoint('openai', t, { baseUrl: 'https://api.siliconflow.cn/v1', model: 'Kwai-Kolors/Kolors' }), {
    prompt: '雨夜的窗边',
    negative: 'lowres',
    size: 'portrait',
    steps: 25,
  });
  const body = t.calls[0]!.body;
  assert.equal(body.image_size, '832x1216');
  assert.equal(body.num_inference_steps, 25);
  assert.equal(body.negative_prompt, 'lowres');
  assert.deepEqual(r.images[0]!.bytes, png);
  assert.equal(r.seed, 99);
  const b64 = Buffer.from(png).toString('base64');
  const t2 = fakeTransport(() => json({ data: [{ b64_json: b64 }] }));
  const r2 = await generateImage(endpoint('openai', t2, { model: 'gpt-image-1' }), { prompt: 'x', size: 'landscape' });
  assert.equal(t2.calls[0]!.body.size, '1536x1024');
  assert.equal(t2.calls[0]!.body.response_format, undefined);
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
  const back = decodeVector(encodeVector(v));
  assert.equal(back.length, 4);
  back.forEach((x, i) => assert.ok(Math.abs(x - (v[i] as number)) < 1e-3));
});

test('OpenAI-compatible embeddings: batches, index order, normalization, usage, base64 floats', async () => {
  const t = fakeTransport((req) => {
    const input: string[] = req.body.input;
    const data = input.map((s, i) => ({ index: input.length - 1 - i, embedding: [s.length, 0, 0] })).reverse();
    return json({ data, usage: { prompt_tokens: input.length * 3 } });
  });
  const ep = endpoint('openai', t, { baseUrl: 'https://api.siliconflow.cn/v1', model: 'BAAI/bge-m3' });
  const r = await embedTexts(ep, { texts: ['a', 'bb', 'ccc', '', 'eeeee'], batchSize: 2 });
  assert.equal(t.calls.length, 3);
  assert.equal(t.calls[1]!.body.input[1], ' ');
  assert.equal(r.vectors.length, 5);
  assert.equal(r.dims, 3);
  assert.deepEqual(Array.from(r.vectors[1]!), [1, 0, 0]);
  assert.deepEqual(r.usage, { inputTokens: 15 });
  const f32 = new Float32Array([0, 3, 4]);
  const t2 = fakeTransport(() => json({ data: [{ index: 0, embedding: Buffer.from(f32.buffer).toString('base64') }] }));
  const r2 = await embedTexts(endpoint('openai', t2), { texts: ['x'], extra: { queryPrefix: 'Q: ' }, purpose: 'query', dimensions: 3 });
  assert.equal(t2.calls[0]!.body.input[0], 'Q: x');
  assert.equal(t2.calls[0]!.body.queryPrefix, undefined);
  assert.equal(t2.calls[0]!.body.dimensions, 3);
  assert.ok(Math.abs(r2.vectors[0]![2]! - 0.8) < 1e-6);
});

test('Gemini and Workers AI embedding shapes; count mismatch is an error', async () => {
  const t = fakeTransport(() => json({ embeddings: [{ values: [1, 1] }, { values: [2, 0] }] }));
  const r = await embedTexts(endpoint('gemini', t, { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-embedding-001', key: 'k' }), {
    texts: ['他不吃香菜', '不要放芫荽'],
    purpose: 'query',
    dimensions: 768,
  });
  assert.equal(t.calls[0]!.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents?key=k');
  assert.equal(t.calls[0]!.body.requests[0].taskType, 'RETRIEVAL_QUERY');
  assert.equal(t.calls[0]!.body.requests[0].outputDimensionality, 768);
  assert.ok(Math.abs(r.vectors[0]![0]! - Math.SQRT1_2) < 1e-6);
  const t2 = fakeTransport(() => json({ result: { data: [[0, 2]], shape: [1, 2] }, success: true }));
  const r2 = await embedTexts(endpoint('workers-ai', t2, { baseUrl: 'https://api.cloudflare.com/client/v4/accounts/abc/ai', model: '@cf/baai/bge-m3' }), { texts: ['x'] });
  assert.equal(t2.calls[0]!.url, 'https://api.cloudflare.com/client/v4/accounts/abc/ai/run/@cf/baai/bge-m3');
  assert.deepEqual(Array.from(r2.vectors[0]!), [0, 1]);
  const t3 = fakeTransport(() => json({ data: [{ index: 0, embedding: [1] }] }));
  await assert.rejects(embedTexts(endpoint('openai', t3), { texts: ['a', 'b'] }), /返回了 1 个向量/);
});

test('instruction prefixes and vector spaces', () => {
  assert.equal(instructionPrefix('intfloat/multilingual-e5-large', 'query'), 'query: ');
  assert.equal(instructionPrefix('intfloat/multilingual-e5-large', 'document'), 'passage: ');
  assert.match(instructionPrefix('Qwen/Qwen3-Embedding-8B', 'query'), /^Instruct: /);
  assert.equal(instructionPrefix('Qwen/Qwen3-Embedding-8B', 'document'), '');
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
  assert.equal(t.calls[0]!.url, 'https://api.deepseek.com/v1/models');
  assert.deepEqual(await listModels(endpoint('gemini', t, { baseUrl: 'https://generativelanguage.googleapis.com/v1beta' })), ['gemini-2.5-flash']);
  assert.deepEqual(await listModels(endpoint('anthropic', t, { baseUrl: 'https://api.anthropic.com' })), ['claude-sonnet-5-5']);
  assert.ok((await listModels(endpoint('novelai', t))).includes('nai-diffusion-4-5-full'));

  const ok = await testConnection(endpoint('openai', fakeTransport(() => json({ choices: [{ message: { content: '在' } }] }))), 'chat');
  assert.equal(ok.ok, true);
  assert.equal(ok.message, '回复：在');
  const bad = await testConnection(endpoint('openai', fakeTransport(() => json({ error: { message: 'no such model' } }, 404))), 'chat');
  assert.equal(bad.ok, false);
  assert.match(bad.message, /404.*no such model/);
  const nai = await testConnection(endpoint('novelai', fakeTransport(() => json({ tier: 3, active: true, trainingStepsLeft: { fixedTrainingStepsLeft: 1000, purchasedTrainingSteps: 20 } }))), 'image');
  assert.equal(nai.message, 'Opus · 剩 1020 点 · 小图免点数');
});
