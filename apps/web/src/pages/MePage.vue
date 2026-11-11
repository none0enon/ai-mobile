<script setup lang="ts">
import { errorText } from '@app/ai';
import { AGENT_META, type AgentRole } from '@app/shared';
import { closeToast, showLoadingToast, showToast } from 'vant';
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import PersonaAvatar from '@/components/common/PersonaAvatar.vue';
import { personas } from '@/mock/characters';
import { useLibraryStore } from '@/stores/library';
import { memories, album } from '@/mock/memories';
import { todayTouchpoints } from '@/mock/settings';
import { weather } from '@/mock/activity';
import { services, writeSidestory, type SidestoryOutcome } from '@/services';
import { useAiStore } from '@/stores/ai';
import { useAppStore } from '@/stores/app';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';

const router = useRouter();
const app = useAppStore();
const chars = useCharacterStore();
const chat = useChatStore();
const lib = useLibraryStore();
const ai = useAiStore();
const liveAgents = computed(() => (Object.keys(AGENT_META) as AgentRole[]).filter((r) => ai.isLive(r)).length);
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
      { icon: 'i-lucide-library-big', label: '世界书', value: `${lib.lorebooks.length} 本`, to: '/me/lorebooks' },
      { icon: 'i-lucide-sliders-horizontal', label: '预设', value: `${lib.presets.length} 套`, to: '/me/presets' },
      { icon: 'i-lucide-file-down', label: '导入 ST 文件', value: '', desc: '角色卡、世界书、预设、聊天记录', to: '/import' },
    ],
  },
  {
    title: 'AI 与语音',
    rows: [
      {
        icon: 'i-lucide-cpu',
        label: 'API 与智能体',
        value: `${ai.connections.length} 个连接`,
        desc: liveAgents.value ? `${liveAgents.value} 个智能体已接通 · 主对话、番外、生图、向量化……` : '还没填 Key，现在用演示模型',
        to: '/me/api',
      },
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

// —— 番外：她那边发生了什么 ——
const story = ref<SidestoryOutcome | null>(null);
const storyOpen = computed({ get: () => !!story.value, set: (v) => !v && (story.value = null) });
let storyBusy = false;
function storyCharacter() {
  return chars.byId(app.activeCharacterId) ?? chars.list[0]!;
}
async function runSidestory() {
  if (storyBusy) return;
  storyBusy = true;
  const c = storyCharacter();
  const id = chat.chatOfCharacter(c.id)?.id;
  showLoadingToast({ message: `${c.name}那边……`, duration: 0, forbidClick: true });
  try {
    story.value = await writeSidestory(c.id, { recentChat: id ? chat.recentLines(id, 8) : [], userName: me.name });
    closeToast();
  } catch (e) {
    closeToast();
    showToast({ message: `没写出来：${errorText(e)}`.slice(0, 140), duration: 3500 });
  } finally {
    storyBusy = false;
  }
}
/** 番外里她可能会发来的那句话：当作一条主动消息发进聊天 */
function sendHook() {
  const s = story.value;
  const c = chars.byId(s?.characterId);
  const id = c && chat.chatOfCharacter(c.id)?.id;
  if (!s?.hook || !c || !id) return;
  chat.push(id, 'assistant', [{ type: 'text', text: s.hook }], { proactive: true, read: false, expression: 'smile' });
  app.showBanner({ characterId: c.id, title: c.name, text: s.hook, to: `/chat/${id}`, icon: 'i-lucide-bell-ring' });
  story.value = null;
}
/** 番外里最适合配图的一幕：她"发来一张照片"，交给配图流水线 */
function drawStory() {
  const s = story.value;
  const c = chars.byId(s?.characterId);
  const id = c && chat.chatOfCharacter(c.id)?.id;
  if (!s?.cg || !c || !id) return;
  const msg = chat.push(id, 'assistant', [{ type: 'image', assetKey: null, caption: s.cg, generated: false }], { proactive: true, read: false });
  const part = msg.parts[0];
  if (part) chat.redraw(id, part);
  story.value = null;
  void router.push(`/chat/${id}`);
}
</script>

<template>
  <div class="page" data-page="me">
    <div class="page-scroll pb-8">
      <header class="profile gutter pt-[calc(var(--safe-top)+18px)]">
        <RouterLink to="/me/appearance" class="shrink-0" aria-label="换头像"><PersonaAvatar :persona="me" :size="60" /></RouterLink>
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
        <div class="group-title">试一试</div>
        <van-cell-group inset>
          <van-cell
            title="写一段她的番外"
            :label="ai.isLive('sidestory') ? `你不在的时候，${storyCharacter().name}那边发生了什么` : '演示故事；设置好主要 API 后真的写'"
            is-link
            center
            @click="runSidestory"
          >
            <template #icon><span class="i-lucide-book-heart row-icon" /></template>
          </van-cell>
          <van-cell title="模拟一条主动消息" label="顶部会弹横幅；聊天列表出现未读" is-link center @click="demoProactive">
            <template #icon><span class="i-lucide-message-circle-heart row-icon" /></template>
          </van-cell>
          <van-cell title="模拟她打来电话" label="来电界面：接听 / 拒绝 / 回消息" is-link center @click="demoCall">
            <template #icon><span class="i-lucide-phone-incoming row-icon" /></template>
          </van-cell>
        </van-cell-group>
      </section>

      <p class="text-center text-[12px] text-ink-3 mt-6">AI 陪伴（暂名）· M1 · 没填 Key 的部分用演示数据</p>
    </div>

    <!-- 番外 -->
    <van-popup v-model:show="storyOpen" position="bottom" round :style="{ maxHeight: '86%' }">
      <div v-if="story" class="sheet" data-sheet="sidestory">
        <div class="sheet-title">{{ story.title }}</div>
        <div class="text-[12px] text-ink-3 mt-0.5">
          {{ [story.time, story.place, story.mood, story.people.join('、')].filter(Boolean).join(' · ') }}
        </div>
        <p class="story">{{ story.story }}</p>
        <div class="text-[11.5px] text-ink-3">{{ story.demo ? '演示故事' : `番外智能体 · ${story.model}` }}</div>
        <div class="flex gap-2.5 mt-4">
          <van-button v-if="story.cg" round block @click="drawStory">画这一幕</van-button>
          <van-button v-if="story.hook" round block type="primary" @click="sendHook">让她发来："{{ story.hook }}"</van-button>
        </div>
      </div>
    </van-popup>
  </div>
</template>

<style scoped>
.story {
  margin: 14px 0 10px;
  font-size: 15px;
  line-height: 1.85;
  white-space: pre-wrap;
}
.profile {
  display: flex;
  align-items: center;
  gap: 14px;
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
