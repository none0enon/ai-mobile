import { MockLLM } from './mock/llm';
import {
  createNativeBridge,
  MockEmbedding,
  MockMaps,
  MockMusic,
  MockPush,
  MockSTT,
  MockSync,
  MockTTS,
  MockWeather,
} from './mock/others';
import type {
  EmbeddingClient,
  LLMClient,
  MapsClient,
  MusicClient,
  NativeBridge,
  PushClient,
  STTClient,
  SyncClient,
  TTSClient,
  WeatherClient,
} from './types';

export interface Services {
  llm: LLMClient;
  tts: TTSClient;
  stt: STTClient;
  embedding: EmbeddingClient;
  music: MusicClient;
  weather: WeatherClient;
  maps: MapsClient;
  sync: SyncClient;
  push: PushClient;
  native: NativeBridge;
}

/** 本轮全部是假实现。M1 起逐个替换：界面只依赖接口，替换时不用改页面 */
export const services: Services = {
  llm: new MockLLM(),
  tts: new MockTTS(),
  stt: new MockSTT(),
  embedding: new MockEmbedding(),
  music: new MockMusic(),
  weather: new MockWeather(),
  maps: new MockMaps(),
  sync: new MockSync(),
  push: new MockPush(),
  native: createNativeBridge(),
};

export { cosine } from './mock/others';
export type * from './types';
