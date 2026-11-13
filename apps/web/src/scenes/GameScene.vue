<script setup lang="ts">
import { showToast } from 'vant';
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, reactive, ref, type Component } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import SceneShell from '@/components/scene/SceneShell.vue';
import FlightChess from '@/components/scene/game/FlightChess.vue';
import TruthDare from '@/components/scene/game/TruthDare.vue';
import TurtleSoup from '@/components/scene/game/TurtleSoup.vue';
import { useAppStore } from '@/stores/app';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';

/**
 * 一起游戏（设计文档 §9.11）：进来先是游戏列表，点一个进那个游戏（地址上 ?g=游戏），左上角返回回到列表。
 * - 海龟汤（components/scene/game/TurtleSoup.vue）
 * - 真心话大冒险（TruthDare.vue）
 * - 飞行棋（FlightChess.vue）
 * - 装修小屋（decor/DecorGame.vue）：捏你们俩的小人、布置一间 3D 小屋；用到 three.js，点进去时才加载。
 * 回到列表不结束游戏（KeepAlive）：玩到一半回列表、换个游戏，再点回来接着玩，列表上标"进行中"。
 * 这一次玩的都算这一段：离开场景页时那一段写"一起玩了…"（玩完的几局和玩到一半的）。
 */
type Game = 'soup' | 'truthdare' | 'flight' | 'decor';
interface GameInfo {
  id: Game;
  label: string;
  desc: string;
  icon: string;
  tone: string;
  /** 这些阶段算"进行中" */
  busy: string[];
  /** 打开后面板占满（装修要大画面，小人在屋子里，不画立绘） */
  fill?: boolean;
}
const GAMES: GameInfo[] = [
  { id: 'soup', label: '海龟汤', desc: '她出题你猜、一起猜，或者你出题她猜', icon: 'i-lucide-puzzle', tone: '#8fb3f0', busy: ['playing'] },
  { id: 'truthdare', label: '真心话大冒险', desc: '转瓶子定谁先，轮流问、轮流做', icon: 'i-lucide-bottle-wine', tone: '#e88fa6', busy: ['spin', 'playing'] },
  { id: 'flight', label: '飞行棋', desc: '双人 128 格，走到哪一格做哪一格', icon: 'i-lucide-dice-5', tone: '#b9a3e6', busy: ['playing'] },
  { id: 'decor', label: '装修小屋', desc: '捏你们俩的小人，一起布置一间 3D 小屋', icon: 'i-lucide-sofa', tone: '#e7b46a', busy: ['playing'], fill: true },
];
const COMPONENTS: Record<Game, Component> = {
  soup: TurtleSoup,
  truthdare: TruthDare,
  flight: FlightChess,
  // three.js 有点大：点进装修小屋才加载
  decor: defineAsyncComponent(() => import('@/components/scene/game/decor/DecorGame.vue')),
};

const app = useAppStore();
const chars = useCharacterStore();
const chat = useChatStore();
const route = useRoute();
const router = useRouter();
const her = computed(() => chars.byId(app.activeCharacterId) ?? chars.list[0]!);
const chatId = computed(() => chat.chatOfCharacter(her.value.id)?.id ?? '');
const replying = computed(() => !!chat.streams[chatId.value]);

const game = computed<GameInfo | null>(() => GAMES.find((g) => g.id === route.query.g) ?? null);
/** 每个游戏自己的那句话和阶段（回列表再回来还在） */
const lines = reactive<Record<Game, string>>({ soup: '', truthdare: '', flight: '', decor: '' });
const phases = reactive<Record<Game, string>>({ soup: 'menu', truthdare: 'menu', flight: 'menu', decor: 'menu' });
const herLine = computed(() => (game.value ? lines[game.value.id] : ''));
const busy = (g: GameInfo) => g.busy.includes(phases[g.id]);

const notConnected = ref('');
function fail(r: { reason: string; notConnected?: boolean }) {
  if (r.notConnected) notConnected.value = r.reason;
  else showToast(r.reason);
}

