import { test, expect, type Page } from '@playwright/test';

const fixture = process.env.LIVE2D_TEST_ZIP;
const genericFolder = process.env.LIVE2D_TEST_FOLDER;
function speechFixture() {
  const samples = 24000 * 4;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) wav.writeInt16LE(i >= 24000 && i < 48000 ? 0 : Math.round(Math.sin(i * 2 * Math.PI * 220 / 24000) * 16000), 44 + i * 2);
  return wav;
}
async function snapshot(page: Page) {
  return page.getByTestId('live2d-avatar').evaluate((el: any) => el.__vueParentComponent.exposed.snapshot());
}
async function expectGrounded(page: Page) {
  const state = await snapshot(page);
  expect(state.bounds.bottom * state.fit.y + state.fit.ty).toBeCloseTo(-1, 5);
  expect(state.fit.x * state.viewport.width).toBeCloseTo(state.fit.y * state.viewport.height, 5);
  // Check actual rendered pixels as well as projection: blank canvas margins must disappear.
  const pixels = await page.locator('.live2d-avatar canvas').evaluate(async (canvas: HTMLCanvasElement) => {
    await new Promise(requestAnimationFrame);
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    const data = new Uint8Array(canvas.width * canvas.height * 4);
    gl!.readPixels(0, 0, canvas.width, canvas.height, gl!.RGBA, gl!.UNSIGNED_BYTE, data);
    let bottom = canvas.height, top = 0;
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
      if (data[(y * canvas.width + x) * 4 + 3]! > 24) { bottom = Math.min(bottom, y); top = Math.max(top, y); }
    }
    return { bottom, top, height: canvas.height };
  });
  expect(pixels.bottom).toBeLessThan(Math.max(12, pixels.height * 0.04));
  expect(pixels.top - pixels.bottom).toBeGreaterThan(pixels.height * 0.4);
}

