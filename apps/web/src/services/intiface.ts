import type { ScalarKind } from '@app/shared';

/**
 * Intiface Central 的客户端（心跳用，设计文档 §9.14）：Buttplug 协议 v3，JSON 走 WebSocket。
 * 没用官方的 buttplug-js（几十 KB、带一串依赖），只做心跳要用的：
 * 握手（RequestServerInfo）、扫描、设备列表和增减、ScalarCmd（震动 / 摆动 / 旋转 / 收缩 / 充气）、LinearCmd（伸缩）、
 * RotateCmd（带方向的旋转）、停下（单个 / 全部）、读电量、按服务器要求定时 Ping。
 * 协议说明：https://buttplug-spec.docs.buttplug.io/
 *
 * 地址：Intiface Central 默认在 127.0.0.1:12345（设置里打开"所有网卡"才能从别的设备连）。
 * 页面是 https 时浏览器只让连 ws://127.0.0.1 / localhost 和 wss://（混合内容），连局域网别的电脑要 wss；
 * 连不上、被拦时把原因写清楚（见 blockedReason / connectError）。
 */

/** 设备的一项能力：在这条消息的属性列表里的位置（Index）、能分几档 */
export interface ToyFeature {
  /** 在 ScalarCmd / LinearCmd / RotateCmd 属性列表里的位置 */
  index: number;
  /** 震动、摆动……；linear 是伸缩（LinearCmd，或者 ScalarCmd 里的 Position） */
  kind: ScalarKind | 'linear';
  /** 用哪条消息控制 */
  via: 'scalar' | 'linear' | 'rotate';
  /** ScalarCmd 的 ActuatorType 原文 */
  actuator: string;
  steps: number;
  /** 设备自己写的说明（"Clitoral Stimulator"） */
  descriptor: string;
}

export interface ToyDevice {
  index: number;
  name: string;
  features: ToyFeature[];
  /** 电量传感器在 SensorReadCmd 里的位置；没有为 null */
  batterySensor: number | null;
  /** 两条消息之间至少隔多久（毫秒，设备给的） */
  gapMs: number;
}

export interface ScalarSub {
  Index: number;
  Scalar: number;
  ActuatorType: string;
}
export interface LinearSub {
  Index: number;
  Duration: number;
  Position: number;
}
export interface RotateSub {
  Index: number;
  Speed: number;
  Clockwise: boolean;
}

const ACTUATOR_KIND: Record<string, ToyFeature['kind'] | undefined> = {
  Vibrate: 'vibrate',
  Oscillate: 'oscillate',
  Rotate: 'rotate',
  Constrict: 'constrict',
  Inflate: 'inflate',
  Position: 'linear',
};

type Msg = Record<string, Record<string, unknown>>;
type Obj = Record<string, unknown>;

