/**
 * 逐页截图 + 检查（用环境里预装的 Playwright：只能 require，所以是 .cjs）。
 *
 *   BASE=http://127.0.0.1:4173/ node scripts/shots.cjs [名字过滤] [--light]
 *
 * 检查项：页面报错、控制台错误、对外网络请求、横向溢出、是否被重定向到别的页面。
 * 截图写到 ../../screenshots（已在 .gitignore 里）。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

/** 测试用的"照片"（晚霞渐变），给聊天背景上传用；运行时生成，不放进仓库 */
const PHOTO = path.join(os.tmpdir(), 'ai-mobile-test-photo.png');
async function makePhoto(browser) {
  const p = await browser.newPage({ viewport: { width: 600, height: 1000 } });
  await p.setContent(
    '<body style="margin:0"><div style="width:600px;height:1000px;background:radial-gradient(circle at 25% 30%,rgba(255,230,190,.9) 0 50px,transparent 52px),radial-gradient(circle at 70% 60%,rgba(255,200,230,.5) 0 80px,transparent 82px),linear-gradient(170deg,#ffb38a,#f78fb3 35%,#7b6fd6 70%,#2c3e7a)"></div></body>',
  );
  await p.screenshot({ path: PHOTO });
  await p.close();
}
/** 在当前页面里跳到另一个路由（hash 路由，不刷新页面） */
async function goTo(p, route) {
  await p.evaluate((r) => (location.hash = `#${r}`), route);
  await p.waitForTimeout(500);
}

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
  ['map-activity', '/map', async (p) => p.click('.act >> nth=0')],
  ['map-activity-date', '/map', async (p) => p.click('.act >> nth=5')],
  ['map-jiangyu', '/map?world=jiangyu'],
  ['map-me', '/map?world=me'],
  ['map-me-place', '/map?world=me', async (p) => p.click('[data-place="real:cafe"]')],
  ['scene-exercise', '/scene/exercise'],
  ['scene-meal', '/scene/meal'],
  ['scene-study', '/scene/study'],
  ['scene-sleep', '/scene/sleep'],
  ['scene-music', '/scene/music'],
  ['scene-date', '/scene/date'],
  ['scene-date-aquarium', '/scene/date?at=aquarium'],
  ['scene-study-cafe', '/scene/study?at=cafe'],
  ['scene-study-visit', '/scene/study?at=library&how=visit'],
  ['scene-meal-real', '/scene/meal?at=real:ramen'],
  ['map-me-footprints', '/map?world=me', async (p) => p.$eval('.page-scroll', (el) => el.scrollTo(0, el.scrollHeight))],
  ['scene-poke', '/scene/poke'],
  ['call', '/call/suwan'],
  ['call-incoming', '/call/suwan?incoming=1'],
  ['memories-timeline', '/memories'],
  ['memories-diary', '/memories?tab=diary'],
  ['memories-album', '/memories?tab=album'],
  ['memories-book', '/memories?tab=book'],
  ['memories-jiangyu', '/memories?char=jiangyu'],
  ['memories-jiangyu-diary', '/memories?char=jiangyu&tab=diary'],
  ['me', '/me'],
  ['characters', '/me/characters'],
  ['character-edit', '/me/characters/suwan'],
  ['personas', '/me/personas'],
  ['lorebooks', '/me/lorebooks'],
  ['lorebook-edit', '/me/lorebooks/lb-suwan'],
  ['presets', '/me/presets'],
  ['preset-edit', '/me/presets/preset-daily'],
  ['api', '/me/api'],
  ['api-main', '/me/api', async (p) => p.click('[data-role="main"] button >> nth=0')],
  ['install', '/me/install'],
  ['voice', '/me/voice'],
  ['proactive', '/me/proactive'],
  ['environment', '/me/environment'],
  ['sync', '/me/sync'],
  ['appearance', '/me/appearance'],
  [
    'appearance-split',
    '/me/appearance',
    async (p) => {
      await p.click('[data-palette="pink"]');
      await p.click('.van-switch');
      await p.click('[aria-label="夜里配色 森绿"]');
      await p.$eval('.page-scroll', (el) => el.scrollTo(0, 0));
    },
  ],
  [
    'chat-wallpaper',
    '/chat/chat-suwan',
    async (p) => {
      await goTo(p, '/me/appearance');
      await p.click('[data-palette="blue"]');
      await p.setInputFiles('.wall-editor input[type=file]', PHOTO);
      await p.setInputFiles('[data-upload="persona-me"] input[type=file]', PHOTO);
      await p.waitForTimeout(400);
      await goTo(p, '/chat/chat-suwan');
    },
  ],
  ['import', '/import'],
  ['import-card', '/import', async (p) => p.click('.pick-btn >> nth=0')],
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  await makePhoto(browser);
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: light ? 'light' : 'dark',
  });
  // 每张截图都从干净的本机设置开始（外观里换的配色、上传的图不会带到下一张）
  await ctx.addInitScript(() => {
    try {
      localStorage.clear();
    } catch {
      // 忽略
    }
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
