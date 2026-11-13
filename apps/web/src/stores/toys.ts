import { buildDeviceMessages, errorText, samplerRequest } from '@app/ai';
import { describeCommand, parseDeviceSteps, SCALAR_KINDS, TOY_KIND_KEYS, TOY_KIND_LABEL, type Character, type DeviceStep, type ToyCommand, type ToyKind } from '@app/shared';
import { defineStore } from 'pinia';
import { computed, reactive, ref, watch } from 'vue';
import { useAiStore } from './ai';
import { useLibraryStore } from './library';
import { blockedReason, IntifaceClient, normalizeIntifaceUrl, type ToyDevice } from '@/services/intiface';
import { MissingPresetError } from '@/services/prompt';
import { DEFAULT_CAPS, emptyLevels, intensityOf, ToyPlayer, type ToyCaps, type ToyLevels, type ToyOutput } from '@/services/toyPlayer';

/**
 * 心跳里的玩具（设计文档 §9.14）：连 Intiface Central、列出连着的玩具、把指令放上去、按设置守着上限和安全时间。
 * - 指令从哪来（source）：单独生成（"控制指令"预设按她的话写，默认）/ 她自己写（心跳的功能预设里"她自己写指令"那一块，她在回复里写 <device>）/ 不控制；
 * - 强度上限、伸缩最快多快和范围、多久没有新指令就停、切到后台就停、打字时读多快、没连玩具时也在界面上试：存在本机（ai-mobile:toys）；
 * - 按了"停"以后她的指令先不执行（held），点"继续"才接着来；断开、离开心跳时都停下。
 * 连接留着（再进心跳不用重连），设置里"断开"才断。
 */

export type CommandSource = 'separate' | 'inline' | 'off';

export interface ToySettings {
  /** Intiface Central 的地址：127.0.0.1:12345、ws://…、wss://… */
  url: string;
  /** 进心跳时自动连（连上过一次以后打开，点"断开"时关） */
  autoConnect: boolean;
  source: CommandSource;
  caps: ToyCaps;
  /** 多久没有新指令就停下（分钟，0 = 一直放着） */
  safetyMin: number;
  /** 切到别的 App、锁屏时停下 */
  stopOnHide: boolean;
  /** 没连玩具时也写指令、在心跳上显示（试预设用） */
  simulate: boolean;
  /** 打字时她的话按多快读（字 / 秒），指令读到那里时执行 */
  readCps: number;
}

const KEY = 'ai-mobile:toys';

export const DEFAULT_TOY_SETTINGS: ToySettings = {
  url: '127.0.0.1:12345',
  autoConnect: false,
  source: 'separate',
  caps: { ...DEFAULT_CAPS },
  safetyMin: 10,
  stopOnHide: true,
  simulate: false,
  readCps: 9,
};

const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d);

function load(): ToySettings {
  let raw: Record<string, unknown> = {};
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown;
    if (v && typeof v === 'object') raw = v as Record<string, unknown>;
  } catch {
    // 读不出来就用默认的
  }
  const c = (raw.caps && typeof raw.caps === 'object' ? raw.caps : {}) as Partial<ToyCaps>;
  const d = DEFAULT_CAPS;
  return {
    url: typeof raw.url === 'string' && raw.url.trim() ? raw.url.trim() : DEFAULT_TOY_SETTINGS.url,
    autoConnect: raw.autoConnect === true,
    source: raw.source === 'inline' || raw.source === 'off' ? raw.source : 'separate',
    caps: {
      vibrate: num(c.vibrate, 0, 100, d.vibrate),
      oscillate: num(c.oscillate, 0, 100, d.oscillate),
      rotate: num(c.rotate, 0, 100, d.rotate),
      constrict: num(c.constrict, 0, 100, d.constrict),
      inflate: num(c.inflate, 0, 100, d.inflate),
      strokeMs: num(c.strokeMs, 100, 3000, d.strokeMs),
      posMin: num(c.posMin, 0, 100, d.posMin),
      posMax: num(c.posMax, 0, 100, d.posMax),
    },
    safetyMin: num(raw.safetyMin, 0, 120, DEFAULT_TOY_SETTINGS.safetyMin),
    stopOnHide: raw.stopOnHide !== false,
    simulate: raw.simulate === true,
    readCps: num(raw.readCps, 3, 30, DEFAULT_TOY_SETTINGS.readCps),
  };
}