interface Pending {
  resolve(body: Obj, type: string): void;
  reject(e: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_PORT = '12345';

function isLoopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\./.test(h);
}

/** 你填的地址 → WebSocket 地址：127.0.0.1:12345 / 192.168.1.5 / ws://… / wss://…（没写端口时 ws 用 12345） */
export function normalizeIntifaceUrl(input: string): { url: string; host: string; loopback: boolean; secure: boolean } | { error: string } {
  let t = input.trim() || `127.0.0.1:${DEFAULT_PORT}`;
  if (/^https?:\/\//i.test(t)) t = t.replace(/^http/i, 'ws');
  if (!/^wss?:\/\//i.test(t)) t = `ws://${t}`;
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    return { error: '地址看不懂：写成 127.0.0.1:12345，或者 ws://192.168.1.5:12345、wss://…' };
  }
  if (!u.port && u.protocol === 'ws:') u.port = DEFAULT_PORT;
  return { url: u.toString().replace(/\/$/, ''), host: u.host, loopback: isLoopback(u.hostname), secure: u.protocol === 'wss:' };
}

/** 浏览器会不会直接拦下这个地址（https 页面连没加密的局域网地址）：会的话返回原因 */
export function blockedReason(target: { host: string; loopback: boolean; secure: boolean }): string | null {
  if (typeof location === 'undefined' || location.protocol !== 'https:' || target.secure || target.loopback) return null;
  return `这个页面是 https，浏览器不让它连没加密的 ws://${target.host}。可以：在这台设备上开 Intiface Central（地址填 127.0.0.1:12345）；或者给 Intiface 套一层 https（例如 Caddy、cloudflared），地址填 wss://…`;
}

/** 连不上时说清楚可能是哪一步 */
export function connectError(target: { url: string; loopback: boolean }, detail: string): string {
  const where = target.loopback ? '这台设备上的 Intiface Central' : `${target.url} 那边的 Intiface Central`;
  return `连不上 ${target.url}（${detail}）。看看${where}开着没有、点了 Start Server 没有、端口是不是 12345${target.loopback ? '' : '，Intiface 设置里有没有打开"所有网卡"'}；浏览器问要不要允许访问本地网络设备时选允许。`;
}

function parseDevice(raw: Obj): ToyDevice | null {
  const index = typeof raw.DeviceIndex === 'number' ? raw.DeviceIndex : null;
  if (index === null) return null;
  const msgs = (raw.DeviceMessages ?? {}) as Record<string, unknown>;
  const list = (k: string): Obj[] => (Array.isArray(msgs[k]) ? (msgs[k] as unknown[]).filter((x): x is Obj => !!x && typeof x === 'object') : []);
  const features: ToyFeature[] = [];
  list('ScalarCmd').forEach((a, i) => {
    const actuator = String(a.ActuatorType ?? '');
    const kind = ACTUATOR_KIND[actuator];
    if (kind) features.push({ index: i, kind, via: 'scalar', actuator, steps: Number(a.StepCount) || 20, descriptor: String(a.FeatureDescriptor ?? '') });
  });
  list('RotateCmd').forEach((a, i) => features.push({ index: i, kind: 'rotate', via: 'rotate', actuator: 'Rotate', steps: Number(a.StepCount) || 20, descriptor: String(a.FeatureDescriptor ?? '') }));
  list('LinearCmd').forEach((a, i) => features.push({ index: i, kind: 'linear', via: 'linear', actuator: 'Position', steps: Number(a.StepCount) || 100, descriptor: String(a.FeatureDescriptor ?? '') }));
  const sensor = list('SensorReadCmd').findIndex((s) => s.SensorType === 'Battery');
  const name = String(raw.DeviceDisplayName || raw.DeviceName || `玩具 ${index}`);
  return { index, name, features, batterySensor: sensor >= 0 ? sensor : null, gapMs: Number(raw.DeviceMessageTimingGap) || 0 };
}

export interface IntifaceEvents {
  onDeviceAdded?(d: ToyDevice): void;
  onDeviceRemoved?(index: number): void;
  onScanningFinished?(): void;
  /** 连接断了（不是你点的断开）：原因 */
  onClose?(reason: string): void;
}

export class IntifaceClient {
  private ws: WebSocket | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private closing = false;
  serverName = '';
  readonly events: IntifaceEvents;

  constructor(events: IntifaceEvents = {}) {
    this.events = events;
  }

  get connected(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN && !!this.serverName;
  }

  /** 连上并握手；失败时抛出写好原因的错误 */
  async connect(target: { url: string; loopback: boolean }): Promise<void> {
    this.close();
    this.closing = false;
    let ws: WebSocket;
    try {
      ws = new WebSocket(target.url);
    } catch (e) {
      throw new Error(connectError(target, e instanceof Error ? e.message : String(e)));
    }
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(connectError(target, '6 秒没有回应')));
        ws.close();
      }, 6000);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error(connectError(target, '连接被拒绝或中断')));
      };
      ws.onclose = (e) => {
        clearTimeout(timer);
        reject(new Error(connectError(target, `连接关闭 ${e.code}`)));
      };
    });
    ws.onmessage = (e) => this.receive(e.data);
    ws.onerror = null;
    ws.onclose = (e) => this.dropped(e.code === 1000 ? '' : `连接断了（${e.code}${e.reason ? ` ${e.reason}` : ''}）`);
    const info = await this.request('RequestServerInfo', { ClientName: 'ai-mobile 心跳', MessageVersion: 3 }, 8000).catch((e: unknown) => {
      this.close();
      throw new Error(`Intiface 没有完成握手：${e instanceof Error ? e.message : String(e)}`);
    });
    this.serverName = String(info.ServerName ?? 'Intiface');
    const maxPing = Number(info.MaxPingTime) || 0;
    if (maxPing > 0) this.pingTimer = setInterval(() => void this.request('Ping', {}).catch(() => undefined), Math.max(200, Math.floor(maxPing / 2)));
  }

  /** 你点的断开：先让玩具都停下 */
  async disconnect(): Promise<void> {
    if (!this.ws) return;
    if (this.connected) await this.request('StopAllDevices', {}, 1500).catch(() => undefined);
    this.close();
  }

  private close() {
    this.closing = true;
    clearInterval(this.pingTimer);
    this.pingTimer = undefined;
    const ws = this.ws;
    this.ws = null;
    this.serverName = '';
    if (ws) {
      ws.onopen = ws.onerror = ws.onmessage = ws.onclose = null;
      try {
        ws.close(1000);
      } catch {
        // 已经关了
      }
    }
    this.rejectAll('连接已关闭');
  }

  private dropped(reason: string) {
    const was = this.closing;
    this.close();
    if (!was) this.events.onClose?.(reason || '连接关了');
  }

  private rejectAll(reason: string) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
      this.pending.delete(id);
    }
  }

  /** 发一条消息，等对应 Id 的回复（Ok、ServerInfo、DeviceList……；Error 时抛出） */
  private request(type: string, fields: Obj, timeoutMs = 5000): Promise<Obj> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('还没连上 Intiface'));
    this.seq = this.seq >= 4_000_000_000 ? 1 : this.seq + 1;
    const id = this.seq;
    return new Promise<Obj>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${type} 没有回应`));
      }, timeoutMs);
      this.pending.set(id, { resolve: (body) => resolve(body), reject, timer });
      try {
        ws.send(JSON.stringify([{ [type]: { Id: id, ...fields } }]));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private receive(data: unknown) {
    if (typeof data !== 'string') return;
    let list: unknown;
    try {
      list = JSON.parse(data);
    } catch {
      return;
    }
    for (const m of Array.isArray(list) ? (list as Msg[]) : []) {
      const type = Object.keys(m ?? {})[0];
      if (!type) continue;
      const body = (m[type] ?? {}) as Obj;
      const id = typeof body.Id === 'number' ? body.Id : 0;
      const p = id ? this.pending.get(id) : undefined;
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(id);
        if (type === 'Error') p.reject(new Error(String(body.ErrorMessage ?? 'Intiface 报错')));
        else p.resolve(body, type);
        continue;
      }
      if (type === 'DeviceAdded') {
        const d = parseDevice(body);
        if (d) this.events.onDeviceAdded?.(d);
      } else if (type === 'DeviceRemoved' && typeof body.DeviceIndex === 'number') this.events.onDeviceRemoved?.(body.DeviceIndex);
      else if (type === 'ScanningFinished') this.events.onScanningFinished?.();
    }
  }

  async deviceList(): Promise<ToyDevice[]> {
    const r = await this.request('RequestDeviceList', {});
    const list = Array.isArray(r.Devices) ? (r.Devices as Obj[]) : [];
    return list.map(parseDevice).filter((d): d is ToyDevice => !!d);
  }

  startScanning(): Promise<Obj> {
    return this.request('StartScanning', {});
  }

  stopScanning(): Promise<Obj> {
    return this.request('StopScanning', {});
  }

  scalar(device: number, scalars: ScalarSub[]): Promise<Obj> {
    return this.request('ScalarCmd', { DeviceIndex: device, Scalars: scalars });
  }

  linear(device: number, vectors: LinearSub[]): Promise<Obj> {
    return this.request('LinearCmd', { DeviceIndex: device, Vectors: vectors });
  }

  rotate(device: number, rotations: RotateSub[]): Promise<Obj> {
    return this.request('RotateCmd', { DeviceIndex: device, Rotations: rotations });
  }

  stopDevice(device: number): Promise<Obj> {
    return this.request('StopDeviceCmd', { DeviceIndex: device });
  }

  stopAll(): Promise<Obj> {
    return this.request('StopAllDevices', {});
  }

  /** 电量 0–100；读不到为 null */
  async battery(d: ToyDevice): Promise<number | null> {
    if (d.batterySensor === null) return null;
    try {
      const r = await this.request('SensorReadCmd', { DeviceIndex: d.index, SensorIndex: d.batterySensor, SensorType: 'Battery' }, 4000);
      const v = Array.isArray(r.Data) ? Number(r.Data[0]) : NaN;
      return Number.isFinite(v) ? Math.round(v) : null;
    } catch {
      return null;
    }
  }
}
