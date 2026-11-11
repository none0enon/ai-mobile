import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { VoiceRecorder } from '../src/services/recorder.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function microphone() {
  let stopped = false;
  return { stream: { getTracks: () => [{ stop: () => { stopped = true; } }] } as unknown as MediaStream, stopped: () => stopped };
}

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported(mime: string) { return mime === 'audio/webm;codecs=opus'; }
  state = 'inactive';
  mimeType = 'audio/webm;codecs=opus';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((event: { error: Error }) => void) | null = null;
  constructor() { FakeMediaRecorder.instances.push(this); }
  start() { this.state = 'recording'; }
  stop() {
    this.state = 'inactive';
    queueMicrotask(() => {
      this.ondataavailable?.({ data: new Blob(['actual audio'], { type: this.mimeType }) });
      this.onstop?.();
    });
  }
}

function install(t: TestContext, getUserMedia: () => Promise<MediaStream>) {
  FakeMediaRecorder.instances = [];
  const values: Record<string, unknown> = { navigator: { mediaDevices: { getUserMedia } }, MediaRecorder: FakeMediaRecorder };
  for (const [key, value] of Object.entries(values)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
}

test('stop waits for final audio data and releases microphone tracks', async (t) => {
  const mic = microphone();
  install(t, async () => mic.stream);
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const recorder = new VoiceRecorder();
  assert.equal(await recorder.start(), true);
  now = 2300;
  const result = await recorder.stop();
  assert.equal(await result!.audio.text(), 'actual audio');
  assert.equal(result!.audio.type, 'audio/webm;codecs=opus');
  assert.equal(result!.durationMs, 1300);
  assert.equal(mic.stopped(), true);
});

test('release while microphone permission is pending never starts a late recording', async (t) => {
  const mic = microphone();
  const permission = deferred<MediaStream>();
  install(t, () => permission.promise);
  const recorder = new VoiceRecorder();
  const starting = recorder.start();
  assert.equal(await recorder.stop(), null);
  permission.resolve(mic.stream);
  assert.equal(await starting, false);
  assert.equal(mic.stopped(), true);
  assert.equal(FakeMediaRecorder.instances.length, 0);
});

test('cancel discards recorded data and releases the microphone', async (t) => {
  const mic = microphone();
  install(t, async () => mic.stream);
  const recorder = new VoiceRecorder();
  await recorder.start();
  recorder.cancel();
  assert.equal(await recorder.stop(), null);
  assert.equal(mic.stopped(), true);
});

test('a cancelled pending permission cannot interfere with a newer recording', async (t) => {
  const oldMic = microphone();
  const newMic = microphone();
  const pending = deferred<MediaStream>();
  let calls = 0;
  install(t, () => ++calls === 1 ? pending.promise : Promise.resolve(newMic.stream));
  const recorder = new VoiceRecorder();
  const oldStart = recorder.start();
  recorder.cancel();
  await recorder.start();
  pending.resolve(oldMic.stream);
  assert.equal(await oldStart, false);
  assert.equal(oldMic.stopped(), true);
  assert.equal(newMic.stopped(), false);
  assert.equal(await (await recorder.stop())!.audio.text(), 'actual audio');
});

test('permission denial is actionable and a later recording can retry', async (t) => {
  const mic = microphone();
  let calls = 0;
  install(t, async () => {
    if (++calls === 1) throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    return mic.stream;
  });
  const recorder = new VoiceRecorder();
  await assert.rejects(recorder.start(), /麦克风权限未开启/);
  await recorder.start();
  recorder.cancel();
  assert.equal(mic.stopped(), true);
});

test('recorder errors are reported when finishing and release microphone tracks', async (t) => {
  const mic = microphone();
  install(t, async () => mic.stream);
  const recorder = new VoiceRecorder();
  await recorder.start();
  FakeMediaRecorder.instances[0]!.onerror?.({ error: new Error('device disconnected') });
  await assert.rejects(recorder.stop(), /device disconnected/);
  assert.equal(mic.stopped(), true);
});
