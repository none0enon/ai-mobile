// 别的 App 分享过来的链接：要在路由创建之前处理（见 shareTarget.ts）
import './shareTarget';
import { createPinia } from 'pinia';
import { createApp } from 'vue';
// Vant 的函数式组件（Toast / Dialog / ImagePreview）不会被自动引入样式，这里手动引入
import 'vant/es/toast/style';
import 'vant/es/dialog/style';
import 'vant/es/image-preview/style';
import './styles/tokens.css';
import './styles/base.css';
import './styles/vant.css';
import 'virtual:uno.css';
import App from './App.vue';
import { initPwa } from './pwa';
import { router } from './router';
import { resumeAudioContext, unlockAudio } from './services/audio';
import { useAiStore } from './stores/ai';
import { useAppStore } from './stores/app';
import { useCharacterStore } from './stores/characters';
import { useChatStore } from './stores/chat';
import { useLibraryStore } from './stores/library';
import { useProactiveStore } from './stores/proactive';
import { useSoupStore } from './stores/soups';
import { useBookStore } from './stores/books';
import { useHubStore } from './stores/hub';
import { useEnvironmentStore } from './stores/environment';
import { useGalleryStore } from './stores/gallery';
import { useRhythmStore } from './stores/rhythm';
import { useVoiceStore } from './stores/voice';
import { useMessageSettingsStore } from './stores/messageSettings';
import { useMemoryStore } from './stores/memory';
import { usePersonaStore } from './stores/personas';
import { useHomeStore } from './stores/home';
import { useHealthStore } from './stores/health';
import { maybeAutoConsolidate } from './services/consolidate';
import { useServicesStore } from './stores/services';
import { useRealWorldStore } from './stores/realworld';
import { useWeatherStore } from './stores/weather';
import { startup } from './startup';

if (import.meta.env.MODE === 'preview') {
  // Claude Artifact 预览：外层已处理安全区
  document.documentElement.classList.add('is-artifact');
}

try {
  // 申请持久化存储，减少 iOS / 浏览器清理本地数据的概率（M1 起本地库存在 IndexedDB）
  navigator.storage?.persist?.().catch(() => undefined);
} catch {
  // 忽略
}

// 装成 App：正式构建注册 Service Worker（断网也能打开），接住浏览器的"可以安装"事件（单文件预览版不注册）
initPwa(import.meta.env.PROD && import.meta.env.MODE !== 'preview');

const app = createApp(App).use(createPinia()).use(router);

// 先读本机数据库（导入的角色、世界书、预设、聊天），再挂载：刷新后直接打开导入角色的聊天也找得到
// 所有 store 仍并发读取；升级阻塞或读取失败时展示恢复入口，不能挂载可编辑的空数据页面。
const hydrated = Promise.allSettled([
  useAiStore().hydrate(),
  // 地图、天气、音乐的 Key 和地址（真实世界、天气要先读出来）
  useServicesStore().hydrate(),
  useLibraryStore().hydrate(),
  useCharacterStore().hydrate(),
  useChatStore().hydrate(),
  useHubStore().hydrate(),
  useEnvironmentStore().hydrate(),
  useSoupStore().hydrate(),
  useBookStore().hydrate(),
  // 节律要先读出来：导入角色"建世界"生成的世界要在打开地图、场景之前登记好
  useRhythmStore().hydrate(),
  useGalleryStore().hydrate(),
  useVoiceStore().hydrate(),
  // 消息设置：发送条数、显示条数、HTML 渲染、总结
  useMessageSettingsStore().hydrate(),
  // 记忆：事实记忆、故事片段、时间线、画像卡
  useMemoryStore().hydrate(),
  // 我的人设（含家务系统、健康系统的设置）、家务的记录、健康计划和运动记录
  usePersonaStore().hydrate(),
  useHomeStore().hydrate(),
  useHealthStore().hydrate(),
]);

// iPhone 上只有用户点过屏幕后"解锁"的 <audio> 才能在网络请求之后播放语音：第一次点屏幕时解锁
const unlock = () => {
  if (unlockAudio()) document.removeEventListener('pointerdown', unlock, true);
};
document.addEventListener('pointerdown', unlock, true);
// 之后每次点屏幕顺手恢复被挂起的 AudioContext（切后台回来、iPhone 来电之后白噪音和通话的说话检测会停）
document.addEventListener('pointerdown', resumeAudioContext, true);

/** "一起""回忆"、地图默认陪着你的角色：最近聊过的那个（不是固定的第一个） */
function followLatestChat() {
  const chars = useCharacterStore();
  const latest = [...useChatStore().chats].filter((c) => chars.byId(c.characterId)).sort((a, b) => b.lastMessageAt - a.lastMessageAt)[0];
  if (latest) useAppStore().activeCharacterId = latest.characterId;
}

app.mount('#app');
void hydrated.then(async (results) => {
  if (results.some((r) => r.status === 'rejected')) {
    startup.error = true;
    return;
  }
  // 旧摘要持久化后再开放页面、结束场景，避免和场景结束时触发的自动总结重叠。
  const chats = useChatStore();
  await useMemoryStore().migrateChatSummaries(chats.chats, chats.list);
  chats.endLeftoverScenes();
  followLatestChat();
  startup.ready = true;
  useRhythmStore().start();
  useHomeStore().start();
  void useRealWorldStore().start().finally(() => useWeatherStore().start());
  useProactiveStore().start();
  useHubStore().start();
  void maybeAutoConsolidate(useHubStore().connected);
}).catch(() => { startup.error = true; });
