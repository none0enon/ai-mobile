import { defineStore } from 'pinia';
import { reactive } from 'vue';
import { autoSave, getOne } from '@/db/idb';

/** 通话时怎么听你说话：自动（说完自动发）/ 按住说话 / 打字 */
export type CallInput = 'auto' | 'hold' | 'type';

export interface CallSettings {
  input: CallInput;
  /** 说话检测灵敏度 0–100 */
  sensitivity: number;
  /** 停顿多久算说完（毫秒） */
  endSilenceMs: number;
  /** 你一开口她就停下来听 */
  bargeIn: boolean;
}

const DEFAULTS: CallSettings = { input: 'auto', sensitivity: 55, endSilenceMs: 800, bargeIn: true };

/** "我的 → 语音"里通话的设置，存在本机（settings 表的 voice 一项） */
export const useVoiceStore = defineStore('voice', () => {
  const call = reactive<CallSettings>({ ...DEFAULTS });
  const saver = autoSave('settings', () => [{ key: 'voice', value: { call } }], () => call);

  async function hydrate() {
    const saved = await getOne<{ call?: Partial<CallSettings> }>('settings', 'voice');
    const c = saved?.call;
    if (c) {
      if (c.input === 'auto' || c.input === 'hold' || c.input === 'type') call.input = c.input;
      if (typeof c.sensitivity === 'number') call.sensitivity = Math.max(0, Math.min(100, c.sensitivity));
      if (typeof c.endSilenceMs === 'number') call.endSilenceMs = Math.max(300, Math.min(3000, c.endSilenceMs));
      if (typeof c.bargeIn === 'boolean') call.bargeIn = c.bargeIn;
    }
    saver.start();
  }

  return { call, hydrate };
});
