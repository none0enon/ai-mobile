import { MockLLM } from './mock/llm';
import { createNativeBridge, MockEmbedding, MockPush, MockSync, MockTTS } from './mock/others';
import { RoutedEmbedding, RoutedImage, RoutedLLM, RoutedSTT, RoutedTTS } from './ai';
import { RoutedMaps } from './maps';
import { RoutedMusic } from './music';
import { RealWeather } from './weather';
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
 * 语音识别走真实录音与转录接口。
 * 天气是真的（Open-Meteo 免 Key；国内的城市可以用和风天气）；网易云音乐（填了 Worker 地址）和 Google 地图（填了 Key）
 * 在"我的 → 地图、天气、音乐"里接通，没接通时是演示的歌和示意图。同步、推送的这两个接口仍为演示实现。
 */
export const services: Services = {
  llm: new RoutedLLM(new MockLLM()),
  tts: new RoutedTTS(new MockTTS()),
  stt: new RoutedSTT(),
  embedding: new RoutedEmbedding(new MockEmbedding()),
  image: new RoutedImage(),
  music: new RoutedMusic(),
  weather: new RealWeather(),
  maps: new RoutedMaps(),
  sync: new MockSync(),
  push: new MockPush(),
  native: createNativeBridge(),
};

export { cosine } from '@app/ai';
export { writeSidestory, type SidestoryOutcome } from './ai';
export { assetUrl } from './assets';
export type * from './types';
