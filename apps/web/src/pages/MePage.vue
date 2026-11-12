<script setup lang="ts">
import { AGENT_META, type AgentRole } from '@app/shared';
import { closeToast, showLoadingToast, showToast } from 'vant';
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import PersonaAvatar from '@/components/common/PersonaAvatar.vue';
import PersonTabs from '@/components/common/PersonTabs.vue';
import { personas } from '@/mock/characters';
import { pwa } from '@/pwa';
import { useLibraryStore } from '@/stores/library';
import { memories, album } from '@/mock/memories';
import { weather } from '@/mock/activity';
import { services, writeSidestory, type SidestoryOutcome } from '@/services';
import { useAiStore } from '@/stores/ai';
import { useAppStore } from '@/stores/app';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';
import { useProactiveStore } from '@/stores/proactive';
import { useRhythmStore } from '@/stores/rhythm';
import { useHubStore } from '@/stores/hub';
import { showErrorDialog } from '@/utils/errors';

const router = useRouter();
const app = useAppStore();
const chars = useCharacterStore();
const chat = useChatStore();
const lib = useLibraryStore();
const ai = useAiStore();
const liveAgents = computed(() => (Object.keys(AGENT_META) as AgentRole[]).filter((r) => ai.isLive(r)).length);
const me = personas.find((p) => p.isDefault) ?? personas[0]!;
const proactive = useProactiveStore();
/** 今天所有打开了主动消息的角色加起来还会来找你几次 */
const upcoming = computed(() => proactive.upcoming());
const hub = useHubStore();
const rhythm = useRhythmStore();
/** 节律那一行：几个每天变化、几个还没有小世界 */
const rhythmValue = computed(() => {
  const daily = chars.list.filter((c) => rhythm.configOf(c.id).settings.mode === 'daily').length;
  const noWorld = chars.list.filter((c) => !rhythm.hasWorld(c.id)).length;
  return [daily ? `${daily} 个每天变化` : '都是固定', noWorld ? `${noWorld} 个还没有小世界` : ''].filter(Boolean).join(' · ');
});
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
        label: 'API 设置',
        value: liveAgents.value ? `${liveAgents.value} 个功能已接通` : '',
        desc: liveAgents.value ? '按功能设置：主对话、番外、生图、语音、向量化……' : '还没填 Key，现在用演示模型',
        to: '/me/api',
      },
      { icon: 'i-lucide-audio-lines', label: '语音', value: '', desc: '她们的声音、语音识别、通话', to: '/me/voice' },
    ],
  },
  {
    title: '陪伴',
    rows: [
      {
        icon: 'i-lucide-bell-ring',
        label: '主动消息',
        value: !hub.config.active ? '云端未开启' : !chars.list.some((c) => c.proactive.enabled) ? '都没打开' : upcoming.value ? `今天还会找你 ${upcoming.value} 次` : '查看云端计划',
        desc: `${chars.list.filter((c) => c.proactive.enabled).map((c) => c.name).join('、') || '还没有角色'}会主动找你`,
        to: '/me/proactive',
      },
      { icon: 'i-lucide-calendar-clock', label: '节律', value: rhythmValue.value, desc: '她们每天的作息、三餐和穿着；导入的角色在这里建小世界', to: '/me/rhythm' },
      { icon: 'i-lucide-cloud-sun', label: '环境与作息', value: `${weather.city} · ${weather.text}`, to: '/me/environment' },
    ],
  },
  {
    title: '数据',
    rows: [
      { icon: 'i-lucide-refresh-cw', label: '云端与同步', value: hub.connected ? '已连接 Worker' : '仅本机', to: '/me/sync' },
      { icon: 'i-lucide-palette', label: '外观', value: THEME_LABEL[app.themeSetting], to: '/me/appearance' },
      {
        icon: 'i-lucide-smartphone',
        label: '装成 App',
        value: pwa.standalone ? '已安装' : pwa.canPrompt ? '可以安装' : '',
        desc: '添加到主屏幕；卸载后装不回去时在这里修复',
        to: '/me/install',
      },
    ],
  },
]);

// —— 试一试：对谁试（所有角色，包括导入的；默认是当前陪着你的那个）——
const targetId = ref(app.activeCharacterId);
const target = computed(() => chars.byId(targetId.value) ?? chars.list[0]);

/** 马上让她发一条主动消息：接通了"主动消息"的 API 就由模型用她的口吻写，没接通用演示台词 */
let simulating = false;
async function demoProactive() {
  const c = target.value;
  if (!c || simulating) return;
  simulating = true;
  const live = ai.isLive('proactive');
  if (live) showLoadingToast({ message: `${c.name}在打字…`, duration: 0, forbidClick: true });
  try {
    const r = await proactive.simulate(c.id);
    if (live) closeToast();
    if (!r.ok) {
      if (r.error) showErrorDialog('主动消息没写出来', r.error);
      else showToast(r.reason);
    } else if (!live && !chars.isDemo(c.id)) {
      showToast(`「主动消息」还没接通 API，${c.name}发的是占位台词`);
    }
  } finally {
    simulating = false;
  }
}
function demoCall() {
  if (target.value) void router.push(`/call/${target.value.id}?incoming=1`);
}

// —— 番外：她那边发生了什么 ——
const story = ref<SidestoryOutcome | null>(null);
const storyOpen = computed({ get: () => !!story.value, set: (v) => !v && (story.value = null) });
let storyBusy = false;
async function runSidestory() {
  const c = target.value;
  if (storyBusy || !c) return;
  storyBusy = true;
  const id = chat.chatOfCharacter(c.id)?.id;
  showLoadingToast({ message: `${c.name}那边……`, duration: 0, forbidClick: true });
  try {
    story.value = await writeSidestory(c.id, { recentChat: id ? chat.recentLines(id, 8) : [], userName: me.name });
    closeToast();
  } catch (e) {
    closeToast();
    showErrorDialog('番外没写出来', e);
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

      <section v-if="target" class="mt-4" data-section="try">
        <div class="group-title">试一试</div>
        <PersonTabs v-model="targetId" :characters="chars.list" label="对谁试" class="px-4 pb-2.5" />
        <van-cell-group inset>
          <van-cell
            :title="`写一段${target.name}的番外`"
            :label="ai.isLive('sidestory') ? `你不在的时候，${target.name}那边发生了什么` : '演示故事；在 API 设置里设置好主对话后真的写'"
            is-link
            center
            @click="runSidestory"
          >
            <template #icon><span class="i-lucide-book-heart row-icon" /></template>
          </van-cell>
          <van-cell
            :title="`${target.name}发来一条主动消息`"
            :label="ai.isLive('proactive') ? `由「主动消息」的模型用${target.pronoun}的口吻写；顶部弹横幅、聊天列表出现未读` : '演示台词；顶部会弹横幅、聊天列表出现未读'"
            is-link
            center
            @click="demoProactive"
          >
            <template #icon><span class="i-lucide-message-circle-heart row-icon" /></template>
          </van-cell>
          <van-cell :title="`让${target.name}打来电话`" label="来电界面：接听后是真的通话（主对话 + 语音识别 + 语音合成）" is-link center @click="demoCall">
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
        <div class="text-[11.5px] text-ink-3">{{ story.demo ? '演示故事' : `番外智能体 · ${story.model}${story.presetName ? ` · 预设「${story.presetName}」` : ''}` }}</div>
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
