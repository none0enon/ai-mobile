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
import { unlockAudio } from './services/audio';
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
// 个别 WebView 里 IndexedDB 可能一直不回应：最多等 1.5 秒，读到的数据之后再补进来
const hydrated = Promise.allSettled([useAiStore().hydrate(), useLibraryStore().hydrate(), useCharacterStore().hydrate(), useChatStore().hydrate(), useHubStore().hydrate(), useEnvironmentStore().hydrate(), useSoupStore().hydrate(), useBookStore().hydrate()]);

// iPhone 上只有用户点过屏幕后"解锁"的 <audio> 才能在网络请求之后播放语音：第一次点屏幕时解锁
const unlock = () => {
  if (unlockAudio()) document.removeEventListener('pointerdown', unlock, true);
};
document.addEventListener('pointerdown', unlock, true);

/** "一起""回忆"、地图默认陪着你的角色：最近聊过的那个（不是固定的第一个） */
function followLatestChat() {
  const chars = useCharacterStore();
  const latest = [...useChatStore().chats].filter((c) => chars.byId(c.characterId)).sort((a, b) => b.lastMessageAt - a.lastMessageAt)[0];
  if (latest) useAppStore().activeCharacterId = latest.characterId;
}

Promise.race([hydrated, new Promise((r) => setTimeout(r, 1500))]).finally(() => {
  app.mount('#app');
  // 界面展示排期；云端同步只在所有本机上下文读完后启动，避免上传半份数据。
  // IndexedDB 卡住时仍显示本机界面，但云端同步等待完整读取。
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  void Promise.race([hydrated, wait(5000)]).then(async () => {
    followLatestChat();
    const proactive = useProactiveStore();
    proactive.start();
    void hydrated.then((results) => {
      if (results.every((r) => r.status === 'fulfilled')) useHubStore().start();
      else useHubStore().error = '本机数据未读完整，云端同步未启动；请重新打开 App';
    });
  });
});
