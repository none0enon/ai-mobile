/**
 * 逐页截图 + 检查（用环境里预装的 Playwright：只能 require，所以是 .cjs）。
 *
 *   BASE=http://127.0.0.1:4173/ node scripts/shots.cjs [名字过滤] [--light]
 *
 * 检查项：页面报错、控制台错误、对外网络请求、横向溢出、是否被重定向到别的页面。
 * 截图写到 ../../screenshots（已在 .gitignore 里）。
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://127.0.0.1:4173/';
const OUT = path.resolve(__dirname, '../../../screenshots');
const args = process.argv.slice(2);
const light = args.includes('--light');
const filter = args.find((a) => !a.startsWith('--'));

/** [名字, 路由, 截图前的操作] */
const SHOTS = [
  ['chats', '/chats'],
  ['chat-im', '/chat/chat-suwan'],
  ['chat-plus', '/chat/chat-suwan', async (p) => p.click('[aria-label="更多"] >> nth=-1').catch(() => p.click('.composer [aria-label="更多"]'))],
  [
    'chat-stream',
    '/chat/chat-suwan',
    async (p) => {
      await p.fill('textarea', '今天论文写得好累');
      await p.click('[aria-label="发送"]');
      await p.waitForTimeout(1500);
    },
  ],
  ['chat-stage', '/chat/chat-suwan?mode=stage'],
  [
    'chat-stage-poke',
    '/chat/chat-suwan?mode=stage',
    async (p) => {
      const box = await p.locator('[data-zone="head"]').boundingBox();
      if (box) await p.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await p.waitForTimeout(400);
    },
  ],
  ['inspect', '/chat/chat-suwan/inspect'],
  ['map', '/map'],
  ['map-sheet', '/map', async (p) => p.click('[data-loc="library"]')],
  ['map-char', '/map', async (p) => p.click('.who >> nth=0')],
  ['scene-exercise', '/scene/exercise'],
  ['scene-meal', '/scene/meal'],
  ['scene-study', '/scene/study'],
  ['scene-sleep', '/scene/sleep'],
  ['scene-music', '/scene/music'],
  ['scene-date', '/scene/date'],
  ['scene-date-aquarium', '/scene/date?at=aquarium'],
  ['scene-study-cafe', '/scene/study?at=cafe'],
  ['scene-poke', '/scene/poke'],
  ['call', '/call/suwan'],
  ['call-incoming', '/call/suwan?incoming=1'],
  ['memories-timeline', '/memories'],
  ['memories-diary', '/memories?tab=diary'],
  ['memories-album', '/memories?tab=album'],
  ['memories-book', '/memories?tab=book'],
  ['me', '/me'],
  ['characters', '/me/characters'],
  ['character-edit', '/me/characters/suwan'],
  ['personas', '/me/personas'],
  ['lorebooks', '/me/lorebooks'],
  ['lorebook-edit', '/me/lorebooks/lb-suwan'],
  ['presets', '/me/presets'],
  ['preset-edit', '/me/presets/preset-daily'],
  ['api', '/me/api'],
  ['voice', '/me/voice'],
  ['proactive', '/me/proactive'],
  ['environment', '/me/environment'],
  ['sync', '/me/sync'],
  ['appearance', '/me/appearance'],
  ['import', '/import'],
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: light ? 'light' : 'dark',
  });
  const problems = [];
  let count = 0;
  for (const [name, route, action] of SHOTS) {
    if (filter && !name.includes(filter)) continue;
    const page = await ctx.newPage();
    await page.clock.setFixedTime(new Date('2026-11-09T21:30:00+08:00'));
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (!['127.0.0.1', 'localhost'].includes(u.hostname) && !['data:', 'blob:'].includes(u.protocol)) errors.push(`external request: ${r.url()}`);
    });
    await page.goto(`${BASE}?shot=${name}#${route}`);
    await page.waitForSelector('[data-page]', { timeout: 8000 }).catch(() => errors.push('no [data-page] root'));
    await page.waitForTimeout(500);
    if (action) await action(page).catch((e) => errors.push(`action failed: ${e.message}`));
    await page.waitForTimeout(400);
    const info = await page.evaluate(() => {
      const overflow = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth;
      const wide = [...document.querySelectorAll('.page-scroll, .page')].filter((el) => el.scrollWidth - el.clientWidth > 1).map((el) => el.className);
      return { overflow, wide, hash: location.hash, page: document.querySelector('[data-page]')?.getAttribute('data-page') };
    });
    if (info.overflow > 1) errors.push(`horizontal overflow ${info.overflow}px`);
    if (info.wide.length) errors.push(`scroll container wider than viewport: ${info.wide.join(' | ')}`);
    if (!info.hash.startsWith(`#${route.split('?')[0]}`)) errors.push(`redirected to ${info.hash}`);
    const file = path.join(OUT, `${name}${light ? '-light' : ''}.png`);
    await page.screenshot({ path: file });
    count += 1;
    if (errors.length) problems.push(`${name} (${info.page}): ${errors.join('; ')}`);
    await page.close();
  }
  await browser.close();
  console.log(`screenshots: ${count} → ${OUT}`);
  if (problems.length) {
    console.log(`problems (${problems.length}):\n- ${problems.join('\n- ')}`);
    process.exitCode = 1;
  } else {
    console.log('no problems found');
  }
})();
