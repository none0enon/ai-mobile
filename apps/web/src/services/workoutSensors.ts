import { reactive } from 'vue';
import { services } from './index';
import { distanceKm } from './maps';

/**
 * 健身时的进阶记录（设计文档 §9.1）：先只做安卓。
 * - 心率：蓝牙心率带、手表的心率广播（标准的蓝牙心率服务，安卓 Chrome 的 Web Bluetooth 能连）；
 * - 步数：手机的加速度传感器（Accelerometer；没有时用 devicemotion）按波峰数步，手机要带在身上；
 * - 距离、配速：GPS（室外的运动），屏幕亮着时记（"健身"开着时保持常亮）。
 * 别的手机（iPhone、电脑）不开这些，结束时手动填手表上的数。以后的安卓壳可以换成 Health Connect，接口不变。
 */

/** 安卓（浏览器或以后的安卓壳）：进阶记录只在这里开 */
export function isAndroid(): boolean {
  return services.native.platform === 'android' || (typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent));
}

// —— 心率：Web Bluetooth 的标准心率服务（0x180D / 0x2A37） ——

interface BtCharacteristic extends EventTarget {
  value?: DataView;
  startNotifications(): Promise<BtCharacteristic>;
  stopNotifications(): Promise<BtCharacteristic>;
}
interface BtServer {
  getPrimaryService(s: string): Promise<{ getCharacteristic(c: string): Promise<BtCharacteristic> }>;
}
interface BtDevice extends EventTarget {
  name?: string;
  gatt?: { connected: boolean; connect(): Promise<BtServer>; disconnect(): void };
}
type BtNavigator = Navigator & { bluetooth?: { requestDevice(o: { filters: { services: string[] }[] }): Promise<BtDevice> } };

export function bluetoothSupported(): boolean {
  return typeof navigator !== 'undefined' && !!(navigator as BtNavigator).bluetooth;
}

/** 心率测量的值：第一个字节的最低位是 1 时是 16 位，否则 8 位 */
function parseHeartRate(v: DataView): number {
  const flags = v.getUint8(0);
  return flags & 0x1 ? v.getUint16(1, true) : v.getUint8(1);
}

export function createHeartRate() {
  const state = reactive({
    status: 'idle' as 'idle' | 'connecting' | 'on' | 'lost' | 'error',
    device: '',
    bpm: 0,
    max: 0,
    /** 记着的时候的平均心率 */
    avg: 0,
    error: '',
  });
  let device: BtDevice | null = null;
  let ch: BtCharacteristic | null = null;
  let sum = 0;
  let count = 0;
  /** 暂停时不算进平均 */
  let counting = false;

  function onValue() {
    const v = ch?.value;
    if (!v) return;
    const bpm = parseHeartRate(v);
    if (!bpm || bpm < 30 || bpm > 240) return;
    state.bpm = bpm;
    if (!counting) return;
    sum += bpm;
    count += 1;
    state.avg = Math.round(sum / count);
    state.max = Math.max(state.max, bpm);
  }
  function onLost() {
    if (state.status === 'on') state.status = 'lost';
    state.bpm = 0;
  }

  /** 连心率带（在点击里调用：浏览器要用户点了才弹选择设备的框） */
  async function connect() {
    const bt = (navigator as BtNavigator).bluetooth;
    if (!bt) {
      state.status = 'error';
      state.error = '这个浏览器不能连蓝牙：安卓上用 Chrome 打开（iPhone 的浏览器都不支持）';
      return;
    }
    state.status = 'connecting';
    state.error = '';
    try {
      device = await bt.requestDevice({ filters: [{ services: ['heart_rate'] }] });
      device.addEventListener('gattserverdisconnected', onLost);
      const server = await device.gatt!.connect();
      const service = await server.getPrimaryService('heart_rate');
      ch = await service.getCharacteristic('heart_rate_measurement');
      ch.addEventListener('characteristicvaluechanged', onValue);
      await ch.startNotifications();
      state.device = device.name || '心率设备';
      state.status = 'on';
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      state.status = /cancel|chosen|取消/i.test(msg) ? 'idle' : 'error';
      state.error = state.status === 'idle' ? '' : `连不上心率设备：${msg}（手表要打开"心率广播"，心率带要戴上才会出现）`;
    }
  }

  function setCounting(on: boolean) {
    counting = on;
  }
  function reset() {
    sum = 0;
    count = 0;
    Object.assign(state, { avg: 0, max: 0 });
  }
  function disconnect() {
    counting = false;
    try {
      ch?.removeEventListener('characteristicvaluechanged', onValue);
      void ch?.stopNotifications().catch(() => undefined);
      device?.removeEventListener('gattserverdisconnected', onLost);
      device?.gatt?.disconnect();
    } catch {
      // 已经断了
    }
    ch = null;
    device = null;
    if (state.status !== 'error') state.status = 'idle';
    state.bpm = 0;
  }
  return { state, connect, setCounting, reset, disconnect };
}

