import { expect, test, type Page } from '@playwright/test';

// 每个测试使用独立浏览器上下文；只写测试凭据，不接触真实浏览器的数据。
async function fixturePage(page: Page) {
  await page.route('**/__storage_fixture', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Storage fixture</title>' }));
  await page.goto('/__storage_fixture');
}

async function seed(page: Page, version = 5, keepOpen = false) {
  await fixturePage(page);
  await page.evaluate(async ({ version, keepOpen }) => {
    const { characters } = await import('/src/mock/characters.ts');
    const { buildChats, buildMessages } = await import('/src/mock/chats.ts');
    const messages = buildMessages(), chats = buildChats(messages);
    const character = { ...characters[0], name: '升级前的角色', proactive: { ...characters[0].proactive, enabled: false } };
    const chat = { ...chats[0], summaries: [] };
    const message = { ...messages[chat.id][0], text: '升级前的聊天记录', parts: [{ type: 'text', text: '升级前的聊天记录' }] };
    const stores = ['characters', 'lorebooks', 'presets', 'chats', 'messages', 'settings', 'secrets', 'assets', 'books', 'rhythm', 'gallery'];
    if (version >= 5) stores.push('memories', 'slices', 'summaries', 'profiles');
    if (version >= 6) stores.push('live2d');
    if (version > 6) stores.push('future');
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('ai-mobile', version);
      req.onupgradeneeded = () => stores.forEach((name) => req.result.createObjectStore(name));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const tx = db.transaction(stores, 'readwrite');
    tx.objectStore('characters').put(character, character.id);
    tx.objectStore('chats').put(chat, chat.id);
    tx.objectStore('messages').put([message], chat.id);
    tx.objectStore('settings').put([{ role: 'main', api: { channel: 'custom', baseUrl: 'https://api.example.test', model: 'saved-model', models: [] } }], 'apiFeatures');
    tx.objectStore('settings').put({ netease: { workerUrl: 'https://music.example.test', quality: 'hires', volume: 0.4 }, weather: { qweatherHost: 'weather.example.test' } }, 'services');
    for (const key of ['api:main', 'api:tts', 'svc:google-maps', 'svc:qweather', 'svc:netease-cookie', 'hub:token']) tx.objectStore('secrets').put(`test-${key}`, key);
    tx.objectStore('assets').put({ mime: 'text/plain', data: new TextEncoder().encode('saved-image').buffer, createdAt: 1 }, 'test-asset');
    tx.objectStore('settings').put(true, 'memorySeeded');
    if (version > 6) tx.objectStore('future').put('untouched', 'sentinel');
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
    if (keepOpen) (window as any).__oldDatabase = db;
    else db.close();
  }, { version, keepOpen });
}

async function expectHydrated(page: Page) {
  await expect.poll(() => page.evaluate(async () => (await import('/src/startup.ts')).startup.ready)).toBe(true);
  expect(await page.evaluate(async () => {
    const { useAiStore } = await import('/src/stores/ai.ts');
    const { useServicesStore } = await import('/src/stores/services.ts');
    const { useCharacterStore } = await import('/src/stores/characters.ts');
    const { useChatStore } = await import('/src/stores/chat.ts');
    const { getOne } = await import('/src/db/idb.ts');
    const ai = useAiStore(), services = useServicesStore();
    return {
      api: ai.keyOf('api:main'), tts: ai.keyOf('api:tts'), model: ai.routeOf('main').api?.model,
      maps: services.mapsKey, weather: services.qweatherKey, cookie: services.neteaseCookie,
      music: services.netease.workerUrl,
      character: useCharacterStore().byId('suwan')?.name,
      message: useChatStore().list('chat-suwan')[0]?.text,
      asset: new TextDecoder().decode((await getOne<{ data: ArrayBuffer }>('assets', 'test-asset'))?.data),
    };
  })).toEqual({
    api: 'test-api:main', tts: 'test-api:tts', model: 'saved-model', maps: 'test-svc:google-maps',
    weather: 'test-svc:qweather', cookie: 'test-svc:netease-cookie', music: 'https://music.example.test',
    character: '升级前的角色', message: '升级前的聊天记录', asset: 'saved-image',
  });
}

async function reopen(page: Page) {
  await Promise.all([
    page.waitForEvent('domcontentloaded'),
    page.getByRole('button', { name: '重新打开' }).click(),
  ]);
}

for (const version of [4, 5, 7]) {
  test(`version ${version} retains keys, settings, characters, messages and assets across upgrade and reload`, async ({ page }) => {
    await seed(page, version);
    await page.goto('/#/me/api');
    await expectHydrated(page);
    await page.reload();
    await expectHydrated(page);
    const schema = await page.evaluate(() => new Promise<{ version: number; future: string | null }>((resolve) => {
      const req = indexedDB.open('ai-mobile');
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('future')) { resolve({ version: db.version, future: null }); db.close(); return; }
        const get = db.transaction('future').objectStore('future').get('sentinel');
        get.onsuccess = () => { resolve({ version: db.version, future: get.result }); db.close(); };
      };
    }));
    expect(schema).toEqual({ version: Math.max(version, 6), future: version > 6 ? 'untouched' : null });
  });
}

