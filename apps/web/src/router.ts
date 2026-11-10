import { createMemoryHistory, createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router';
import TabLayout from '@/layouts/TabLayout.vue';
import CallPage from '@/pages/CallPage.vue';
import ChatPage from '@/pages/ChatPage.vue';
import ChatsPage from '@/pages/ChatsPage.vue';
import ImportPage from '@/pages/ImportPage.vue';
import MemoriesPage from '@/pages/MemoriesPage.vue';
import MePage from '@/pages/MePage.vue';
import PromptInspectorPage from '@/pages/PromptInspectorPage.vue';
import MapPage from '@/pages/MapPage.vue';
import ScenePage from '@/pages/ScenePage.vue';
import ApiPage from '@/pages/me/ApiPage.vue';
import AppearancePage from '@/pages/me/AppearancePage.vue';
import CharacterEditPage from '@/pages/me/CharacterEditPage.vue';
import CharactersPage from '@/pages/me/CharactersPage.vue';
import EnvironmentPage from '@/pages/me/EnvironmentPage.vue';
import LorebookEditPage from '@/pages/me/LorebookEditPage.vue';
import LorebooksPage from '@/pages/me/LorebooksPage.vue';
import PersonasPage from '@/pages/me/PersonasPage.vue';
import PresetEditPage from '@/pages/me/PresetEditPage.vue';
import PresetsPage from '@/pages/me/PresetsPage.vue';
import ProactivePage from '@/pages/me/ProactivePage.vue';
import SyncPage from '@/pages/me/SyncPage.vue';
import VoicePage from '@/pages/me/VoicePage.vue';

export const routes: RouteRecordRaw[] = [
  {
    path: '/',
    component: TabLayout,
    redirect: '/chats',
    children: [
      { path: 'chats', component: ChatsPage, meta: { title: '消息' } },
      { path: 'map', component: MapPage, meta: { title: '地图' } },
      { path: 'memories', component: MemoriesPage, meta: { title: '回忆' } },
      { path: 'me', component: MePage, meta: { title: '我的' } },
    ],
  },
  { path: '/together', redirect: '/map' },
  { path: '/chat/:id', component: ChatPage, meta: { title: '聊天' } },
  { path: '/chat/:id/inspect', component: PromptInspectorPage, meta: { title: '查看提示词' } },
  { path: '/call/:charId', component: CallPage, meta: { title: '语音通话' } },
  { path: '/scene/:sceneId', component: ScenePage, meta: { title: '场景' } },
  { path: '/me/characters', component: CharactersPage, meta: { title: '角色卡' } },
  { path: '/me/characters/:id', component: CharacterEditPage, meta: { title: '编辑角色' } },
  { path: '/me/personas', component: PersonasPage, meta: { title: '我的人设' } },
  { path: '/me/lorebooks', component: LorebooksPage, meta: { title: '世界书' } },
  { path: '/me/lorebooks/:id', component: LorebookEditPage, meta: { title: '编辑世界书' } },
  { path: '/me/presets', component: PresetsPage, meta: { title: '预设' } },
  { path: '/me/presets/:id', component: PresetEditPage, meta: { title: '编辑预设' } },
  { path: '/me/api', component: ApiPage, meta: { title: 'API 与智能体' } },
  { path: '/me/voice', component: VoicePage, meta: { title: '语音' } },
  { path: '/me/proactive', component: ProactivePage, meta: { title: '主动消息' } },
  { path: '/me/environment', component: EnvironmentPage, meta: { title: '环境与作息' } },
  { path: '/me/sync', component: SyncPage, meta: { title: '同步与备份' } },
  { path: '/me/appearance', component: AppearancePage, meta: { title: '外观' } },
  { path: '/import', component: ImportPage, meta: { title: '导入' } },
  { path: '/:pathMatch(.*)*', redirect: '/chats' },
];

/** 预览页（Claude Artifact）不支持 #/path 形式的地址，改用内存路由；正式版用 hash 路由 */
const isPreview = import.meta.env.MODE === 'preview';

export const router = createRouter({
  history: isPreview ? createMemoryHistory() : createWebHashHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
});

/**
 * 内存路由没有"上一页"信息，自己记一个栈：
 * 同一路径只改查询参数（例如切换 IM / 剧场模式）时替换栈顶，返回时出栈。
 */
const stack: string[] = [];
let goingBack = false;

router.afterEach((to, _from, failure) => {
  if (failure) return;
  if (goingBack) {
    goingBack = false;
    return;
  }
  const top = stack.at(-1);
  if (top && top.split('?')[0] === to.path) stack[stack.length - 1] = to.fullPath;
  else stack.push(to.fullPath);
});

/** 返回上一页；没有上一页（例如从通知直接打开）时去逻辑上的父页面 */
export function goBack(fallback: string) {
  if (isPreview) {
    if (stack.length > 1) {
      stack.pop();
      goingBack = true;
      void router.replace(stack.at(-1) as string);
    } else {
      void router.replace(fallback);
    }
    return;
  }
  if (window.history.state?.back) router.back();
  else void router.replace(fallback);
}

/** 截图脚本和"关于"页用：列出所有可访问的页面 */
export function listRoutePaths(): string[] {
  return router
    .getRoutes()
    .filter((r) => !r.redirect)
    .map((r) => r.path)
    .filter((p) => p !== '/' && !p.includes('pathMatch'));
}
