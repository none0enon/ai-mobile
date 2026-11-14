<script setup lang="ts">
import { AGENT_META, type AgentRole } from '@app/shared';
import { closeToast, showLoadingToast, showToast } from 'vant';
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Avatar from '@/components/common/Avatar.vue';
import PersonaAvatar from '@/components/common/PersonaAvatar.vue';
import PersonTabs from '@/components/common/PersonTabs.vue';
import MomentsSettings from '@/components/settings/MomentsSettings.vue';
import { pwa } from '@/pwa';
import { useLibraryStore } from '@/stores/library';
import { services, writeSidestory, type SidestoryOutcome } from '@/services';
import { pendingForSummary, SUMMARY_KEEP_RECENT } from '@/services/summary';
import { useMessageSettingsStore } from '@/stores/messageSettings';
import { useAiStore } from '@/stores/ai';
import { useAppStore } from '@/stores/app';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';
import { usePersonaStore } from '@/stores/personas';
import { useProactiveStore } from '@/stores/proactive';
import { useRhythmStore } from '@/stores/rhythm';
import { useHubStore } from '@/stores/hub';
import { useServicesStore } from '@/stores/services';
import { useSocialStore } from '@/stores/social';
import { useWeatherStore } from '@/stores/weather';
import { showErrorDialog } from '@/utils/errors';

const router = useRouter();
const app = useAppStore();
const chars = useCharacterStore();
const chat = useChatStore();
const lib = useLibraryStore();
const ai = useAiStore();
const liveAgents = computed(() => (Object.keys(AGENT_META) as AgentRole[]).filter((r) => ai.isLive(r)).length);
const personaStore = usePersonaStore();
const me = computed(() => personaStore.defaultPersona);
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
const THEME_LABEL = { system: '跟随系统', dark: '夜', light: '昼' } as const;
const svc = useServicesStore();
const weather = useWeatherStore();
/** 地图、天气、音乐接通了几个（Open-Meteo 天气免 Key，不算在里面） */
const servicesValue = computed(() => {
  const on = [svc.mapsReady && 'Google 地图', svc.qweatherReady && '和风天气', svc.musicReady && '网易云'].filter(Boolean);
  return on.length ? `${on.length} 个已接通` : '';
});
// —— 朋友圈：显示最近几条、谁自己发（从朋友圈页的"去改"过来时直接打开）——
const social = useSocialStore();
const momentsOpen = ref(useRoute().query.open === 'moments');
const momentsValue = computed(() => {
  const posting = chars.list.filter((c) => social.characterSettings(c.id).enabled).length;
  return [social.settings.visibleCount ? `最近 ${social.settings.visibleCount} 条可见` : '全部可见', posting ? `${posting} 个角色会发` : '都不自动发'].join(' · ');
});
const envValue = computed(() => (weather.mine ? `${weather.mine.place} · ${weather.mine.text} ${weather.temp(weather.mine.tempC)}` : '还没设置城市'));

