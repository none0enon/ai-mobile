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

createApp(App).use(createPinia()).use(router).mount('#app');
