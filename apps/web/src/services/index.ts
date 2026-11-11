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
import { RoutedEmbedding, RoutedImage, RoutedLLM, RoutedTTS } from './ai';
import type {
  EmbeddingClient,
  ImageClient,
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
  image: ImageClient;
  music: MusicClient;
  weather: WeatherClient;
  maps: MapsClient;
  sync: SyncClient;
  push: PushClient;
  native: NativeBridge;
}

/**
 * 对话、语音合成、向量化、生图走多智能体（services/ai.ts）：分配的连接有 Key 时真的调用，否则用演示实现。
 * 语音识别、音乐、天气、地图、同步、推送还是演示实现，之后的里程碑逐个替换：界面只依赖接口，替换时不用改页面
 */
export const services: Services = {
  llm: new RoutedLLM(new MockLLM()),
  tts: new RoutedTTS(new MockTTS()),
  stt: new MockSTT(),
  embedding: new RoutedEmbedding(new MockEmbedding()),
  image: new RoutedImage(),
  music: new MockMusic(),
  weather: new MockWeather(),
  maps: new MockMaps(),
  sync: new MockSync(),
  push: new MockPush(),
  native: createNativeBridge(),
};

export { cosine } from '@app/ai';
export { writeSidestory, type SidestoryOutcome } from './ai';
export { assetUrl } from './assets';
export type * from './types';