test('blocked upgrade waits for the old tab and resumes without empty-state edits or pagehide writes', async ({ page, context }) => {
  await seed(page, 5, true);
  const app = await context.newPage();
  await app.goto('/#/me/api');
  await expect(app.getByRole('heading', { name: '请先关闭其他 AI 陪伴页面' })).toBeVisible();
  // 超过以前 1.5 秒开放编辑、5 秒启动后台任务的超时。
  await app.waitForTimeout(5500);
  await app.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await expect(app.locator('input')).toHaveCount(0);
  expect(await app.evaluate(async () => (await import('/src/startup.ts')).startup.ready)).toBe(false);
  expect(await page.evaluate(() => new Promise((resolve) => {
    const req = (window as any).__oldDatabase.transaction('settings').objectStore('settings').get('apiFeatures');
    req.onsuccess = () => resolve(req.result[0].api.model);
  }))).toBe('saved-model');
  await page.close();
  await expectHydrated(app);
  await expect(app.getByRole('heading', { name: '请先关闭其他 AI 陪伴页面' })).toHaveCount(0);
});

test('open failure remains retryable and never mounts an editable empty app', async ({ page }) => {
  await seed(page);
  await page.addInitScript(() => {
    if (sessionStorage.getItem('storage-open-failed')) return;
    IDBFactory.prototype.open = () => {
      sessionStorage.setItem('storage-open-failed', 'yes');
      throw new DOMException('Test storage unavailable', 'SecurityError');
    };
  });
  await page.goto('/#/me/api');
  await expect(page.getByRole('heading', { name: '本机数据暂时无法读取' })).toBeVisible();
  await expect(page.locator('input')).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await reopen(page);
  await expectHydrated(page);
});