export const useToyStore = defineStore('toys', () => {
  const settings = reactive<ToySettings>(load());
  watch(
    () => JSON.stringify(settings),
    (v) => {
      try {
        localStorage.setItem(KEY, v);
      } catch {
        // 存不下：这次打开仍然有效
      }
    },
  );

  const status = ref<'idle' | 'connecting' | 'connected'>('idle');
  /** 连不上、断了、被浏览器拦下的原因 */
  const error = ref('');
  /** 指令没发出去（玩具断开、Intiface 报错）：最近一次 */
  const sendError = ref('');
  const server = ref('');
  const scanning = ref(false);
  const devices = ref<ToyDevice[]>([]);
  const battery = reactive<Record<number, number | null>>({});
  const levels = reactive<ToyLevels>(emptyLevels());
  /** 按了"停"：她的指令先不执行，点"继续"再来 */
  const held = ref(false);
  /** 安全时间到了、切到后台停下了：写一行 */
  const notice = ref('');
  /** 上一条执行的指令（一句话） */
  const lastCommand = ref<{ text: string; at: number } | null>(null);
  /** 上一次"控制指令"写的（她那句话、写了什么、出错没有），设置里看，调预设用 */
  const lastWritten = ref<{ line: string; steps: string[]; at: number; error?: string } | null>(null);
  let lastAt = 0;
  let watchdog: ReturnType<typeof setInterval> | undefined;
  let scanTimer: ReturnType<typeof setTimeout> | undefined;

  function fail(e: unknown) {
    sendError.value = `指令没发出去：${errorText(e)}`;
  }

  const client = new IntifaceClient({
    onDeviceAdded: (d) => {
      devices.value = [...devices.value.filter((x) => x.index !== d.index), d].sort((a, b) => a.index - b.index);
      void readBattery(d);
    },
    onDeviceRemoved: (index) => {
      devices.value = devices.value.filter((d) => d.index !== index);
      delete battery[index];
    },
    onScanningFinished: () => {
      scanning.value = false;
    },
    onClose: (reason) => {
      status.value = 'idle';
      server.value = '';
      devices.value = [];
      scanning.value = false;
      error.value = `Intiface ${reason}`;
      player.stop();
    },
  });

  const output: ToyOutput = {
    devices: () => (status.value === 'connected' ? devices.value : []),
    scalar: (d, s) => void client.scalar(d, s).catch(fail),
    linear: (d, s) => void client.linear(d, s).catch(fail),
    rotate: (d, s) => void client.rotate(d, s).catch(fail),
    stopAll: () => {
      if (client.connected) void client.stopAll().catch(() => undefined);
    },
  };
  const player = new ToyPlayer(levels, output, () => settings.caps);

  /** 连着、有玩具 */
  const ready = computed(() => status.value === 'connected' && devices.value.length > 0);
  /** 指令会被执行（连着玩具，或者在界面上试） */
  const live = computed(() => ready.value || settings.simulate);
  /** 要不要让她写指令：会执行、没按停、指令来源没关 */
  const wanted = computed(() => live.value && !held.value && settings.source !== 'off');
  const intensity = computed(() => intensityOf(levels));

  async function readBattery(d: ToyDevice) {
    if (d.batterySensor === null) return;
    battery[d.index] = await client.battery(d);
  }

  async function scan() {
    if (!client.connected) return;
    scanning.value = true;
    clearTimeout(scanTimer);
    try {
      await client.startScanning();
    } catch (e) {
      // 已经在扫描时有的版本会报错，不影响
      if (!/already/i.test(errorText(e))) error.value = `扫描玩具：${errorText(e)}`;
    }
    scanTimer = setTimeout(() => {
      if (client.connected) void client.stopScanning().catch(() => undefined);
      scanning.value = false;
    }, 15_000);
  }

  /** 连上 Intiface Central（在点击里调用；自动连也走这里） */
  async function connect(): Promise<boolean> {
    if (status.value !== 'idle') return status.value === 'connected';
    const target = normalizeIntifaceUrl(settings.url);
    if ('error' in target) {
      error.value = target.error;
      return false;
    }
    const blocked = blockedReason(target);
    if (blocked) {
      error.value = blocked;
      return false;
    }
    status.value = 'connecting';
    error.value = '';
    sendError.value = '';
    try {
      await client.connect(target);
      server.value = client.serverName;
      status.value = 'connected';
      settings.autoConnect = true;
      devices.value = (await client.deviceList().catch(() => [] as ToyDevice[])).sort((a, b) => a.index - b.index);
      for (const d of devices.value) void readBattery(d);
      void scan();
      return true;
    } catch (e) {
      status.value = 'idle';
      error.value = errorText(e);
      return false;
    }
  }

  async function disconnect() {
    player.stop();
    clearTimeout(scanTimer);
    settings.autoConnect = false;
    await client.disconnect();
    status.value = 'idle';
    server.value = '';
    devices.value = [];
    scanning.value = false;
  }

  /** 试一下：这个玩具轻轻动一下（不经过她，也不管按没按停） */
  function test(d: ToyDevice) {
    if (!client.connected) return;
    const scalars = d.features.filter((f) => f.via === 'scalar' && f.kind !== 'linear');
    const rotations = d.features.filter((f) => f.via === 'rotate');
    const linears = d.features.filter((f) => f.kind === 'linear');
    if (scalars.length) void client.scalar(d.index, scalars.map((f) => ({ Index: f.index, Scalar: 0.3, ActuatorType: f.actuator }))).catch(fail);
    if (rotations.length) void client.rotate(d.index, rotations.map((f) => ({ Index: f.index, Speed: 0.3, Clockwise: true }))).catch(fail);
    for (const f of linears) {
      if (f.via === 'linear') void client.linear(d.index, [{ Index: f.index, Duration: 600, Position: 0.7 }]).catch(fail);
    }
    setTimeout(() => {
      if (!client.connected) return;
      if (scalars.length) void client.scalar(d.index, scalars.map((f) => ({ Index: f.index, Scalar: 0, ActuatorType: f.actuator }))).catch(fail);
      if (rotations.length) void client.rotate(d.index, rotations.map((f) => ({ Index: f.index, Speed: 0, Clockwise: true }))).catch(fail);
      for (const f of linears) if (f.via === 'linear') void client.linear(d.index, [{ Index: f.index, Duration: 600, Position: 0.2 }]).catch(fail);
    }, 800);
  }

  /** 连着的玩具能做的（在界面上试时都能） */
  const kinds = computed<ToyKind[]>(() => {
    if (!ready.value) return settings.simulate ? ['vibrate', 'oscillate', 'rotate', 'linear'] : [];
    const set = new Set(devices.value.flatMap((d) => d.features.map((f) => f.kind)));
    return ([...SCALAR_KINDS, 'linear'] as ToyKind[]).filter((k) => set.has(k));
  });

  /** 去掉玩具做不了的那几种；什么都不剩时为 null */
  function fitCommand(cmd: ToyCommand): ToyCommand | null {
    if (cmd.stop) return cmd;
    const out: ToyCommand = {};
    for (const k of kinds.value) {
      const v = cmd[k];
      if (v) Object.assign(out, { [k]: v });
    }
    return Object.keys(out).length ? out : null;
  }

  function arm() {
    if (watchdog) return;
    watchdog = setInterval(() => {
      if (!player.active) {
        clearInterval(watchdog);
        watchdog = undefined;
        return;
      }
      if (settings.safetyMin > 0 && Date.now() - lastAt > settings.safetyMin * 60_000) {
        player.stop();
        notice.value = `${settings.safetyMin} 分钟没有新的指令，先停下了`;
      }
    }, 5000);
  }

  /** 执行一条指令：她的（按了停时不执行）或者你手动的；返回执行了没有 */
  function apply(cmd: ToyCommand, from: 'her' | 'you' = 'her'): boolean {
    if (!live.value || (from === 'her' && held.value)) return false;
    const fitted = fitCommand(cmd);
    if (!fitted) return false;
    player.apply(fitted);
    lastAt = Date.now();
    lastCommand.value = { text: describeCommand(fitted), at: lastAt };
    notice.value = '';
    if (!fitted.stop) arm();
    return true;
  }

  /** 全部停下；hold：之后她的指令先不执行，等你点"继续" */
  function stopAll(hold = true, why = '') {
    player.stop();
    if (hold) held.value = true;
    if (why) notice.value = why;
  }

  function resume() {
    held.value = false;
    notice.value = '';
  }

  // —— 写给"控制指令"预设、她自己写指令时看的几行 ——

  /** 连着的玩具和能写的键 */
  function toysLine(): string {
    if (!ready.value) return settings.simulate ? '没连真的玩具（只在界面上显示）：VIBRATE、OSCILLATE、ROTATE、LINEAR 都可以写。' : '';
    const lines = devices.value.map((d) => {
      const by = new Map<ToyKind, number>();
      for (const f of d.features) by.set(f.kind, (by.get(f.kind) ?? 0) + 1);
      const parts = [...by].map(([k, n]) => `${TOY_KIND_LABEL[k]}${n > 1 ? ` ${n} 个马达（可以写成数组分别控制）` : ''}（${TOY_KIND_KEYS[k].join(' / ')}）`);
      return `- ${d.name}：${parts.join('、') || '没有能控制的'}`;
    });
    const keys = kinds.value.flatMap((k) => TOY_KIND_KEYS[k]);
    return `${lines.join('\n')}\n能写的键：${keys.join('、')}、STOP；别的键这些玩具做不了，不要写。`;
  }

  /** 强度上限和最快的速度 */
  function limitsLine(): string {
    const c = settings.caps;
    const caps = kinds.value.filter((k): k is (typeof SCALAR_KINDS)[number] => k !== 'linear').map((k) => `${TOY_KIND_LABEL[k]} ${c[k]}`);
    const parts = [
      caps.length ? `强度上限：${caps.join('、')}（超过的会被压到上限，写的时候就在上限以内安排轻重）` : '',
      kinds.value.includes('linear') ? `伸缩：从底到顶一下最快 ${c.strokeMs} 毫秒（幅度小按比例更快）` : '',
      '变速的每一档不短于 120 毫秒',
    ];
    return parts.filter(Boolean).join('；');
  }

  /** 现在在做什么 */
  function nowLine(): string {
    const doing = Object.entries(levels.doing).map(([, v]) => v);
    const ago = lastCommand.value ? Math.round((Date.now() - lastCommand.value.at) / 1000) : null;
    return `${doing.length ? doing.join('；') : '都停着'}${ago !== null ? `（上一条指令在 ${ago} 秒前）` : ''}`;
  }

  /**
   * "控制指令"预设：按她这句话写指令（「控制指令」的 API，默认跟随「陪伴 · 快速」）。
   * 返回放到原话里之前的步骤；没接通、没有预设、写坏了时抛出
   */
  async function writeCommands(opts: { character: Character; userName: string; line: string; recent: string[]; signal?: AbortSignal }): Promise<DeviceStep[]> {
    const ai = useAiStore();
    const s = ai.status('device');
    if (!s.live) throw new Error(`「控制指令」还没接通：${s.reason}`);
    const preset = useLibraryStore().presetForUse('device', opts.character);
    if (!preset) throw new MissingPresetError('控制指令');
    const messages = buildDeviceMessages(
      {
        userName: opts.userName,
        characterName: opts.character.name,
        fills: {
          deviceToys: `连着的玩具：\n${toysLine()}`,
          deviceLimits: `强度上限和最快的速度：${limitsLine()}`,
          deviceNow: `玩具现在：${nowLine()}`,
          deviceRecent: opts.recent.length ? `最近的对话：\n${opts.recent.join('\n')}` : '',
          deviceLine: `${opts.character.name}这一句（要配指令的话）：\n${opts.line}`,
        },
      },
      preset,
    );
    try {
      const { value } = await ai.system.json('device', { messages, ...samplerRequest(preset.sampler) }, parseDeviceSteps, { signal: opts.signal });
      const steps = value.map((st) => ({ at: st.at, command: fitCommand(st.command) })).filter((st): st is DeviceStep => !!st.command);
      lastWritten.value = { line: opts.line, steps: steps.map((st) => `${st.at ? `「${st.at}」` : '开头'} → ${describeCommand(st.command)}`), at: Date.now() };
      return steps;
    } catch (e) {
      if (!opts.signal?.aborted) lastWritten.value = { line: opts.line, steps: [], at: Date.now(), error: errorText(e) };
      throw e;
    }
  }

  return {
    settings,
    status,
    error,
    sendError,
    server,
    scanning,
    devices,
    battery,
    levels,
    held,
    notice,
    lastCommand,
    lastWritten,
    ready,
    live,
    wanted,
    intensity,
    kinds,
    connect,
    disconnect,
    scan,
    test,
    apply,
    stopAll,
    resume,
    toysLine,
    limitsLine,
    nowLine,
    writeCommands,
  };
});
