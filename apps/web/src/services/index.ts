import { MockLLM } from './mock/llm';
import {
  createNativeBridge,
  MockEmbedding,
  MockMusic,
  MockPush,
  MockSTT,
  MockSync,
  MockTTS,
  MockWeather,
} from './mock/others';

/** 本轮全部是假实现。M1 起逐个替换：接口不变，界面不用改 */
export const services = {
  llm: new MockLLM(),
  tts: new MockTTS(),
  stt: new MockSTT(),
  embedding: new MockEmbedding(),
  music: new MockMusic(),
  weather: new MockWeather(),
  sync: new MockSync(),
  push: new MockPush(),
  native: createNativeBridge(),
};

export { cosine } from './mock/others';
export type * from './types';