// —— 步数：加速度按波峰数 ——

type AccelSensor = EventTarget & { x?: number | null; y?: number | null; z?: number | null; start(): void; stop(): void };
type AccelCtor = new (o: { frequency: number }) => AccelSensor;

export function createStepCounter() {
  const state = reactive({ on: false, steps: 0, error: '', source: '' as '' | 'sensor' | 'motion' });
  let sensor: AccelSensor | null = null;
  let counting = false;
  let smooth = 9.8;
  let base = 9.8;
  let armed = false;
  let lastStep = 0;

  function sample(x: number, y: number, z: number) {
    const m = Math.sqrt(x * x + y * y + z * z);
    smooth += 0.25 * (m - smooth);
    base += 0.02 * (m - base);
    const d = smooth - base;
    const t = performance.now();
    // 过了平均线往下走才算"抬起"，再往上冲过阈值算一步；两步之间至少 0.28 秒
    if (d < 0) armed = true;
    else if (armed && d > 1.1 && t - lastStep > 280) {
      armed = false;
      lastStep = t;
      if (counting) state.steps += 1;
    }
  }
  function onMotion(e: DeviceMotionEvent) {
    const a = e.accelerationIncludingGravity;
    if (a && a.x != null && a.y != null && a.z != null) sample(a.x, a.y, a.z);
  }

  function start() {
    if (state.on) return;
    state.error = '';
    const Ctor = (globalThis as unknown as { Accelerometer?: AccelCtor }).Accelerometer;
    try {
      if (!Ctor) throw new Error('no sensor');
      const s = new Ctor({ frequency: 30 });
      s.addEventListener('reading', () => sample(s.x ?? 0, s.y ?? 0, s.z ?? 0));
      s.addEventListener('error', () => {
        // 传感器被拒了：改用 devicemotion
        sensor = null;
        window.addEventListener('devicemotion', onMotion);
        state.source = 'motion';
      });
      s.start();
      sensor = s;
      state.source = 'sensor';
    } catch {
      if (typeof DeviceMotionEvent === 'undefined') {
        state.error = '这台手机读不到加速度，数不了步';
        return;
      }
      window.addEventListener('devicemotion', onMotion);
      state.source = 'motion';
    }
    state.on = true;
  }
  function setCounting(on: boolean) {
    counting = on;
  }
  function stop() {
    counting = false;
    sensor?.stop();
    sensor = null;
    window.removeEventListener('devicemotion', onMotion);
    state.on = false;
  }
  return { state, start, setCounting, stop };
}

// —— 距离：GPS ——

export function createGpsTracker() {
  const state = reactive({ on: false, km: 0, accuracy: 0, fixes: 0, error: '' });
  let watch: number | null = null;
  let last: { lat: number; lng: number; t: number } | null = null;
  let counting = false;

  function onPos(p: GeolocationPosition) {
    const { latitude: lat, longitude: lng, accuracy } = p.coords;
    state.accuracy = Math.round(accuracy);
    state.error = '';
    // 太不准的点不用（室内、刚开始定位）
    if (accuracy > 35) return;
    state.fixes += 1;
    const cur = { lat, lng, t: p.timestamp };
    if (!last || !counting) {
      last = cur;
      return;
    }
    const km = distanceKm(last, cur);
    const sec = Math.max(1, (cur.t - last.t) / 1000);
    // 原地漂移不算；一秒十几米的跳点也不算
    if (km * 1000 < Math.max(4, accuracy * 0.6)) return;
    if ((km * 1000) / sec > 12) {
      last = cur;
      return;
    }
    state.km += km;
    last = cur;
  }
  function onErr(e: GeolocationPositionError) {
    state.error = e.code === e.PERMISSION_DENIED ? '没有定位权限：在浏览器的网站设置里允许定位' : `定位失败：${e.message || '信号不好'}`;
  }
  function start() {
    if (state.on) return;
    if (!navigator.geolocation) {
      state.error = '这个浏览器不能定位';
      return;
    }
    watch = navigator.geolocation.watchPosition(onPos, onErr, { enableHighAccuracy: true, maximumAge: 0, timeout: 30_000 });
    state.on = true;
  }
  function setCounting(on: boolean) {
    counting = on;
    // 暂停回来从新的位置算，不把暂停时走的路算进去
    if (on) last = null;
  }
  function stop() {
    counting = false;
    if (watch !== null) navigator.geolocation.clearWatch(watch);
    watch = null;
    last = null;
    state.on = false;
  }
  return { state, start, setCounting, stop };
}