test('aborted reads do not initialize settings or keys from defaults', async ({ page }) => {
  await seed(page);
  await page.addInitScript(() => {
    if (sessionStorage.getItem('storage-read-failed')) return;
    const getAll = IDBObjectStore.prototype.getAll;
    IDBObjectStore.prototype.getAll = function (...args) {
      const req = getAll.apply(this, args);
      if (this.name === 'secrets') {
        sessionStorage.setItem('storage-read-failed', 'yes');
        this.transaction.abort();
      }
      return req;
    };
  });
  await page.goto('/#/me/api');
  await expect(page.getByRole('heading', { name: '本机数据暂时无法读取' })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await expect(page.locator('input')).toHaveCount(0);
  await reopen(page);
  await expectHydrated(page);
});

test('versionchange releases the connection and prevents the stale tab from writing', async ({ page, context }) => {
  await seed(page);
  await page.goto('/#/me/api');
  await expectHydrated(page);
  const updater = await context.newPage();
  await fixturePage(updater);
  await updater.evaluate(() => new Promise<void>((resolve, reject) => {
    const req = indexedDB.open('ai-mobile', 7);
    req.onupgradeneeded = () => req.result.createObjectStore('future');
    req.onsuccess = () => { req.result.close(); resolve(); };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Existing page did not release its database'));
  }));
  await expect(page.getByRole('heading', { name: 'App 已在其他页面更新' })).toBeVisible();
  expect(await page.evaluate(async () => (await import('/src/db/idb.ts')).write('secrets', [{ key: 'api:main', value: 'stale' }]))).toBe(false);
  await reopen(page);
  await expectHydrated(page);
});

test('failed opens can retry in the same page and aborted reads reject instead of returning empty', async ({ page }) => {
  await seed(page);
  expect(await page.evaluate(async () => {
    const db = await import('/src/db/idb.ts');
    const open = indexedDB.open.bind(indexedDB);
    indexedDB.open = () => { throw new DOMException('Test failure', 'UnknownError'); };
    const failed = await db.getAll('characters').then(() => false, () => true);
    indexedDB.open = open;
    const recovered = (await db.getAll('characters')).length;
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args) {
      const tx = transaction.apply(this, args);
      queueMicrotask(() => tx.abort());
      return tx;
    };
    const rejected = await Promise.all([
      db.getAll('characters'), db.getOne('secrets', 'api:main'), db.getEntries('secrets'),
    ].map((read) => read.then(() => false, () => true)));
    IDBDatabase.prototype.transaction = transaction;
    return { failed, recovered, rejected };
  })).toEqual({ failed: true, recovered: 1, rejected: [true, true, true] });
});

test('autosave pauses through hydration and retries failed puts/deletes without serializing flushes', async ({ page }) => {
  await seed(page);
  expect(await page.evaluate(async () => {
    const { autoSave, getOne, write } = await import('/src/db/idb.ts');
    let rows = [{ key: 'autosave-test', value: 'default' }];
    const saver = autoSave('settings', () => rows, () => rows);
    window.dispatchEvent(new Event('pagehide'));
    await saver.flush();
    const beforeStart = await getOne('settings', 'autosave-test');
    await write('settings', [{ key: 'autosave-test', value: 'saved' }]);
    rows[0].value = 'saved';
    saver.start();
    const failNextWrite = () => {
      const transaction = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (...args) {
        const tx = transaction.apply(this, args);
        if (args[1] === 'readwrite') {
          IDBDatabase.prototype.transaction = transaction;
          queueMicrotask(() => tx.abort());
        }
        return tx;
      };
    };
    rows[0].value = 'edited';
    failNextWrite();
    await saver.flush();
    const failedPut = await getOne('settings', 'autosave-test');
    await saver.flush();
    const retriedPut = await getOne('settings', 'autosave-test');
    rows = [];
    failNextWrite();
    await saver.flush();
    const failedDelete = await getOne('settings', 'autosave-test');
    await saver.flush();
    const retriedDelete = await getOne('settings', 'autosave-test');
    rows = [{ key: 'autosave-test', value: 'base' }];
    await saver.flush();
    rows = [{ key: 'autosave-test', value: 'temporary' }, { key: 'temporary-key', value: 'temporary' }];
    const first = saver.flush();
    rows = [{ key: 'autosave-test', value: 'base' }];
    const second = saver.flush();
    await Promise.all([first, second]);
    return {
      beforeStart, failedPut, retriedPut, failedDelete, retriedDelete,
      reverted: await getOne('settings', 'autosave-test'), removed: await getOne('settings', 'temporary-key'),
    };
  })).toEqual({ beforeStart: undefined, failedPut: 'saved', retriedPut: 'edited', failedDelete: 'edited', retriedDelete: undefined, reverted: 'base', removed: undefined });
});
