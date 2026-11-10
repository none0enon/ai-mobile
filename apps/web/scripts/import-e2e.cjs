/**
 * 端到端检查：在真实页面里导入 SillyTavern 预设 + 角色卡（JSON 和 PNG），发一条消息，核对"查看提示词"。
 * 用的是 packages/shared/test/fixtures 里的三个文件。
 *
 *   cd apps/web && npx vite preview --port 4173 &
 *   node scripts/import-e2e.cjs            # 截图写到 ../../screenshots/import-*.png
 *
 * 出错时以非 0 退出。
 */
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://127.0.0.1:4173/';
const FX = path.resolve(__dirname, '../../../packages/shared/test/fixtures');
const OUT = path.resolve(__dirname, '../../../screenshots');
fs.mkdirSync(OUT, { recursive: true });

const errors = [];

async function shot(page, name) {
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(OUT, `import-${name}.png`) });
}

async function importFile(page, kind, file) {
  await page.setInputFiles(`[data-kind="${kind}"] input[type=file]`, path.join(FX, file));
  await page.waitForSelector('[data-testid="import-result"]');
}

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'dark' });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));

  await page.goto(`${BASE}#/import`);
  await page.waitForSelector('[data-kind="preset"]');

  // 1. 预设
  await importFile(page, 'preset', 'preset-code.json');
  const presetText = await page.textContent('[data-testid="import-result"]');
  assert.match(presetText, /Chat Completion 预设/);
  assert.match(presetText, /100001/);
  assert.match(presetText, /\[Analysis and start coding\]/);
  await shot(page, '1-preset-read');
  await page.click('[data-testid="import-result"] .van-button');
  await page.waitForSelector('[data-testid="import-done"]');
  assert.match(await page.textContent('[data-testid="import-done"]'), /preset-code/);

  // 2. 角色卡 JSON
  await importFile(page, 'card', 'card-claude.json');
  const cardText = await page.textContent('[data-testid="import-result"]');
  assert.match(cardText, /V3 角色卡（读的是JSON 文件）/);
  assert.match(cardText, /内嵌世界书「小克 \(1\)」3 条/);
  // 默认选中刚导入的预设
  assert.equal((await page.textContent('[data-testid="import-result"] .chip-btn.on'))?.trim(), 'preset-code');
  await shot(page, '2-card-json-read');
  await page.click('[data-testid="import-result"] .van-button');
  await page.waitForSelector('[data-testid="import-done"]');

  // 3. 角色卡 PNG
  await importFile(page, 'card', 'card-claude.png');
  const pngText = await page.textContent('[data-testid="import-result"]');
  assert.match(pngText, /PNG 里的 ccv3 块/);
  assert.match(pngText, /这张图会当头像/);
  await shot(page, '3-card-png-read');
  await page.click('[data-testid="import-result"] .van-button');
  await page.waitForSelector('[data-testid="import-done"]');
  await shot(page, '4-card-png-done');

  // 4. 去聊天：第一条是开场白"你好"，发一条消息
  await page.click('[data-testid="import-done"] a:has-text("去聊天")');
  await page.waitForSelector('textarea');
  await page.waitForTimeout(400);
  assert.match(await page.textContent('.page'), /你好/);
  await page.fill('textarea', '帮我写一个快速排序');
  await page.click('[aria-label="发送"]');
  await page.waitForFunction(() => document.body.innerText.includes('右上角 ⋯ → 查看提示词'), null, { timeout: 15000 });
  await page.waitForTimeout(600);
  await shot(page, '5-chat-sent');
  const chatUrl = page.url();

  // 5. 查看提示词：上一次实际发送的内容
  await page.goto(chatUrl.replace(/\?.*$/, '') + '/inspect');
  await page.waitForSelector('[data-testid="inspect-messages"]');
  const roles = await page.$$eval('[data-testid="inspect-messages"] .block', (els) => els.map((e) => e.getAttribute('data-role')));
  const labels = await page.$$eval('[data-testid="inspect-messages"] .block .head .font-600', (els) => els.map((e) => e.textContent.trim()));
  console.log('发送的消息：');
  labels.forEach((l, i) => console.log(`  ${i + 1}. [${roles[i]}] ${l}`));
  assert.deepEqual(roles, ['system', 'system', 'system', 'assistant', 'system', 'user', 'system']);
  assert.match(labels[0], /角色描述/);
  assert.match(labels[1], /new_chat_prompt/);
  assert.match(labels[2], /当前环境/);
  assert.match(labels[4], /当前场景规则/);
  assert.match(labels[6], /Post-History Instructions/);
  await shot(page, '6-inspect-messages');

  await page.click('[role="tab"]:has-text("预设块")');
  await shot(page, '7-inspect-blocks');
  await page.click('[role="tab"]:has-text("世界书")');
  const lore = await page.textContent('.page-scroll');
  assert.match(lore, /常驻/);
  assert.match(lore, /只在递归扫描时触发/);
  await shot(page, '8-inspect-lore');
  await page.click('[role="tab"]:has-text("请求体")');
  const body = JSON.parse(await page.textContent('[data-testid="inspect-request"]'));
  assert.equal(body.messages.length, 7);
  assert.equal(body.temperature, 1);
  assert.equal(body.max_tokens, 20000);
  assert.equal(body.messages[5].content, '帮我写一个快速排序');
  await shot(page, '9-inspect-request');

  // 6. 刷新：导入的东西和聊天都还在
  await page.goto(chatUrl);
  await page.reload();
  await page.waitForSelector('textarea');
  await page.waitForTimeout(500);
  assert.match(await page.textContent('.page'), /帮我写一个快速排序/);
  await page.goto(`${BASE}#/me/characters`);
  await page.waitForTimeout(500);
  const names = await page.$$eval('.card-c .text-\\[17px\\]', (els) => els.map((e) => e.textContent.trim()));
  assert.deepEqual(names.filter((n) => n === 'Claude').length, 2);
  await shot(page, '10-characters-after-reload');
  await page.goto(`${BASE}#/me/presets`);
  await page.waitForTimeout(400);
  assert.match(await page.textContent('.page'), /preset-code/);

  await browser.close();
  if (errors.length) {
    console.error('页面报错：\n' + errors.join('\n'));
    process.exit(1);
  }
  console.log('通过：预设、JSON 角色卡、PNG 角色卡都导入了；发送时拼出 7 条消息；刷新后数据还在。');
}

main().catch((e) => {
  console.error(e);
  if (errors.length) console.error('页面报错：\n' + errors.join('\n'));
  process.exit(1);
});
