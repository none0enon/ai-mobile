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
import { router } from './router';
import { unlockAudio } from './services/audio';
import { useAiStore } from './stores/ai';
import { useCharacterStore } from './stores/characters';
import { useChatStore } from './stores/chat';
import { useLibraryStore } from './stores/library';

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

const app = createApp(App).use(createPinia()).use(router);

// 先读本机数据库（导入的角色、世界书、预设、聊天），再挂载：刷新后直接打开导入角色的聊天也找得到
// 个别 WebView 里 IndexedDB 可能一直不回应：最多等 1.5 秒，读到的数据之后再补进来
const hydrated = Promise.all([useAiStore().hydrate(), useLibraryStore().hydrate(), useCharacterStore().hydrate(), useChatStore().hydrate()]).catch(() => undefined);

// iPhone 上只有用户点过屏幕后"解锁"的 <audio> 才能在网络请求之后播放语音：第一次点屏幕时解锁
const unlock = () => {
  if (unlockAudio()) document.removeEventListener('pointerdown', unlock, true);
};
document.addEventListener('pointerdown', unlock, true);
Promise.race([hydrated, new Promise((r) => setTimeout(r, 1500))]).finally(() => app.mount('#app'));
