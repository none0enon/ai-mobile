/**
 * AI 调用的端到端检查：在真实页面里给连接填地址和 Key（指向本地的假服务端 fake-ai.cjs），然后
 * 测试连接 → 聊天流式回复 → 配图（生图提示词智能体 + NovelAI zip）→ 向量相似度 → 试听 → 番外 → 备用连接 → 两个都失败 → 刷新后设置还在。
 *
 *   cd apps/web && npx vite preview --port 4173 &
 *   node scripts/ai-e2e.cjs            # 截图写到 ../../screenshots/ai（已在 .gitignore 里）
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const fakeAi = require('./fake-ai.cjs');

const BASE = process.env.BASE || 'http://127.0.0.1:4173/';
const FAKE_PORT = Number(process.env.FAKE_PORT || 8787);
const FAKE = `http://127.0.0.1:${FAKE_PORT}`;
const OUT = process.env.OUT || path.resolve(__dirname, '../../../screenshots/ai');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}
async function fakeLog() {
  const r = await fetch(`${FAKE}/__log`);
  return r.json();
}
async function goTo(p, route) {
  await p.evaluate((r) => (location.hash = `#${r}`), route);
  await p.waitForTimeout(500);
}
async function shot(p, name) {
  await p.screenshot({ path: path.join(OUT, `${name}.png`) });
}

async function editConnection(p, name, { url, key, test = false }) {
  await p.click(`button.conn:has-text("${name}")`);
  await p.waitForSelector('#conn-url');
  if (url !== undefined) await p.fill('#conn-url', url);
  if (key !== undefined) {
    await p.click('#conn-key');
    await p.fill('#conn-key', key);
  }
  let testText = null;
  if (test) {
    await p.click('.sheet button:has-text("测试连接")');
    await p.waitForSelector('.test-result', { timeout: 15000 });
    await p.waitForTimeout(300);
    testText = await p.textContent('.test-result');
  }
  await p.click('.sheet .van-button--primary:has-text("保存")');
  await p.waitForTimeout(400);
  return testText;
}

(async () => {
  const fake = await fakeAi.start(FAKE_PORT);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, locale: 'zh-CN', colorScheme: 'dark' });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  // 故意制造的 502 / 401 浏览器会记一条 "Failed to load resource"：那是预期的，不算页面报错
  p.on('console', (m) => m.type() === 'error' && !m.text().startsWith('Failed to load resource') && errors.push(`console: ${m.text()}`));

  await p.goto(`${BASE}#/me/api`);
  await p.waitForSelector('button.conn');
  check('agents start in demo mode', (await p.textContent('[data-role="main"] .live-line')).includes('演示模型'));

  // —— 中转站 A：拉模型列表、测试、保存 ——
  await p.click('button.conn:has-text("中转站 A")');
  await p.fill('#conn-url', `${FAKE}/v1`);
  await p.click('#conn-key');
  await p.fill('#conn-key', 'sk-test');
  await p.click('.sheet button:has-text("拉取模型列表")');
  await p.waitForSelector('.sheet .tag.model:has-text("fake-chat-pro")', { timeout: 10000 });
  check('model list fetched from the relay', true);
  await p.click('.sheet button:has-text("测试连接")');
  await p.waitForSelector('.test-result', { timeout: 15000 });
  const relayTest = await p.textContent('.test-result');
  check('relay connection test', relayTest.includes('对话：回复：在'), relayTest);
  await p.click('.sheet .van-button--primary:has-text("保存")');
  await p.waitForTimeout(400);
  check('main agent is live after adding the key', (await p.textContent('[data-role="main"] .live-line')).includes('已接通'));

  await editConnection(p, 'DeepSeek 官方', { url: `${FAKE}/v1`, key: 'sk-test' });
  await editConnection(p, 'NovelAI', { url: FAKE, key: 'pst-test' });
  const sfTest = await editConnection(p, '硅基流动', { url: `${FAKE}/v1`, key: 'sk-test', test: true });
  check('SiliconFlow test covers chat, embedding and TTS', /对话：回复：在/.test(sfTest) && /向量：4 维向量/.test(sfTest) && /语音合成：收到 .* KB 音频（audio\/wav）/.test(sfTest), sfTest.replace(/\n/g, ' | '));
  for (const role of ['sidestory', 'imagePrompt', 'image', 'embedding', 'tts']) {
    check(`${role} agent live`, (await p.textContent(`[data-role="${role}"] .live-line`)).includes('已接通'));
  }

  // —— 向量相似度 ——
  await p.click('button:has-text("测试相似度")');
  await p.click('.sheet button:has-text("计算相似度")');
  await p.waitForSelector('.sim b');
  const sim = Number(await p.textContent('.sim b'));
  check('embedding similarity uses the real endpoint', sim > 0.95 && (await p.textContent('.sim')).includes('BAAI/bge-m3'), `sim=${sim}`);
  await p.keyboard.press('Escape');
  await p.click('.van-overlay').catch(() => undefined);
  await p.waitForTimeout(300);
  await p.$eval('.page-scroll', (el) => el.scrollTo(0, 0));
  await shot(p, '1-api-configured');

  // —— 聊天：流式回复 + 配图 ——
  await goTo(p, '/chat/chat-suwan');
  await p.fill('textarea', '在干嘛呀，有点想你');
  await p.click('[aria-label="发送"]');
  await p.waitForSelector('text=你怎么知道我在想你', { timeout: 15000 });
  check('chat reply streamed from the fake relay', true);
  const shown = await p.locator('.msg').last().textContent();
  check('control tags stripped from the bubble', !shown.includes('[expr') && !shown.includes('[cg'), shown.slice(0, 80));
  await p.waitForSelector('img.gen-img', { timeout: 20000 });
  const src = await p.getAttribute('img.gen-img', 'src');
  check('generated image shown from the local asset store', src && src.startsWith('blob:'), src);
  await p.waitForTimeout(500);
  await shot(p, '2-chat-real-reply-and-image');
  let log = await fakeLog();
  const mainReq = log.find((r) => r.path === '/v1/chat/completions' && r.body?.stream && r.body.messages.some((m) => m.content.includes('有点想你')));
  check('main request went to relay with the route model and key', mainReq && mainReq.body.model === 'relay-main-model' && mainReq.auth === 'Bearer sk-test', mainReq ? `model=${mainReq.body.model}` : 'missing');
  check('main request carries the preset sampling', mainReq && typeof mainReq.body.temperature === 'number' && mainReq.body.messages[0].role === 'system');
  const promptReq = log.find((r) => r.path === '/v1/chat/completions' && r.body?.messages?.[0]?.content?.includes('提示词写手'));
  check('image prompt agent asked for JSON', promptReq && promptReq.body.response_format?.type === 'json_object' && promptReq.body.model === 'deepseek-chat');
  const drawReq = log.find((r) => r.path === '/ai/generate-image' && r.body);
  check('NovelAI called with appearance tags first and V4 caption', drawReq && drawReq.auth === 'Bearer pst-test' && drawReq.body.model === 'nai-diffusion-4-5-full' && drawReq.body.parameters.v4_prompt.caption.base_caption.includes('rainy window'), drawReq?.body?.input?.slice(0, 120));

  // 打开配图看参数
  await p.locator('.pcard.image').last().click();
  await p.waitForSelector('.van-popup:visible >> text=种子');
  const viewer = await p.locator('.van-popup:visible').last().textContent();
  check('image viewer shows seed from PNG metadata and model', viewer.includes('424242') && viewer.includes('nai-diffusion-4-5-full'), viewer.replace(/\s+/g, ' ').slice(0, 200));
  await shot(p, '3-image-viewer');
  await p.click('.van-overlay:visible').catch(() => undefined);
  await p.waitForTimeout(300);

  // —— 试听 ——
  await goTo(p, '/me/voice');
  await p.click('.voice >> nth=0 >> button:has-text("试听")');
  await p.waitForTimeout(1500);
  log = await fakeLog();
  const speech = log.filter((r) => r.path === '/v1/audio/speech').at(-1);
  check('voice preview synthesized with the character voice', speech && speech.body.voice === 'FunAudioLLM/CosyVoice2-0.5B:claire' && !/[（(]/.test(speech.body.input), speech ? `input=${speech.body.input}` : 'missing');
  await shot(p, '4-voice');

  // —— 番外 ——
  await goTo(p, '/me');
  await p.click('text=写一段她的番外');
  await p.waitForSelector('[data-sheet="sidestory"]', { timeout: 15000 });
  const story = await p.textContent('[data-sheet="sidestory"]');
  check('sidestory written by the agent', story.includes('借伞的人') && story.includes('番外智能体'), story.slice(0, 60));
  log = await fakeLog();
  const storyReq = log.find((r) => r.body?.messages?.[0]?.content?.includes('番外'));
  check('sidestory prompt includes her world and schedule', storyReq && storyReq.body.messages[1].content.includes('作息') && storyReq.body.messages[1].content.includes('宋词里的雨'));
  await shot(p, '5-sidestory');
  await p.click('[data-sheet="sidestory"] button:has-text("让她发来")');
  await goTo(p, '/chat/chat-suwan');
  await p.waitForSelector('text=今天把伞借出去了', { timeout: 5000 });
  check('sidestory hook delivered as a message', true);

  // —— 备用连接：中转坏了改用 DeepSeek ——
  await goTo(p, '/me/api');
  await editConnection(p, '中转站 A', { url: `${FAKE}/broken/v1` });
  await goTo(p, '/chat/chat-suwan');
  await p.fill('textarea', '再说一遍');
  await p.click('[aria-label="发送"]');
  const toast = await p.waitForSelector('.van-toast:has-text("改用")', { timeout: 15000 }).then((t) => t.textContent()).catch(() => '');
  check('failover toast shown', toast.includes('中转站 A 失败，改用 DeepSeek 官方'), toast);
  await p.waitForTimeout(2500);
  log = await fakeLog();
  const fallbackReq = log.filter((r) => r.path === '/v1/chat/completions' && r.body?.messages?.some((m) => m.content.includes('再说一遍'))).at(-1);
  check('fallback request used the fallback model', fallbackReq && fallbackReq.body.model === 'deepseek-chat');

  // —— 两个都失败：气泡下显示原因 ——
  await goTo(p, '/me/api');
  await editConnection(p, 'DeepSeek 官方', { key: 'sk-wrong' });
  await goTo(p, '/chat/chat-suwan');
  await p.fill('textarea', '还在吗');
  await p.click('[aria-label="发送"]');
  await p.waitForSelector('.err', { timeout: 15000 });
  const err = await p.textContent('.err');
  check('error explains both failures', /502/.test(err) && /备用连接也失败了/.test(err) && /401/.test(err), err.replace(/\n/g, ' | '));
  await shot(p, '6-chat-error');

  // —— 刷新后设置和 Key 还在 ——
  await p.reload();
  await goTo(p, '/me/api');
  await p.waitForSelector('button.conn');
  const relayCard = await p.textContent('button.conn:has-text("中转站 A")');
  check('settings persisted across reload', relayCard.includes('/broken/v1') && relayCard.includes('Key 在本机'), relayCard.replace(/\s+/g, ' ').slice(0, 120));
  check('agent routing still live after reload', (await p.textContent('[data-role="tts"] .live-line')).includes('已接通'));

  check('no page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
  await browser.close();
  fake.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
