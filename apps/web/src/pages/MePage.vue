<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { connections, agentRoutes } from '@/mock/api';
import { personas } from '@/mock/characters';
import { lorebooks, presets } from '@/mock/library';
import { memories, album } from '@/mock/memories';
import { todayTouchpoints } from '@/mock/settings';
import { weather } from '@/mock/activity';
import { services } from '@/services';
import { useAppStore } from '@/stores/app';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';

const router = useRouter();
const app = useAppStore();
const chars = useCharacterStore();
const chat = useChatStore();
const me = personas.find((p) => p.isDefault) ?? personas[0]!;
const upcoming = todayTouchpoints().filter((t) => t.status === 'planned').length;
const sync = services.sync.status();
const totalMessages = computed(() => Object.values(chat.messages).reduce((n, l) => n + l.length, 0) + 1268);
const THEME_LABEL = { system: '跟随系统', dark: '夜', light: '昼' } as const;

const groups = computed(() => [
  {
    title: '角色与设定',
    rows: [
      { icon: 'i-lucide-contact-round', label: '角色卡', value: `${chars.list.length} 个`, to: '/me/characters' },
      { icon: 'i-lucide-id-card', label: '我的人设', value: me.name, to: '/me/personas' },
      { icon: 'i-lucide-library-big', label: '世界书', value: `${lorebooks.length} 本`, to: '/me/lorebooks' },
      { icon: 'i-lucide-sliders-horizontal', label: '预设', value: `${presets.length} 套`, to: '/me/presets' },
      { icon: 'i-lucide-file-down', label: '导入 ST 文件', value: '', desc: '角色卡、世界书、预设、聊天记录', to: '/import' },
    ],
  },
  {
    title: 'AI 与语音',
    rows: [
      { icon: 'i-lucide-cpu', label: 'API 与智能体', value: `${connections.length} 个连接`, desc: `${agentRoutes.length} 个智能体：主对话、总结、向量化、生图……`, to: '/me/api' },
      { icon: 'i-lucide-audio-lines', label: '语音', value: '', desc: '她们的声音、语音识别、通话', to: '/me/voice' },
    ],
  },
  {
    title: '陪伴',
    rows: [
      { icon: 'i-lucide-bell-ring', label: '主动消息', value: upcoming ? `今天还会找你 ${upcoming} 次` : '今天的都发完了', to: '/me/proactive' },
      { icon: 'i-lucide-cloud-sun', label: '环境与作息', value: `${weather.city} · ${weather.text}`, to: '/me/environment' },
    ],
  },
  {
    title: '数据',
    rows: [
      { icon: 'i-lucide-refresh-cw', label: '同步与备份', value: sync.mode === 'hub' ? '已连接 Worker' : '仅本机', to: '/me/sync' },
      { icon: 'i-lucide-palette', label: '外观', value: THEME_LABEL[app.themeSetting], to: '/me/appearance' },
    ],
  },
]);

function demoProactive() {
  const c = chars.byId(app.activeCharacterId) ?? chars.list[0]!;
  const id = chat.chatOfCharacter(c.id)?.id;
  if (!id) return;
  chat.push(id, 'assistant', [{ type: 'text', text: '在干嘛呀？突然有点想你。' }], { proactive: true, read: false, expression: 'shy' });
  app.showBanner({ characterId: c.id, title: c.name, text: '在干嘛呀？突然有点想你。', to: `/chat/${id}`, icon: 'i-lucide-bell-ring' });
}
function demoCall() {
  void router.push(`/call/${app.activeCharacterId}?incoming=1`);
}
</script>

<template>
  <div class="page" data-page="me">
    <div class="page-scroll pb-8">
      <header class="profile gutter pt-[calc(var(--safe-top)+18px)]">
        <span class="me-avatar">{{ me.name.slice(-1) }}</span>
        <div class="flex-1 min-w-0">
          <div class="text-[22px] font-700">{{ me.name }}</div>
          <div class="text-[12.5px] text-ink-3 line-clamp-2">{{ me.description }}</div>
        </div>
        <RouterLink to="/me/personas" class="switch">切换人设</RouterLink>
      </header>

      <div class="stats mx-4">
        <div><b class="num">30</b><span>相识天数</span></div>
        <div><b class="num">{{ totalMessages.toLocaleString('zh-CN') }}</b><span>条对话</span></div>
        <div><b class="num">{{ memories.length }}</b><span>条记忆</span></div>
        <div><b class="num">{{ album.length }}</b><span>张 CG</span></div>
      </div>

      <section v-for="g in groups" :key="g.title" class="mt-4">
        <div class="group-title">{{ g.title }}</div>
        <van-cell-group inset>
          <van-cell v-for="r in g.rows" :key="r.label" :title="r.label" :value="r.value" :label="'desc' in r ? r.desc : undefined" is-link :to="r.to" center>
            <template #icon><span :class="r.icon" class="row-icon" /></template>
          </van-cell>
        </van-cell-group>
      </section>

      <section class="mt-4">
        <div class="group-title">演示（假数据）</div>
        <van-cell-group inset>
          <van-cell title="模拟一条主动消息" label="顶部会弹横幅；聊天列表出现未读" is-link center @click="demoProactive">
            <template #icon><span class="i-lucide-message-circle-heart row-icon" /></template>
          </van-cell>
          <van-cell title="模拟她打来电话" label="来电界面：接听 / 拒绝 / 回消息" is-link center @click="demoCall">
            <template #icon><span class="i-lucide-phone-incoming row-icon" /></template>
          </van-cell>
        </van-cell-group>
      </section>

      <p class="text-center text-[12px] text-ink-3 mt-6">AI 陪伴（暂名）· M0 界面骨架 · 数据都是演示用的</p>
    </div>
  </div>
</template>

<style scoped>
.profile {
  display: flex;
  align-items: center;
  gap: 14px;
}
.me-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 60px;
  height: 60px;
  border-radius: 50%;
  background: linear-gradient(135deg, #8db8ff, #6f5b9e);
  color: #fff;
  font-size: 24px;
  font-weight: 700;
  flex-shrink: 0;
}
.switch {
  height: 32px;
  padding: 0 12px;
  border-radius: 99px;
  border: 1px solid var(--border);
  font-size: 13px;
  line-height: 30px;
  color: var(--ink-2);
  text-decoration: none;
  flex-shrink: 0;
}
.stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  margin-top: 16px;
  padding: 14px 6px;
  border-radius: 18px;
  background: var(--surface);
  border: 1px solid var(--border);
}
.stats div {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}
.stats b {
  font-size: 18px;
}
.stats span {
  font-size: 11.5px;
  color: var(--ink-3);
}
.group-title {
  padding: 0 16px 8px 28px;
  font-size: 13px;
  color: var(--ink-3);
}
.row-icon {
  margin-right: 12px;
  font-size: 19px;
  color: var(--accent-ink);
}
</style>