// —— 补整理聊天：从上次整理到的地方往后，一批一批（消息设置里的 x 条）整理到剩下的不够一批 ——
const msgSettings = useMessageSettingsStore();
const every = computed(() => msgSettings.summaryEvery());
const backfillOpen = ref(false);
const backfillRows = computed(() =>
  chars.list.flatMap((c) => {
    const ch = chat.chatOfCharacter(c.id);
    if (!ch) return [];
    return [{ character: c, chatId: ch.id, pending: pendingForSummary(ch, chat.list(ch.id)).length, progress: chat.backfills[ch.id], busy: !!chat.summarizing[ch.id] }];
  }),
);
type BackfillRow = (typeof backfillRows.value)[number];
const backfillValue = computed(() => {
  const running = backfillRows.value.filter((r) => r.progress).length;
  if (running) return `正在整理 ${running} 个`;
  const ready = backfillRows.value.filter((r) => r.pending >= every.value).length;
  return ready ? `${ready} 个可以补整理` : '';
});
function backfillNote(r: BackfillRow): string {
  if (r.progress) return `已整理 ${r.progress.done} 批，还剩 ${r.progress.remaining} 条`;
  if (r.busy) return '正在整理…';
  if (r.pending >= every.value) return `待整理 ${r.pending} 条，能整理 ${Math.floor(r.pending / every.value)} 批`;
  return r.pending ? `待整理 ${r.pending} 条，不够一批，攒够了会自动整理` : '都整理过了';
}
async function startBackfill(r: BackfillRow) {
  if (!ai.isLive('summary')) return showToast('"总结 / 记忆"还没接通 API');
  const name = r.character.name;
  try {
    const out = await chat.backfill(r.chatId);
    if (!out) showToast(`${name}这边正在整理，等一下再来`);
    else showToast(out.paused ? `${name}：暂停了，已整理 ${out.done} 批` : `${name}：补整理完了，整理了 ${out.done} 批`);
  } catch (e) {
    showErrorDialog(`${name}的聊天补整理停下了`, e);
  }
}