function open(g: Game) {
  void router.push({ query: { ...route.query, g } });
}
/** 回列表：从列表点进来的就退一步（系统返回键也是这样），直接打开某个游戏的换成列表 */
function backToList() {
  const back: unknown = window.history.state?.back;
  const fromList = typeof back === 'string' && back.split('?')[0] === route.path && !/[?&]g=/.test(back);
  if (import.meta.env.MODE !== 'preview' && fromList) router.back();
  else {
    const { g: _g, ...rest } = route.query;
    void router.replace({ query: rest });
  }
}

/** 这一次玩完的几局，和玩到一半的（真心话大冒险、飞行棋、装修）：离开时那一段写"一起玩了…" */
const played = ref<string[]>([]);
const progress = reactive<Partial<Record<Game, string | null>>>({});
onMounted(() => {
  chat.setLeaveSummary(her.value.id, () => {
    const all = [...played.value, ...Object.values(progress).filter((s): s is string => !!s)];
    return all.length ? `一起玩了${all.join('、')}` : undefined;
  });
});
onBeforeUnmount(() => {
  // 离开时那一段的总结已经在离开前取走了（ScenePage 的 onBeforeRouteLeave）
  chat.setLeaveSummary(her.value.id, null);
});
</script>

<template>
  <SceneShell
    scene-id="game"
    pose="sit"
    :line="herLine"
    :typing="!!game && replying && !herLine"
    :layout="{ left: 78, bottom: 56, height: 30 }"
    :title="game?.label"
    :fill="!!game?.fill"
    :hide-figure="!!game?.fill"
    :back="game ? backToList : null"
  >
    <div v-if="notConnected" class="notice">
      <span class="i-lucide-plug-zap shrink-0" />
      <span class="flex-1 min-w-0">{{ notConnected }}</span>
      <button class="text-accent-ink shrink-0" @click="router.push('/me/api?feature=companion')">去设置</button>
    </div>

    <KeepAlive>
      <component
        :is="COMPONENTS[game.id]"
        v-if="game"
        :key="game.id"
        v-model:line="lines[game.id]"
        v-model:phase="phases[game.id]"
        @fail="fail"
        @progress="(s: string | null) => (progress[game!.id] = s)"
        @done="(s: string) => played.push(s)"
      />
    </KeepAlive>

    <!-- 游戏列表 -->
    <template v-if="!game">
      <div class="text-[15px] font-600">玩点什么？</div>
      <div class="text-[12.5px] text-ink-3 mt-0.5">点一个开始；玩到一半回来换一个，回去还能接着玩</div>
      <div class="games">
        <button v-for="g in GAMES" :key="g.id" type="button" class="game press" :style="{ '--tone': g.tone }" :data-game="g.id" @click="open(g.id)">
          <span class="icon"><span :class="g.icon" /></span>
          <span class="name">{{ g.label }}</span>
          <span class="desc">{{ g.desc }}</span>
          <span v-if="busy(g)" class="badge">进行中</span>
        </button>
      </div>
    </template>
  </SceneShell>
</template>

<style scoped>
.notice {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  padding: 8px 12px;
  border-radius: 12px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 12.5px;
}
.games {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin-top: 12px;
}
.game {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  min-width: 0;
  padding: 12px;
  border-radius: 18px;
  background: var(--panel);
  border: 1px solid var(--border);
  text-align: left;
}
.icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  margin-bottom: 4px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--tone) 22%, transparent);
  color: var(--tone);
  font-size: 20px;
}
@supports not (background: color-mix(in srgb, red 10%, transparent)) {
  .icon {
    background: var(--accent-soft);
  }
}
.name {
  font-size: 14.5px;
  font-weight: 600;
  color: var(--ink);
}
.desc {
  font-size: 12px;
  line-height: 1.45;
  color: var(--ink-3);
}
.badge {
  position: absolute;
  top: 10px;
  right: 10px;
  padding: 1px 8px;
  border-radius: 99px;
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: 11px;
}
</style>
