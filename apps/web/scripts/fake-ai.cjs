/**
 * 端到端测试用的假 AI 服务端（ai-e2e.cjs 用）：OpenAI 兼容的对话（流式 / 普通）、模型列表、向量、语音合成，以及 NovelAI 的生图（返回 zip）。
 * 所有请求记在 /__log 里，测试脚本据此核对 App 实际发出了什么。
 */
const http = require('node:http');
const zlib = require('node:zlib');

const PORT = Number(process.env.PORT || 8787);
const log = [];

function crc32(buf) {
  return zlib.crc32(buf) >>> 0;
}

/** 64×96 的渐变 PNG */
function makePng() {
  const w = 64;
  const h = 96;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y += 1) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x += 1) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = 120 + Math.round((x / w) * 120);
      raw[o + 1] = 80 + Math.round((y / h) * 100);
      raw[o + 2] = 200;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const comment = Buffer.from(`Comment\0${JSON.stringify({ seed: 424242, steps: 28 })}`, 'latin1');
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('tEXt', comment),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 单文件 zip（deflate） */
function makeZip(name, data) {
  const comp = zlib.deflateRawSync(data);
  const nameBuf = Buffer.from(name);
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(comp.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(comp.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42);
  const localPart = Buffer.concat([local, nameBuf, comp]);
  const centralPart = Buffer.concat([central, nameBuf]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);
  return Buffer.concat([localPart, centralPart, eocd]);
}

/** 0.6 秒 440Hz 的 WAV */
function makeWav() {
  const rate = 16000;
  const n = Math.round(rate * 0.6);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i += 1) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), 44 + i * 2);
  return buf;
}

const PNG = makePng();
const ZIP = makeZip('image_0.png', PNG);
const WAV = makeWav();

const MAIN_REPLY = '[expr:shy]（小声）……你怎么知道我在想你。[cg:雨夜的窗边，她抱着靠垫回头看]';
const IMAGE_PROMPT = { caption: '雨夜窗边', tags: '1girl, upper body, looking back, hugging pillow, bedroom, rainy window, warm lamp light', negative: '', size: 'portrait' };
const SIDESTORY = {
  title: '借伞的人',
  story: '傍晚下起了雨，苏晚在图书馆门口被一个学弟拦住，说想借她的伞去一趟食堂。她犹豫了两秒，把伞递了过去，自己站在屋檐下等。雨越下越大，她给自己找了个理由：反正论文还没写完，多待一会儿也好。学弟跑回来时浑身湿透，伞却护得好好的。',
  time: '傍晚',
  place: '图书馆门口',
  mood: '有点好笑',
  people: ['学弟'],
  hook: '今天把伞借出去了，结果自己在屋檐下等了二十分钟',
  cg: '傍晚图书馆屋檐下，她抱着书看雨',
};

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function json(res, status, data) {
  cors(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function chatReply(body) {
  const sys = (body.messages || []).filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  const last = (body.messages || []).at(-1)?.content || '';
  if (/提示词写手/.test(sys)) return { text: JSON.stringify(IMAGE_PROMPT) };
  if (/番外/.test(sys)) return { text: JSON.stringify(SIDESTORY) };
  if (/测试连接/.test(last)) return { text: '在' };
  return { text: MAIN_REPLY, reasoning: '他刚刚说想我……先装作没在意。' };
}

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', async () => {
    if (req.method === 'OPTIONS') {
      cors(res);
      res.writeHead(204);
      return res.end();
    }
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (url.pathname === '/__log') return json(res, 200, log);
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }
    log.push({ method: req.method, path: url.pathname, auth: req.headers.authorization || null, body });

    if (url.pathname.startsWith('/broken/')) return json(res, 502, { error: { message: 'relay upstream is down' } });

    if (url.pathname.endsWith('/models') && req.method === 'GET') {
      return json(res, 200, { data: [{ id: 'fake-chat-pro' }, { id: 'fake-chat-mini' }, { id: 'BAAI/bge-m3' }] });
    }
    if (url.pathname.endsWith('/chat/completions')) {
      if (req.headers.authorization !== 'Bearer sk-test') return json(res, 401, { error: { message: 'invalid api key' } });
      const r = chatReply(body);
      if (!body.stream) return json(res, 200, { choices: [{ message: { content: r.text }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 30 } });
      cors(res);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const events = [];
      if (r.reasoning) for (const piece of r.reasoning.match(/.{1,6}/gu)) events.push({ choices: [{ delta: { reasoning_content: piece } }] });
      for (const piece of r.text.match(/.{1,3}/gsu)) events.push({ choices: [{ delta: { content: piece } }] });
      events.push({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 40 } });
      for (const e of events) {
        res.write(`data: ${JSON.stringify(e)}\n\n`);
        await new Promise((r2) => setTimeout(r2, 25));
      }
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    if (url.pathname.endsWith('/embeddings')) {
      const input = Array.isArray(body.input) ? body.input : [body.input];
      // 含"香菜 / 芫荽"的句子向量相近
      const data = input.map((t, index) => ({ index, embedding: /香菜|芫荽/.test(t) ? [1, 0.2, 0.1, 0] : [0, 0.3, 1, 0.5] }));
      return json(res, 200, { data, usage: { prompt_tokens: input.length * 8 } });
    }
    if (url.pathname.endsWith('/audio/speech')) {
      cors(res);
      res.writeHead(200, { 'Content-Type': 'audio/wav' });
      return res.end(WAV);
    }
    if (url.pathname === '/ai/generate-image') {
      cors(res);
      res.writeHead(200, { 'Content-Type': 'application/x-zip-compressed' });
      return res.end(ZIP);
    }
    json(res, 404, { error: { message: `no route ${url.pathname}` } });
  });
});

/** 测试脚本里直接启动；也可以单独运行：node scripts/fake-ai.cjs */
function start(port = PORT) {
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (require.main === module) start().then(() => console.log(`fake ai on ${PORT}`));

module.exports = { start };