interface Row {
  icon: string;
  label: string;
  value: string;
  to?: string;
  click?: () => void;
}
const groups = computed((): { title: string; rows: Row[] }[] => [
  {
    title: '角色与设定',
    rows: [
      { icon: 'i-lucide-contact-round', label: '角色卡', value: `${chars.list.length} 个`, to: '/me/characters' },
      { icon: 'i-lucide-id-card', label: '我的人设', value: me.value.name, to: '/me/personas' },
      { icon: 'i-lucide-library-big', label: '世界书', value: `${lib.lorebooks.length} 本`, to: '/me/lorebooks' },
      { icon: 'i-lucide-sliders-horizontal', label: '预设', value: `${lib.presets.length} 套`, to: '/me/presets' },
      { icon: 'i-lucide-messages-square', label: '消息设置', value: '', to: '/me/messages' },
      { icon: 'i-lucide-file-down', label: '导入 ST 文件', value: '', to: '/import' },
    ],
  },
  {
    title: 'AI 与语音',
    rows: [
      { icon: 'i-lucide-cpu', label: 'API 设置', value: liveAgents.value ? `${liveAgents.value} 个功能已接通` : '还没填 Key', to: '/me/api' },
      { icon: 'i-lucide-audio-lines', label: '语音', value: '', to: '/me/voice' },
      { icon: 'i-lucide-plug-zap', label: '地图、天气、音乐', value: servicesValue.value, to: '/me/services' },
    ],
  },
  {
    title: '陪伴',
    rows: [
      {
        icon: 'i-lucide-bell-ring',
        label: '主动消息',
        value: !hub.config.active ? '云端未开启' : !chars.list.some((c) => c.proactive.enabled) ? '都没打开' : upcoming.value ? `今天还会找你 ${upcoming.value} 次` : '查看云端计划',
        to: '/me/proactive',
      },
      { icon: 'i-lucide-aperture', label: '朋友圈', value: momentsValue.value, click: () => (momentsOpen.value = true) },
      { icon: 'i-lucide-calendar-clock', label: '节律', value: rhythmValue.value, to: '/me/rhythm' },
      { icon: 'i-lucide-heart-pulse', label: '健康计划', value: me.value.health?.enabled ? '' : '健康系统没开', to: '/me/health' },
      { icon: weather.mine?.icon ?? 'i-lucide-cloud-sun', label: '环境与作息', value: envValue.value, to: '/me/environment' },
    ],
  },
  {
    title: '数据',
    rows: [
      { icon: 'i-lucide-notebook-pen', label: '补整理聊天', value: backfillValue.value, click: () => (backfillOpen.value = true) },
      { icon: 'i-lucide-refresh-cw', label: '云端与同步', value: hub.connected ? (hub.error ? '同步异常' : hub.lastSyncAt ? '已同步' : '等待同步') : '仅本机', to: '/me/sync' },
      { icon: 'i-lucide-palette', label: '外观', value: THEME_LABEL[app.themeSetting], to: '/me/appearance' },
      { icon: 'i-lucide-smartphone', label: '装成 App', value: pwa.standalone ? '已安装' : pwa.canPrompt ? '可以安装' : '', to: '/me/install' },
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
    story.value = await writeSidestory(c.id, { recentChat: id ? chat.recentLines(id, 8) : [], userName: me.value.name });
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

      <section v-for="g in groups" :key="g.title" class="mt-4">
        <div class="group-title">{{ g.title }}</div>
        <van-cell-group inset>
          <van-cell v-for="r in g.rows" :key="r.label" :title="r.label" :value="r.value" is-link :to="r.to" center @click="r.click?.()">
            <template #icon><span :class="r.icon" class="row-icon" /></template>
          </van-cell>
        </van-cell-group>
      </section>

      <section v-if="target" class="mt-4" data-section="try">
        <div class="group-title">试一试</div>
        <PersonTabs v-model="targetId" :characters="chars.list" label="对谁试" class="px-4 pb-2.5" />
        <van-cell-group inset>
          <van-cell :title="`写一段${target.name}的番外`" is-link center @click="runSidestory">
            <template #icon><span class="i-lucide-book-heart row-icon" /></template>
          </van-cell>
          <van-cell :title="`${target.name}发来一条主动消息`" is-link center @click="demoProactive">
            <template #icon><span class="i-lucide-message-circle-heart row-icon" /></template>
          </van-cell>
          <van-cell :title="`让${target.name}打来电话`" is-link center @click="demoCall">
            <template #icon><span class="i-lucide-phone-incoming row-icon" /></template>
          </van-cell>
        </van-cell-group>
      </section>

      <p class="text-center text-[12px] text-ink-3 mt-6">AI 陪伴（暂名）· M1 · 没填 Key 的部分用演示数据</p>
    </div>

    <!-- 朋友圈：显示最近几条、谁自己发 -->
    <van-popup v-model:show="momentsOpen" position="bottom" round teleport="body" :style="{ maxHeight: '86%' }">
      <MomentsSettings v-if="momentsOpen" />
    </van-popup>

    <!-- 补整理聊天 -->
    <van-popup v-model:show="backfillOpen" position="bottom" round teleport="body" :style="{ maxHeight: '80%' }">
      <div class="sheet" data-sheet="backfill">
        <div class="sheet-title">补整理聊天</div>
        <p class="text-[12.5px] text-ink-3 leading-relaxed mt-1 mb-2">
          从上次整理到的地方往后，每 {{ every }} 条一批用「总结 / 记忆」写梗概、故事片段和记忆，直到剩下的不够一批；最近 {{ SUMMARY_KEEP_RECENT }} 条先不整理。可以随时暂停，下次接着来。每批几条在「消息设置」里改。
        </p>
        <RouterLink v-if="!ai.isLive('summary')" to="/me/api" class="text-accent-ink text-[13px]">先接通「总结 / 记忆」API →</RouterLink>
        <div class="grid gap-2 mt-2">
          <div v-for="r in backfillRows" :key="r.chatId" class="backfill-row">
            <Avatar :character="r.character" :size="36" />
            <div class="flex-1 min-w-0">
              <div class="text-[14.5px] font-600">{{ r.character.name }}</div>
              <div class="text-[12px] text-ink-3">{{ backfillNote(r) }}</div>
            </div>
            <van-button v-if="r.progress" size="small" round type="warning" @click="chat.pauseBackfill(r.chatId)">暂停</van-button>
            <van-button v-else size="small" round :disabled="!ai.isLive('summary') || r.busy || r.pending < every" @click="startBackfill(r)">补整理</van-button>
          </div>
        </div>
      </div>
    </van-popup>

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
.backfill-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 16px;
  background: var(--panel);
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