test('standard Cubism model imports as a folder and stays closed during idle motions', async ({ page }, testInfo) => {
  test.skip(!genericFolder, 'Set LIVE2D_TEST_FOLDER to an official SDK model folder');
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/#/me/characters/jiangyu?tab=live2d');
  await page.getByLabel('上传 Live2D 文件夹').setInputFiles(genericFolder!);
  await expect(page.getByTestId('live2d-avatar')).toHaveAttribute('data-state', 'ready', { timeout: 60000 });
  expect((await snapshot(page)).parameters.ParamGestureLive).toBeUndefined();
  expect((await snapshot(page)).parameters.ParamMouthOpenY).toBe(0);
  await expectGrounded(page);
  await expect(page.getByLabel('默认衣着')).toHaveValue('model-default');
  await page.setViewportSize({ width: 844, height: 390 });
  await expectGrounded(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('generic-model.png'), fullPage: true });
  await page.locator('.live2d-avatar canvas').evaluate((canvas: HTMLCanvasElement) => canvas.getContext('webgl2')!.getExtension('WEBGL_lose_context')!.loseContext());
  await expect(page.getByTestId('live2d-avatar')).toHaveAttribute('data-state', 'error');
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.getByTestId('live2d-avatar')).toHaveAttribute('data-state', 'ready');
  await page.getByRole('button', { name: '移除 Live2D 模型', exact: true }).click();
  await expect(page.getByTestId('live2d-avatar')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: '上传 ZIP 模型', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('built single-file preview loads Cubism after Core and renders a model', async ({ page }) => {
  const preview = process.env.LIVE2D_PREVIEW_URL;
  test.skip(!preview || !genericFolder, 'Requires a running built preview and LIVE2D_TEST_FOLDER');
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(preview!);
  await page.locator('a[href^="/chat/"]').first().click();
  await page.getByRole('link', { name: '角色设定', exact: true }).click();
  await page.getByRole('tab', { name: 'Live2D', exact: true }).click();
  await page.getByLabel('上传 Live2D 文件夹').setInputFiles(genericFolder!);
  await expect(page.getByTestId('live2d-avatar')).toHaveAttribute('data-state', 'ready', { timeout: 60000 });
  expect(errors).toEqual([]);
});

test('Madara ZIP → persisted character preview → rhythm video → hangup', async ({ page }, testInfo) => {
  test.skip(!fixture, 'Set LIVE2D_TEST_ZIP to the full Madara v19 ZIP');
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') console.log('Browser:', message.text()); });
  await page.goto('/#/me/characters/suwan?tab=live2d');
  await page.getByTestId('live2d-upload').setInputFiles(fixture!);
  await expect(page.getByTestId('live2d-avatar')).toBeVisible({ timeout: 120000 });
  const error = await page.getByTestId('live2d-avatar').getAttribute('data-state');
  if (error === 'error') throw new Error(await page.getByTestId('live2d-avatar').innerText());
  await expect(page.getByTestId('live2d-avatar')).toHaveAttribute('data-state', 'ready', { timeout: 120000 });
  expect((await snapshot(page)).parameters.ParamMouthOpenY).toBe(0);
  // The 426 MB source ZIP includes editor/art history. Only referenced runtime files persist.
  await expect(page.locator('.model-info')).toContainText('134.0 MB');
  await expectGrounded(page);
  await page.getByLabel('默认衣着').selectOption('clan');
  await expect.poll(async () => (await snapshot(page)).outfit).toBe('clan');
  await expect.poll(async () => (await snapshot(page)).parameters.ParamOutfitPose).toBe(3);
  await expectGrounded(page);
  await page.getByLabel('人物大小').fill('110');
  expect((await snapshot(page)).bounds.bottom * (await snapshot(page)).fit.y + (await snapshot(page)).fit.ty).toBeCloseTo(-1, 5);
  const blink = await page.getByTestId('live2d-avatar').evaluate(async (el: any) => {
    const values: number[] = [];
    const end = performance.now() + 6500;
    while (performance.now() < end) {
      values.push(el.__vueParentComponent.exposed.snapshot().parameters.ParamEyeLOpen);
      await new Promise(requestAnimationFrame);
    }
    return { min: Math.min(...values), max: Math.max(...values) };
  });
  expect(blink.min).toBeLessThan(0.2);
  expect(blink.max).toBeGreaterThan(0.8);
  await page.getByLabel('预览表情').selectOption('angry');
  await expect.poll(async () => (await snapshot(page)).parameters.ParamGestureFold).toBeGreaterThan(0.8);
  expect((await snapshot(page)).expression).toBe('angry');
  expect((await snapshot(page)).parameters.ParamOutfitPose).toBe(5);
  await page.getByRole('button', { name: '挥手', exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).parameters.ParamGestureRaise).toBeGreaterThan(0.8);
  expect((await snapshot(page)).parameters.ParamOutfitPose).toBe(4);
  await page.getByLabel('预览表情').selectOption('smile');
  await expect.poll(async () => (await snapshot(page)).expression).toBe('smirk');
  await page.locator('summary').filter({ hasText: '表情与动作映射' }).click();
  await page.getByLabel('微笑动作映射').selectOption('Gesture:1');
  await expect.poll(async () => (await snapshot(page)).parameters.ParamGestureFold).toBeGreaterThan(0.8);
  await page.getByLabel('微笑动作映射').selectOption('');
  await page.locator('summary').filter({ hasText: '表情与动作映射' }).click();
  await page.locator('.preview').evaluate(el => el.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: testInfo.outputPath('model-preview.png'), fullPage: true });
  await page.reload();
  await expect(page.getByTestId('live2d-avatar')).toHaveAttribute('data-state', 'ready', { timeout: 60000 });
  await expect(page.getByLabel('默认衣着')).toHaveValue('clan');
  await expect(page.getByLabel('人物大小')).toHaveValue('110');
  await page.getByRole('button', { name: '恢复自动比例' }).click();
  await page.getByLabel('预览衣着').selectOption('armour');
  await expect.poll(async () => (await snapshot(page)).parameters.ParamOutfitPose).toBe(0);
  await expect(page.getByLabel('默认衣着')).toHaveValue('clan');
  await page.getByLabel('预览衣着').selectOption('');
  await expect.poll(async () => (await snapshot(page)).parameters.ParamOutfitPose).toBe(3);
  await page.evaluate(async () => {
    const { useRhythmStore } = await import('/src/stores/rhythm.ts');
    const { useVoiceStore } = await import('/src/stores/voice.ts');
    const { useCharacterStore } = await import('/src/stores/characters.ts');
    useVoiceStore().call.input = 'type';
    useCharacterStore().byId('suwan')!.name = '宇智波斑';
    const day = useRhythmStore().editToday('suwan')!;
    day.schedule = [{ from: '00:00', to: '24:00', locationId: 'library', status: '在图书馆读书' }];
    day.outfits.daily = { name: '铠甲', tags: 'red_armor' };
  });
  await page.getByRole('link', { name: '开始视频通话' }).click();
  await expect(page.locator('[data-page="video-call"]')).toBeVisible();
  await expect(page.getByTestId('live2d-avatar')).toHaveAttribute('data-state', 'ready', { timeout: 60000 });
  expect((await snapshot(page)).parameters.ParamMouthOpenY).toBe(0);
  await expect(page.locator('[data-page="video-call"]')).toHaveAttribute('data-backdrop', 'library');
  await expect.poll(async () => (await snapshot(page)).outfit).toBe('armour');
  await expectGrounded(page);
  await page.evaluate(async () => {
    const { useRhythmStore } = await import('/src/stores/rhythm.ts');
    useRhythmStore().editToday('suwan')!.outfits.daily = { name: '校服', tags: 'school_uniform' };
  });
  await expect.poll(async () => (await snapshot(page)).outfit).toBe('clan');
  await expectGrounded(page);
  // Exercise the real chat -> SentenceStream -> TTS -> <audio> -> avatar chain with local API fixtures.
  let reply = '[expr:angry]不行，我不同意。';
  let failTts = false;
  await page.route('**/test-api/v1/chat/completions', route => route.fulfill({
    status: 200, contentType: 'text/event-stream',
    body: `data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\ndata: [DONE]\n\n`,
  }));
  await page.route('**/test-api/v1/audio/speech', route => route.fulfill(failTts
    ? { status: 400, contentType: 'application/json', body: JSON.stringify({ error: { message: 'test TTS failure' } }) }
    : { status: 200, contentType: 'audio/wav', body: speechFixture() }));
  await page.evaluate(async () => {
    const { useAiStore } = await import('/src/stores/ai.ts');
    const { useCharacterStore } = await import('/src/stores/characters.ts');
    const ai = useAiStore();
    for (const role of ['main', 'tts'] as const) ai.saveRoute({
      role, runsOn: 'device', backup: null,
      api: { channel: 'custom', format: 'openai', baseUrl: `${location.origin}/test-api/v1`, model: 'test', models: [] },
    });
    const c = useCharacterStore().byId('suwan')!;
    c.voice.voiceId = 'test'; c.voice.model = 'test';
    const original = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () { (window as any).__live2dTestAudio = this; return original.call(this); };
  });
  await page.getByLabel('打字说话').fill('请回答');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).parameters.ParamMouthOpenY).toBeGreaterThan(0.3);
  expect((await snapshot(page)).expression).toBe('angry');
  expect((await snapshot(page)).parameters.ParamOutfitPose).toBe(5);
  const lipSamples = await page.getByTestId('live2d-avatar').evaluate(async (el: any) => {
    const samples: { time: number; mouth: number }[] = [];
    const end = performance.now() + 3000;
    while (performance.now() < end) {
      samples.push({ time: (window as any).__live2dTestAudio.currentTime, mouth: el.__vueParentComponent.exposed.snapshot().parameters.ParamMouthOpenY });
      await new Promise(requestAnimationFrame);
    }
    return samples;
  });
  const silence = lipSamples.filter(s => s.time > 1.2 && s.time < 1.8);
  expect(silence.length).toBeGreaterThan(2);
  expect(silence.every(s => s.mouth === 0)).toBe(true);
  expect(lipSamples.some(s => s.time > 2.2 && s.mouth > 0.3)).toBe(true);
  await expect.poll(async () => (await snapshot(page)).parameters.ParamMouthOpenY).toBe(0);
  await expect(page.getByTestId('call-status')).toContainText('打字');
  await page.screenshot({ path: testInfo.outputPath('video-call.png'), fullPage: true });
  await page.setViewportSize({ width: 844, height: 390 });
  await expectGrounded(page);
  await page.setViewportSize({ width: 390, height: 844 });
  // Failed synthesis still shows captions but must never animate a speaking mouth.
  failTts = true;
  reply = '[expr:smile]好的，这一次只有字幕，没有声音。';
  await page.getByLabel('打字说话').fill('测试没有声音');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.issues')).toContainText('语音合成失败');
  const silentMouth = await page.getByTestId('live2d-avatar').evaluate(async (el: any) => {
    let max = 0;
    const end = performance.now() + 800;
    while (performance.now() < end) { max = Math.max(max, el.__vueParentComponent.exposed.snapshot().parameters.ParamMouthOpenY); await new Promise(requestAnimationFrame); }
    return max;
  });
  expect(silentMouth).toBe(0);
  await page.evaluate(async () => {
    const { useRhythmStore } = await import('/src/stores/rhythm.ts');
    const day = useRhythmStore().editToday('suwan')!;
    day.schedule = [{ from: '00:00', to: '24:00', locationId: 'cafe', status: '约会中' }];
    day.outfits.date = { name: '约会战甲', tags: 'armor' };
  });
  await expect(page.locator('[data-page="video-call"]')).toHaveAttribute('data-backdrop', 'cafe');
  await expect.poll(async () => (await snapshot(page)).outfit).toBe('armour');
  await page.getByTestId('toggle-video').click();
  await expect(page.getByTestId('live2d-avatar')).toHaveCount(0);
  await page.getByTestId('toggle-video').click();
  await expect(page.getByTestId('live2d-avatar')).toHaveAttribute('data-state', 'ready', { timeout: 60000 });
  failTts = false;
  reply = '[expr:smile]你好，这一句可以打断。';
  await page.getByLabel('打字说话').fill('继续说话');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).parameters.ParamMouthOpenY).toBeGreaterThan(0.3);
  await page.getByTestId('hangup').click();
  expect(await page.evaluate(() => (window as any).__live2dTestAudio.paused)).toBe(true);
  await expect(page).toHaveURL(/\/chat\//);
  await expect(page.getByText('视频通话', { exact: false }).last()).toBeVisible();
  expect(errors).toEqual([]);
});
