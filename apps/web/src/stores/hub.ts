import { AGENT_META, apiKeyId, DEFAULT_PROACTIVE_RULES, type HubInbox, type HubMemoryResults, type HubMoments, type HubStatus, type HubTouchpoint,
  type Character, type HubRhythms, type Message, type NotificationPreview, type ProactiveContext, type ProactiveCredentials } from '@app/shared';
import { defineStore } from 'pinia';
import { computed, reactive, ref, watch } from 'vue';
import { getOne, write } from '@/db/idb';
import { applyMemoryOps, packConsolidation } from '@/services/consolidate';
import { alwaysOn, memoryBlock, summaryBlock } from '@/services/memoryBlocks';
import { personaOf } from '@/services/prompt';
import { homeBlock, lifeFlags } from '@/services/homeBlock';
import { settleSyncJobs } from '@/services/hubSync';
import { receiveHubMoments, socialCloudContext } from '@/services/social';
import { useAiStore } from './ai';
import { useAppStore } from './app';
import { useCharacterStore } from './characters';
import { useChatStore } from './chat';
import { useEnvironmentStore } from './environment';
import { useLibraryStore } from './library';
import { useMemoryStore } from './memory';
import { afterSummarized, lastN, useMessageSettingsStore } from './messageSettings';
import { useRhythmStore } from './rhythm';
import { useSocialStore } from './social';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
interface SavedHub {
  url: string; cursor: number; deviceId: string; active: boolean; preview: NotificationPreview;
  revisions: Record<string, number>; hashes: Record<string, string>; apiHash: string;
  rhythmRevisions: Record<string, number>; rhythmHashes: Record<string, string>; rhythmApiHash: string;
  /** 记忆整理：每个角色上传过的版本和内容指纹、API 指纹、已经应用到哪一次云端结果 */
  memoryRevisions?: Record<string, number>; memoryHashes?: Record<string, string>; memoryApiHash?: string; memoryAppliedAt?: number;
  /** 朋友圈：每个角色上传过的版本和内容指纹、API 指纹 */
  socialRevisions?: Record<string, number>; socialHashes?: Record<string, string>; socialApiHash?: string;
  lastSyncAt?: number;
}
export const useHubStore = defineStore('hub', () => {
  const config = reactive<SavedHub>({ url: '', cursor: 0, deviceId: '', active: false, preview: 'name-only', revisions: {}, hashes: {}, apiHash: '', rhythmRevisions: {}, rhythmHashes: {}, rhythmApiHash: '',
    memoryRevisions: {}, memoryHashes: {}, memoryApiHash: '', memoryAppliedAt: 0, socialRevisions: {}, socialHashes: {}, socialApiHash: '' });
  /** 云端没发出来的朋友圈（"云端与同步"、朋友圈设置里显示） */
  const socialErrors = ref<HubMoments['errors']>([]);
  /** 云端记忆整理失败的角色（"云端与同步"里显示） */
  const memoryErrors = ref<HubMemoryResults['errors']>([]);
  const token = ref('');
  const savedPassword = ref('');
  const connected = computed(() => !!config.url && !!token.value);
  const status = ref<HubStatus | null>(null);
  const points = ref<HubTouchpoint[]>([]);
  const lastSyncAt = ref<number | null>(null);
  const error = ref('');
  const supportsRhythm = computed(() => typeof status.value?.rhythmConfigured === 'boolean');
  const supportsMemory = computed(() => typeof status.value?.memoryConfigured === 'boolean');
  /** 旧版 Worker 没有朋友圈：不算"必须升级"，只是云端不会自动发 */
  const supportsSocial = computed(() => typeof status.value?.socialConfigured === 'boolean');
  const upgradeRequired = computed(() => !!status.value && (!supportsRhythm.value || !supportsMemory.value));
  const syncing = ref(false);
  let started = false;
  let connectionVersion = 0;
  const uploading = new Set<string>();
  const save = () => write('settings', [{ key: 'hub', value: clone(config) }]);

  async function request<T>(path: string, method = 'GET', data?: unknown): Promise<T> {
    const version = connectionVersion;
    const response = await fetch(`${config.url}${path}`, {
      method, headers: { Authorization: `Bearer ${token.value}`, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(30_000), cache: 'no-store',
    });
    const result = await response.json() as T & { error?: string };
    if (version !== connectionVersion) throw new Error('连接已切换');
    if (!response.ok) throw new Error(result.error || `Worker HTTP ${response.status}`);
    return result;
  }

  async function hydrate() {
    const [saved, secret, password] = await Promise.all([getOne<SavedHub>('settings', 'hub'), getOne<string>('secrets', 'hub:token'), getOne<string>('secrets', 'hub:password')]);
    if (saved) Object.assign(config, saved);
    token.value = secret ?? '';
    savedPassword.value = password ?? '';
    lastSyncAt.value = saved?.lastSyncAt ?? null;
  }

  async function connect(url: string, password: string) {
    if (syncing.value) throw new Error('正在同步，请稍后再连接');
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(parsed.hostname)) throw new Error('Worker 地址必须是 HTTPS');
    const base = parsed.origin;
    const response = await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }), signal: AbortSignal.timeout(30_000) });
    const result = await response.json() as { token: string; deviceId: string; error?: string };
    if (!response.ok) throw new Error(result.error || `登录失败 HTTP ${response.status}`);
    connectionVersion++;
    syncing.value = false;
    error.value = '';
    if (config.url !== base) Object.assign(config, { cursor: 0, active: false, revisions: {}, hashes: {}, apiHash: '', rhythmRevisions: {}, rhythmHashes: {}, rhythmApiHash: '',
      memoryRevisions: {}, memoryHashes: {}, memoryApiHash: '', memoryAppliedAt: 0, socialRevisions: {}, socialHashes: {}, socialApiHash: '', lastSyncAt: undefined });
    status.value = null; points.value = []; lastSyncAt.value = config.lastSyncAt ?? null;
    config.url = base;
    config.deviceId = result.deviceId;
    token.value = result.token;
    if (!await write('secrets', [{ key: 'hub:token', value: result.token }, { key: 'hub:password', value: password }])) throw new Error('无法保存登录信息，请允许浏览器存储');
    savedPassword.value = password;
    if (!await save()) throw new Error('无法保存连接地址，请允许浏览器存储');
    await resyncFromDevice();
  }

  /** Explicit recovery chooses this device's settings; ordinary sync never overwrites a revision conflict. */
  async function resyncFromDevice() {
    if (!connected.value || syncing.value) return;
    const version = connectionVersion;
    syncing.value = true;
    try {
      await refreshStatus();
      const jobs = [
        { label: '主动消息版本', run: async () => {
          const data = await request<{ contexts: { id: string; revision: number }[] }>('/v1/proactive/contexts');
          config.revisions = Object.fromEntries(data.contexts.map((c) => [c.id, c.revision]));
          config.hashes = {}; config.apiHash = '';
        } },
        ...(supportsRhythm.value ? [{ label: '节律版本', run: async () => {
          const data = await request<{ contexts: { id: string; revision: number }[] }>('/v1/rhythm/contexts');
          config.rhythmRevisions = Object.fromEntries(data.contexts.map((c) => [c.id, c.revision]));
          config.rhythmHashes = Object.fromEntries(Object.keys(config.rhythmHashes).map((id) => [id, '']));
          config.rhythmApiHash = '';
        } }] : []),
        ...(supportsMemory.value ? [{ label: '记忆版本', run: async () => {
          const data = await request<{ contexts: { id: string; revision: number }[] }>('/v1/memory/contexts');
          config.memoryRevisions = Object.fromEntries(data.contexts.map((c) => [c.id, c.revision]));
          config.memoryHashes = {}; config.memoryApiHash = '';
        } }] : []),
        ...(supportsSocial.value ? [{ label: '朋友圈版本', run: async () => {
          const data = await request<{ contexts: { id: string; revision: number }[] }>('/v1/social/contexts');
          config.socialRevisions = Object.fromEntries(data.contexts.map((c) => [c.id, c.revision]));
          config.socialHashes = Object.fromEntries(Object.keys(config.socialHashes ?? {}).map((id) => [id, '']));
          config.socialApiHash = '';
        } }] : []),
      ];
      await settleSyncJobs(jobs);
      if (!await save()) throw new Error('无法保存同步版本，请允许浏览器存储');
    } catch (e) {
      if (version === connectionVersion) error.value = e instanceof Error ? e.message : String(e);
      throw e;
    } finally { if (version === connectionVersion) syncing.value = false; }
    if (version === connectionVersion) await syncNow();
  }

  async function disconnect() {
    // Disconnect this device; the separate cloud switch controls scheduled generation.
    try { await request('/v1/auth/session', 'DELETE'); } catch { /* Local disconnect also works offline. */ }
    connectionVersion++;
    token.value = ''; status.value = null; points.value = []; lastSyncAt.value = null;
    config.active = false; config.deviceId = ''; error.value = ''; syncing.value = false;
    const [saved, removed] = await Promise.all([save(), write('secrets', [], ['hub:token'])]);
    if (!saved || !removed) throw new Error('已断开，但本机未能保存状态，请允许浏览器存储');
  }

  async function refreshStatus() {
    status.value = await request<HubStatus>('/v1/status');
    config.active = status.value.enabled;
  }

  async function hash(value: unknown): Promise<string> {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
    return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  /** 云端主动消息要的记忆：待跟进（排期）、置顶和到期的、最重要的 30 条 */
  function cloudMemories(characterId: string): ProactiveContext['memories'] {
    const mem = useMemoryStore();
    const active = mem.activeOf(characterId);
    const keep = new Map<string, (typeof active)[number]>();
    for (const m of active) if (m.type === 'followup' && m.dueAt) keep.set(m.id, m);
    for (const m of alwaysOn(characterId, Date.now())) keep.set(m.id, m);
    for (const m of [...active].sort((a, b) => b.importance - a.importance || b.updatedAt - a.updatedAt).slice(0, 30)) keep.set(m.id, m);
    return [...keep.values()].slice(0, 120).map(({ id, content, dueAt, type }) => ({ id, content, ...(dueAt ? { dueAt } : {}), type }));
  }

  /** 家务和健康：上传云端的那份（时间按半小时取整，免得每分钟都要重新上传）；主动消息预设里没有"她怎么反应"的块时带上自带的 */
  function homeSnapshot(persona: ReturnType<typeof personaOf>, character: Character): { home?: string } {
    const b = homeBlock(persona, { stepMin: 30, preset: useLibraryStore().presetForUse('proactive', character), characterName: character.name });
    return b ? { home: b.content } : {};
  }

  function contexts(): ProactiveContext[] {
    const chars = useCharacterStore();
    const chats = useChatStore();
    const lib = useLibraryStore();
    const msgSettings = useMessageSettingsStore();
    const timeZone = useEnvironmentStore().settings.timezone;
    return chars.list.flatMap((character) => {
      const chat = chats.chatOfCharacter(character.id);
      if (!chat || chats.streams[chat.id]) return [];
      // Local blob URLs / media are not useful to the server. Text, preset and lorebook stay intact.
      return [{ character: { ...character, avatar: null }, chat, persona: { ...personaOf(chat), avatar: null },
        preset: lib.presetForUse('proactive', character) ?? null,
        lorebooks: character.lorebookIds.map((id) => lib.lorebookById(id)).filter((b) => !!b),
        // 消息设置 → 发送条数、已总结的消息不发送：云端主动消息的上下文同样截取
        history: lastN(
          (msgSettings.settings.dropSummarized ? afterSummarized(chats.list(chat.id), chat.summaryUntilMessageId) : chats.list(chat.id)).filter((m) => !m.meta.error && !m.meta.interrupted),
          msgSettings.sendCount(),
        ).slice(-200),
        // 只传排期要用的待跟进、每次都带的和最重要的几十条，记忆再多也不会超长
        memories: cloudMemories(character.id),
        memoryBlocks: {
          summary: summaryBlock(chat, character, timeZone).content,
          memory: memoryBlock(character, [], Date.now(), timeZone, { proactive: true }).content,
          // 家务和健康：上传那一刻的（写着"截至几点"）；没开这两套系统时没有
          ...homeSnapshot(personaOf(chat), character),
        },
        flags: lifeFlags(personaOf(chat)),
        environment: useEnvironmentStore().settings, rules: DEFAULT_PROACTIVE_RULES,
        busyUntil: ['study', 'sleep'].includes(chat.currentScene ?? '') ? chat.lastMessageAt + 4 * 3_600_000 : 0,
        preview: config.preview }];
    });
  }

  async function uploadContexts() {
    const snapshots = clone(contexts());
    const present = new Set(useCharacterStore().list.map((c) => c.id));
    // Independent characters upload concurrently. A change during its own upload is picked up next tick.
    const outcomes = await Promise.allSettled(snapshots.map(async (context) => {
      const id = context.character.id;
      if (uploading.has(id)) return;
      uploading.add(id);
      try {
        const fingerprint = await hash(context);
        if (config.hashes[id] === fingerprint) return;
        const result = await request<{ revision: number }>(`/v1/proactive/contexts/${encodeURIComponent(id)}`, 'PUT', { context, revision: config.revisions[id] ?? 0 });
        config.revisions[id] = result.revision;
        config.hashes[id] = fingerprint;
      } finally { uploading.delete(id); }
    }).concat(Object.keys(config.hashes).filter((id) => !present.has(id)).map(async (id) => {
      await request(`/v1/proactive/contexts/${encodeURIComponent(id)}`, 'DELETE');
      delete config.hashes[id]; delete config.revisions[id];
    })));
    await save();
    const failed = outcomes.find((o) => o.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }

  async function uploadApi(role: 'proactive' | 'rhythm' | 'consolidate' | 'social' = 'proactive') {
    const ai = useAiStore();
    if (!ai.isLive(role)) throw new Error(`请先在 API 设置中接通${AGENT_META[role].label}`);
    // 主动消息可能跟随「陪伴 · 快速」、它再跟随主对话：一路上的设置都要带上，云端才解析得出用哪个 API
    const chain = ai.system.router.chain(role);
    const source = chain.at(-1) ?? role;
    const credentials: ProactiveCredentials = clone({
      routes: ai.routes.filter((r) => chain.includes(r.role)),
      keys: Object.fromEntries([apiKeyId(source), apiKeyId(source, true)].map((id) => [id, ai.keyOf(id) ?? ''])),
      outputFilters: ai.outputFilters,
    });
    const fingerprint = await hash(credentials);
    const key = role === 'rhythm' ? 'rhythmApiHash' : role === 'consolidate' ? 'memoryApiHash' : role === 'social' ? 'socialApiHash' : 'apiHash';
    const configured = role === 'rhythm' ? status.value?.rhythmConfigured : role === 'consolidate' ? status.value?.memoryConfigured
      : role === 'social' ? status.value?.socialConfigured : status.value?.configured;
    if (config[key] === fingerprint && configured) return;
    await request(`/v1/secrets/${role}`, 'PUT', credentials);
    config[key] = fingerprint;
    await save();
  }

  function rhythmContexts() {
    const rhythm = useRhythmStore();
    return useCharacterStore().list.flatMap((c) => {
      if (rhythm.configOf(c.id).settings.mode !== 'daily') return [];
      const context = rhythm.cloudContext(c.id);
      return context ? [context] : [];
    });
  }

  async function uploadRhythms() {
    const snapshots = clone(rhythmContexts());
    const present = new Set(snapshots.map((c) => c.character.id));
    // Only unregister this device's previously uploaded roles. Empty devices cannot erase other roles.
    const results = await Promise.allSettled([
      ...snapshots.map(async (context) => {
        const id = context.character.id;
        const fingerprint = await hash(context);
        if (config.rhythmHashes[id] === fingerprint) return;
        const result = await request<{ revision: number }>(`/v1/rhythm/contexts/${encodeURIComponent(id)}`, 'PUT', { context, revision: config.rhythmRevisions[id] ?? 0 });
        config.rhythmRevisions[id] = result.revision; config.rhythmHashes[id] = fingerprint;
      }),
      ...Object.keys(config.rhythmHashes).filter((id) => !present.has(id)).map(async (id) => {
        await request(`/v1/rhythm/contexts/${encodeURIComponent(id)}`, 'DELETE');
        delete config.rhythmHashes[id]; delete config.rhythmRevisions[id];
      }),
      ...(snapshots.length ? [uploadApi('rhythm')] : []),
    ]);
    await save();
    const failure = results.find((r) => r.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }

  /**
   * 记忆整理：每个角色打包这次要整理的东西上传（内容没变不传），凌晨 4 点云端整理。
   * "记忆整理"没接通 API 时不传（打开 App 时会在本机补跑）
   */
  async function uploadMemories() {
    if (!useAiStore().isLive('consolidate')) return;
    config.memoryRevisions ??= {};
    config.memoryHashes ??= {};
    const revisions = config.memoryRevisions;
    const hashes = config.memoryHashes;
    let any = false;
    const results = await Promise.allSettled(useCharacterStore().list.map(async (c) => {
      const context = await packConsolidation(c.id);
      if (!context?.preset) return;
      any = true;
      // 打包时间每次都变，不算进指纹
      const fingerprint = await hash({ ...context, packedAt: 0 });
      if (hashes[c.id] === fingerprint) return;
      const result = await request<{ revision: number }>(`/v1/memory/contexts/${encodeURIComponent(c.id)}`, 'PUT', { context: clone(context), revision: revisions[c.id] ?? 0 });
      revisions[c.id] = result.revision;
      hashes[c.id] = fingerprint;
    }));
    if (any) await uploadApi('consolidate');
    await save();
    const failure = results.find((r) => r.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }

  /** 朋友圈：开着"自动发朋友圈"的角色各上传一份（角色卡、节律、记忆、最近的聊天和朋友圈），云端每天在随机的时间替她发 */
  function socialContexts() {
    // "社媒 · 朋友圈"没接通时不传（传了云端也发不出来）
    if (!useAiStore().isLive('social')) return [];
    return useCharacterStore().list.flatMap((c) => {
      const context = socialCloudContext(c.id);
      return context ? [context] : [];
    });
  }

  async function uploadSocial() {
    if (!useSocialStore().ready) return;
    config.socialRevisions ??= {};
    config.socialHashes ??= {};
    const revisions = config.socialRevisions;
    const hashes = config.socialHashes;
    const snapshots = clone(socialContexts());
    const present = new Set(snapshots.map((c) => c.character.id));
    // Only unregister this device's previously uploaded roles. Empty devices cannot erase other roles.
    const results = await Promise.allSettled([
      ...snapshots.map(async (context) => {
        const id = context.character.id;
        const fingerprint = await hash(context);
        if (hashes[id] === fingerprint) return;
        const result = await request<{ revision: number }>(`/v1/social/contexts/${encodeURIComponent(id)}`, 'PUT', { context, revision: revisions[id] ?? 0 });
        revisions[id] = result.revision; hashes[id] = fingerprint;
      }),
      ...Object.keys(hashes).filter((id) => !present.has(id)).map(async (id) => {
        await request(`/v1/social/contexts/${encodeURIComponent(id)}`, 'DELETE');
        delete hashes[id]; delete revisions[id];
      }),
      ...(snapshots.length ? [uploadApi('social')] : []),
    ]);
    await save();
    const failure = results.find((r) => r.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }

  /** 拉云端发的朋友圈：放进来、记进记忆、把要配的图画出来；有新的弹一条横幅 */
  async function pullSocial() {
    const social = useSocialStore();
    if (!social.ready) return;
    const data = await request<HubMoments>(`/v1/social/posts?since=${social.cursor}`);
    socialErrors.value = data.errors;
    const added = receiveHubMoments(data.posts.map((p) => p.moment));
    social.cursor = Math.max(social.cursor, ...data.posts.map((p) => p.doneAt));
    const latest = added.at(-1);
    const author = useCharacterStore().byId(latest?.authorId);
    if (latest && author) useAppStore().showBanner({ characterId: author.id, title: author.name, text: `发了一条朋友圈${latest.text ? `：${latest.text}` : ''}`, to: '/moments', icon: 'i-lucide-aperture' });
  }

  /** 拉云端整理好的结果，按顺序应用（你在手机上改过的那一处跳过） */
  async function pullMemories() {
    const since = config.memoryAppliedAt ?? 0;
    const data = await request<HubMemoryResults>(`/v1/memory/results?since=${since}`);
    memoryErrors.value = data.errors;
    if (!useMemoryStore().ready) return;
    for (const { doneAt, result } of data.results) {
      await applyMemoryOps(result.context, result.ops);
      config.memoryAppliedAt = Math.max(config.memoryAppliedAt ?? 0, doneAt);
      // 这份上下文整理完了：下次内容有变化再上传
      if (config.memoryHashes) delete config.memoryHashes[result.characterId];
    }
    if (data.results.length) await save();
  }

  async function pullRhythms() {
    const result = await request<HubRhythms>('/v1/rhythm/days');
    const rhythm = useRhythmStore();
    await rhythm.ingestCloud(result.days);
    for (const failure of result.errors) {
      if (failure.date === rhythm.today && rhythm.configOf(failure.characterId).settings.mode === 'daily') {
        rhythm.errors[failure.characterId] = { at: Date.now(), reason: failure.reason };
      }
    }
  }

  async function ingest(rows: HubInbox['messages']) {
    const chats = useChatStore();
    const app = useAppStore();
    const changed = new Set<string>();
    for (const row of rows) {
      const chat = chats.chatOfCharacter(row.characterId);
      if (!chat) throw new Error('云端消息对应的角色尚未导入这台设备，请导入后再次同步');
      if (chats.streams[chat.id]) throw new Error('角色正在回复，生成结束后会补齐云端消息');
      changed.add(chat.id);
      if (chats.list(chat.id).some((m) => m.id === row.message.id)) continue;
      const message: Message = { ...row.message, chatId: chat.id, read: app.viewingChatId === chat.id };
      chats.messages[chat.id] ??= [];
      chats.messages[chat.id]!.push(message);
      chats.messages[chat.id]!.sort((a, b) => a.createdAt - b.createdAt);
      chat.lastMessageAt = Math.max(chat.lastMessageAt, message.createdAt);
      changed.add(chat.id);
      if (!message.read) app.showBanner({ characterId: row.characterId, title: useCharacterStore().byId(row.characterId)?.name ?? '新消息', text: message.text,
        to: message.parts.some((p) => p.type === 'call-log') ? `/call/${row.characterId}?incoming=1` : `/chat/${chat.id}`, icon: 'i-lucide-bell-ring' });
    }
    // Persist before advancing the server cursor. Repeated pages are safe because message IDs are stable.
    const saved = await Promise.all([
      write('messages', [...changed].map((id) => ({ key: id, value: clone(chats.list(id)) }))),
      write('chats', [...changed].map((id) => ({ key: id, value: clone(chats.chatById(id)) }))),
    ]);
    if (saved.some((ok) => !ok)) throw new Error('消息未能写入本机存储，下次同步会重试');
  }

  async function pull() {
    // Pagination is a data dependency, not a job queue; it does not run or delay generation.
    let more = true;
    while (more) {
      const inbox = await request<HubInbox>(`/v1/inbox?since=${config.cursor}`);
      await ingest(inbox.messages);
      if (!await write('settings', [{ key: 'hub', value: { ...clone(config), cursor: inbox.next } }])) throw new Error('无法保存同步进度');
      config.cursor = inbox.next;
      points.value = inbox.touchpoints;
      more = inbox.more;
    }
  }

  async function syncNow() {
    if (!connected.value || syncing.value) return;
    const version = connectionVersion;
    syncing.value = true;
    try {
      await refreshStatus();
      // Context updates and inbox reads are independent. Neither starts cloud generation.
      // 记忆：先拉云端整理好的结果并应用，再上传这次要整理的
      const jobs = [
        { label: '收件箱', run: pull },
        ...(supportsRhythm.value ? [
          { label: '节律结果', run: pullRhythms },
          { label: '节律设置', run: uploadRhythms },
        ] : []),
        ...(supportsMemory.value ? [{ label: '记忆整理', run: () => pullMemories().then(uploadMemories) }] : []),
        ...(supportsSocial.value ? [{ label: '朋友圈', run: () => pullSocial().then(uploadSocial) }] : []),
        ...(config.active ? [
          { label: '角色上下文（含时区和作息）', run: uploadContexts },
          { label: '主动消息 API', run: () => uploadApi() },
        ] : []),
        ...(upgradeRequired.value ? [{ label: 'Worker 版本', run: async () => { throw new Error('云端版本过旧，请部署最新 main 的 Worker 和数据库迁移；当前节律、记忆及排期设置可能未生效'); } }] : []),
      ];
      await settleSyncJobs(jobs);
      if (version === connectionVersion) {
        config.lastSyncAt = Date.now();
        if (!await save()) throw new Error('无法保存同步状态');
        lastSyncAt.value = config.lastSyncAt; error.value = '';
      }
    } catch (e) { if (version === connectionVersion) error.value = e instanceof Error ? e.message : String(e); }
    finally { if (version === connectionVersion) syncing.value = false; }
  }

  async function enable() {
    await Promise.all([uploadContexts(), uploadApi()]);
    await request('/v1/proactive/enabled', 'PUT', { enabled: true });
    await refreshStatus(); await save(); error.value = '';
  }
  async function disable() {
    await request('/v1/proactive/enabled', 'PUT', { enabled: false });
    config.active = false; await save(); await refreshStatus();
  }
  async function subscribe() {
    // Called directly from a click: iOS requires a user gesture for this permission.
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('此浏览器不支持 Web Push；iPhone 请先添加到主屏幕再打开');
    if (await Notification.requestPermission() !== 'granted') throw new Error('未允许通知，请在系统设置中开启');
    const key = status.value?.vapidPublicKey;
    if (!key) throw new Error('Worker 尚未设置 VAPID 密钥');
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg?.active) throw new Error('请先安装或打开正式版 App，等待 Service Worker 就绪');
    const subscription = await reg.pushManager.getSubscription() ?? await reg.pushManager.subscribe({ userVisibleOnly: true,
      applicationServerKey: Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)) });
    await request('/v1/push/subscribe', 'POST', { kind: 'webpush', label: '这台设备', config: subscription.toJSON() });
    await refreshStatus();
  }
  async function addWebhook(data: { url: string; preset: string; headers?: Record<string, string>; body?: unknown }) {
    await request('/v1/push/subscribe', 'POST', { kind: 'webhook', label: data.preset === 'custom' ? '自定义 webhook' : data.preset, config: data });
    await refreshStatus();
  }
  async function removeChannel(id: string) { await request(`/v1/push/channels/${encodeURIComponent(id)}`, 'DELETE'); await refreshStatus(); }
  async function testChannel(id: string) { await request(`/v1/push/channels/${encodeURIComponent(id)}`, 'POST'); await refreshStatus(); }

  function start() {
    if (started) return;
    started = true;
    void syncNow();
    setInterval(() => void syncNow(), 60_000);
    const refresh = () => { if (document.visibilityState === 'visible') void syncNow(); };
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('online', () => void syncNow());
    navigator.serviceWorker?.addEventListener('message', (e) => { if (e.data?.type === 'hub-inbox') void syncNow(); });
    watch(() => config.preview, () => { void save(); });
    let debounce: ReturnType<typeof setTimeout>;
    watch(() => [contexts(), rhythmContexts(), socialContexts(), useAiStore().routes, useAiStore().outputFilters,
      useAiStore().keyOf(apiKeyId(useAiStore().system.router.source('proactive'))),
      useAiStore().keyOf(apiKeyId(useAiStore().system.router.source('proactive'), true)),
      useAiStore().keyOf(apiKeyId(useAiStore().system.router.source('rhythm'))),
      useAiStore().keyOf(apiKeyId(useAiStore().system.router.source('rhythm'), true)),
      useAiStore().keyOf(apiKeyId(useAiStore().system.router.source('social'))),
      useAiStore().keyOf(apiKeyId(useAiStore().system.router.source('social'), true)), useChatStore().streams], () => {
      clearTimeout(debounce); debounce = setTimeout(() => void syncNow(), 500);
    }, { deep: true });
  }
  return { config, savedPassword, connected, status, points, error, syncing, lastSyncAt, memoryErrors, socialErrors, supportsRhythm, supportsMemory, supportsSocial, upgradeRequired, hydrate, connect, resyncFromDevice, disconnect, syncNow, enable, disable, subscribe, addWebhook, removeChannel, testChannel, start };
});
