<script setup lang="ts">
import { showToast } from 'vant';
import { computed, onMounted, ref } from 'vue';
import ErrorDetails from '@/components/common/ErrorDetails.vue';
import HScroll from '@/components/common/HScroll.vue';
import { songs as demoSongs } from '@/mock/music';
import { services, type SongInfo, type SongList } from '@/services';
import { extractId } from '@/services/music';
import { musicLibrary, saveList } from '@/services/musicLibrary';
import type { MusicPlayer, PlaylistSearch, PlayMode, QueueSource } from '@/services/musicPlayer';
import { useServicesStore } from '@/stores/services';
import { clock } from '@/utils/time';

/**
 * 挑一个歌单放（哄睡、共同的家、健身各用自己的播放器 services/musicPlayer.ts，播放列表各存各的，下次打开还在）：
 * - 这件事自带的几个（searches）：哄睡是"助眠 钢琴曲"这类，做家务是轻快的，健身是有节奏的；
 * - 我们的歌单：一起听歌时点 ♡ 的歌、存下来的网易云歌单 / 专辑（services/musicLibrary.ts，和一起听歌共用）；
 * - 更多：自己搜一个词、贴网易云歌单 / 专辑的链接（能存进我们的歌单）。
 * 再点正在放的歌单是接着放。她说话时音乐压低一点（场景管），哄睡定时到点慢慢变小。
 * 没填网易云 Worker 时只有示例歌单（虚构的歌、不出声）。
 */
const props = withDefaults(defineProps<{ player: MusicPlayer; searches: PlaylistSearch[]; testId?: string }>(), { testId: 'playlist-music' });
const music = props.player;
const svc = useServicesStore();
const player = music.state;
const real = computed(() => svc.musicReady);
const song = computed(() => music.current());

interface Pick {
  key: string;
  name: string;
  icon?: string;
  cover?: string | null;
  count?: number;
  load(): Promise<SongInfo[]>;
}

const picks = computed<Pick[]>(() => {
  if (!real.value) return [{ key: 'demo', name: '示例歌单', icon: 'i-lucide-disc-3', count: demoSongs.length, load: async () => demoSongs }];
  const out: Pick[] = props.searches.map((s) => ({ key: `q:${s.keyword}`, name: s.name, icon: s.icon, load: () => services.music.search(s.keyword, 30) }));
  const liked = musicLibrary.liked;
  if (liked.length) out.push({ key: 'liked', name: '一起喜欢的歌', icon: 'i-lucide-heart', count: liked.length, load: async () => liked });
  for (const l of musicLibrary.lists) out.push({ key: l.key, name: l.name, cover: l.cover, count: l.songs.length, load: async () => l.songs });
  // 自己搜的、导入了还没存的：正在放的这个也排进来
  const src = player.source;
  if (src && player.queue.length && !out.some((p) => p.key === src.key)) {
    const songs = player.queue.slice();
    out.push({ key: src.key, name: src.name, icon: 'i-lucide-list-music', count: songs.length, load: async () => songs });
  }
  return out;
});

onMounted(() => {
  // 接上网易云以后，列表里留着的示例歌放不出来：清掉
  if (real.value && player.queue.some((s) => demoSongs.some((d) => d.id === s.id))) music.clearQueue();
});

// —— 挑歌单 ——
const loadingKey = ref('');
const pickError = ref('');
let pickRun = 0;

/** 换成这个列表放（随机播放时从随机的一首开始） */
function playSongs(songs: SongInfo[], source: QueueSource, start?: number) {
  const i = start ?? (player.mode === 'shuffle' ? Math.floor(Math.random() * songs.length) : 0);
  void music.playList(songs, i, source);
}

async function choose(p: Pick) {
  // 在点击里先解锁 <audio>：iPhone 上取完歌单、地址以后才能出声
  music.prime();
  pickError.value = '';
  if (player.source?.key === p.key && player.queue.length) {
    if (!player.playing || player.fading) void music.toggle(true);
    return;
  }
  const run = (pickRun += 1);
  loadingKey.value = p.key;
  try {
    const songs = await p.load();
    if (run !== pickRun) return;
    if (!songs.length) pickError.value = `"${p.name}"里没有歌`;
    else playSongs(songs, { key: p.key, name: p.name });
  } catch (e) {
    if (run === pickRun) pickError.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (run === pickRun) loadingKey.value = '';
  }
}

// —— 播放控制（在点击里先解锁 <audio>） ——
function onToggle() {
  music.prime();
  if (!player.queue.length) {
    const first = picks.value[0];
    if (first) void choose(first);
    return;
  }
  // 渐弱时点播放：不再变小，接着放
  void music.toggle(player.fading ? true : undefined);
}
function onNext() {
  music.prime();
  void music.next();
}
const MODES: Record<PlayMode, { icon: string; label: string }> = {
  list: { icon: 'i-lucide-repeat', label: '顺序播放' },
  shuffle: { icon: 'i-lucide-shuffle', label: '随机播放' },
  single: { icon: 'i-lucide-repeat-1', label: '单曲循环' },
};
function cycleMode() {
  const order: PlayMode[] = ['list', 'shuffle', 'single'];
  music.setMode(order[(order.indexOf(player.mode) + 1) % order.length]!);
}
const volume = computed({
  get: () => Math.round(player.volume * 100),
  set: (v: number) => music.setVolume(v / 100),
});
const subtitle = computed(() => {
  if (player.fading) return '慢慢变小……';
  const s = song.value;
  if (!s) return player.queue.length ? `${player.source?.name ?? '播放列表'} · 点 ▶ 接着放` : '挑一个歌单';
  return [s.artist, player.source?.name].filter(Boolean).join(' · ');
});

// —— 更多：自己搜一个、贴歌单 / 专辑链接 ——
const moreOpen = ref(false);
const moreTab = ref<'search' | 'import'>('search');
const keyword = ref('');
const results = ref<SongInfo[]>([]);
const searched = ref('');
const searching = ref(false);
const searchError = ref('');
async function search() {
  const k = keyword.value.trim();
  if (!k && real.value) return;
  searching.value = true;
  searchError.value = '';
  try {
    results.value = await services.music.search(k, 40);
    searched.value = k;
    if (!results.value.length) searchError.value = '没搜到，换个词试试';
  } catch (e) {
    results.value = [];
    searchError.value = e instanceof Error ? e.message : String(e);
  } finally {
    searching.value = false;
  }
}
/** 搜到的歌就是一个歌单：从点的那首开始放 */
function playResults(start?: number) {
  if (!results.value.length) return;
  music.prime();
  pickError.value = '';
  playSongs(results.value, { key: `q:${searched.value}`, name: searched.value ? `搜"${searched.value}"` : '搜到的歌' }, start);
  moreOpen.value = false;
}

const importType = ref<'playlist' | 'album'>('playlist');
const importText = ref('');
const imported = ref<(SongList & { key: string; type: 'playlist' | 'album' }) | null>(null);
const importing = ref(false);
const importError = ref('');
async function doImport() {
  const v = importText.value.trim();
  if (!v) return;
  if (/163cn\.tv|y\.music\.163\.com\/m\/s/i.test(v) && extractId(v) === v) {
    importError.value = '这是网易云的短链接，网页里展不开：在网易云 App 里"复制链接"后贴带 id= 的那种，或者直接贴歌单 id';
    return;
  }
  importing.value = true;
  importError.value = '';
  try {
    const list = importType.value === 'playlist' ? await services.music.playlist(v) : await services.music.album(v);
    imported.value = { ...list, key: `${importType.value}:${extractId(v)}`, type: importType.value };
    if (!list.songs.length) importError.value = '解析到了，但里面没有歌';
  } catch (e) {
    imported.value = null;
    importError.value = e instanceof Error ? e.message : String(e);
  } finally {
    importing.value = false;
  }
}
function playImported() {
  const l = imported.value;
  if (!l?.songs.length) return;
  music.prime();
  pickError.value = '';
  playSongs(l.songs, { key: l.key, name: l.name });
  moreOpen.value = false;
}
function saveImported() {
  const l = imported.value;
  if (l) showToast(saveList(l) ? `存进我们的歌单了：${l.name}` : '存不下了（浏览器存储满了或者被禁用了）');
}
</script>

<template>
  <div class="mt-3" :data-testid="testId">
    <div class="now">
      <span class="disc" :class="{ spin: player.playing && !player.fading }" :style="{ '--hue': song?.hue ?? 255 }">
        <img v-if="song?.cover" :src="`${song.cover}?param=100y100`" alt="" referrerpolicy="no-referrer" />
      </span>
      <div class="flex-1 min-w-0">
        <div class="text-[14.5px] font-600 truncate">{{ song?.title ?? '音乐' }}</div>
        <div class="text-[12px] text-ink-3 truncate">{{ subtitle }}</div>
      </div>
      <button class="ctl" aria-label="下一首" :disabled="!player.queue.length" @click="onNext"><span class="i-lucide-skip-forward" /></button>
      <button class="play" :aria-label="player.playing && !player.fading ? '暂停音乐' : '播放音乐'" data-testid="music-play" @click="onToggle">
        <span v-if="player.loading || (loadingKey && !player.playing)" class="i-lucide-loader-circle spin-icon" />
        <span v-else :class="player.playing && !player.fading ? 'i-lucide-pause' : 'i-lucide-play'" />
      </button>
    </div>

    <div v-if="!real" class="notice">
      <span class="i-lucide-plug text-[15px] shrink-0" />
      <span class="flex-1 min-w-0">没接网易云：现在是示例歌单，不出声</span>
      <RouterLink to="/me/services" class="text-accent-ink font-600 shrink-0">去接入</RouterLink>
    </div>
    <ErrorDetails v-if="pickError" :detail="pickError" :title="pickError" max-height="100px" />
    <ErrorDetails v-else-if="player.error" :detail="player.error" :title="player.error" max-height="100px" />
    <button v-if="player.needsTap" class="notice tap" @click="onToggle"><span class="i-lucide-play" />浏览器要你点一下才能出声 · 点这里播放</button>

    <div class="text-[12.5px] text-ink-3 mt-3 mb-1.5">歌单</div>
    <HScroll :active="player.source?.key ?? null" class="gap-2" aria-label="歌单">
      <button
        v-for="p in picks"
        :key="p.key"
        class="chip-opt"
        :class="{ on: player.source?.key === p.key }"
        :aria-pressed="player.source?.key === p.key"
        :data-list="p.key"
        @click="choose(p)"
      >
        <span v-if="loadingKey === p.key" class="i-lucide-loader-circle spin-icon" />
        <img v-else-if="p.cover" :src="`${p.cover}?param=60y60`" class="chip-cover" alt="" referrerpolicy="no-referrer" loading="lazy" />
        <span v-else-if="p.icon" :class="p.icon" />
        <span class="max-w-[9em] truncate">{{ p.name }}</span>
        <span v-if="p.count" class="num opacity-70">{{ p.count }}</span>
      </button>
      <button class="chip-opt" data-testid="music-more" @click="moreOpen = true"><span class="i-lucide-plus" />搜一个 / 导入</button>
    </HScroll>

    <div class="flex items-center gap-3 mt-3">
      <button class="mode-btn" :aria-label="MODES[player.mode].label" @click="cycleMode"><span :class="MODES[player.mode].icon" />{{ MODES[player.mode].label }}</button>
      <span class="i-lucide-volume-1 text-ink-3 shrink-0" />
      <van-slider v-model="volume" class="flex-1" bar-height="4px" button-size="16px" aria-label="音乐音量" />
    </div>

    <!-- 更多：搜一个 / 导入歌单。挂到 .app-frame 上：场景面板有毛玻璃（backdrop-filter），弹层放在里面会被面板框住；也还在点缀色的范围里 -->
    <van-popup v-model:show="moreOpen" position="bottom" round :style="{ height: '72%' }" teleport=".app-frame">
      <div class="sheet-body">
        <div class="flex items-center gap-2 mb-2">
          <div class="seg">
            <button :class="{ on: moreTab === 'search' }" @click="moreTab = 'search'">搜一个</button>
            <button :class="{ on: moreTab === 'import' }" @click="moreTab = 'import'">导入歌单 / 专辑</button>
          </div>
          <span class="flex-1" />
          <RouterLink to="/me/services" class="gear" aria-label="网易云设置"><span class="i-lucide-settings-2" /></RouterLink>
        </div>
        <template v-if="moreTab === 'search'">
          <form class="flex gap-2" @submit.prevent="search">
            <input v-model="keyword" class="field" :placeholder="real ? '歌名、歌手，或者“助眠”这样的词' : '搜示例歌曲'" aria-label="搜歌" enterkeyhint="search" />
            <van-button type="primary" round size="small" native-type="submit" :loading="searching">搜索</van-button>
          </form>
          <p class="text-[12px] text-ink-3 my-2">搜到的歌就是一个歌单，从点的那首开始放。{{ real ? '' : '没接网易云：搜到的是示例歌曲。' }}</p>
          <ErrorDetails v-if="searchError" :detail="searchError" :title="searchError" max-height="100px" />
          <van-button v-if="results.length" class="!mb-1" size="mini" round type="primary" @click="playResults()">全部播放（{{ results.length }} 首）</van-button>
          <div class="results">
            <button v-for="(s, i) in results" :key="s.id" class="song-row" @click="playResults(i)">
              <img v-if="s.cover" :src="`${s.cover}?param=100y100`" class="cover" alt="" referrerpolicy="no-referrer" loading="lazy" />
              <span v-else class="cover" :style="{ '--hue': s.hue }" />
              <span class="flex-1 min-w-0 text-left">
                <span class="block truncate text-[14.5px]">{{ s.title }}</span>
                <span class="block truncate text-[12px] text-ink-3">{{ s.artist }}{{ s.album ? ` · ${s.album}` : '' }}</span>
              </span>
              <span class="num text-[12px] text-ink-3 shrink-0">{{ s.durationMs ? clock(s.durationMs / 1000) : '' }}</span>
            </button>
          </div>
        </template>
        <template v-else>
          <div class="flex gap-2">
            <select v-model="importType" class="field !flex-none !w-[84px]" aria-label="类型">
              <option value="playlist">歌单</option>
              <option value="album">专辑</option>
            </select>
            <input v-model="importText" class="field" placeholder="id 或链接，例如 music.163.com/playlist?id=…" aria-label="歌单或专辑的 id 或链接" @keydown.enter="doImport" />
          </div>
          <van-button class="!mt-2" type="primary" round block size="small" :loading="importing" :disabled="!real" @click="doImport">解析</van-button>
          <p v-if="!real" class="text-[12px] text-ink-3 mt-2">要先接网易云（填 Worker 地址）才能导入。</p>
          <ErrorDetails v-if="importError" :detail="importError" :title="importError" max-height="100px" />
          <template v-if="imported && imported.songs.length">
            <div class="flex items-center gap-2 mt-3">
              <span class="flex-1 min-w-0 truncate font-600">{{ imported.name }}（{{ imported.songs.length }} 首）</span>
              <van-button size="mini" round @click="saveImported">存进我们的歌单</van-button>
              <van-button size="mini" round type="primary" @click="playImported">全部播放</van-button>
            </div>
            <div class="results">
              <div v-for="s in imported.songs" :key="s.id" class="song-row">
                <img v-if="s.cover" :src="`${s.cover}?param=100y100`" class="cover" alt="" referrerpolicy="no-referrer" loading="lazy" />
                <span v-else class="cover" :style="{ '--hue': s.hue }" />
                <span class="flex-1 min-w-0">
                  <span class="block truncate text-[14.5px]">{{ s.title }}</span>
                  <span class="block truncate text-[12px] text-ink-3">{{ s.artist }}</span>
                </span>
              </div>
            </div>
          </template>
          <p class="text-[12px] text-ink-3 mt-3">存进我们的歌单以后，这里和"一起听歌"都能一点就放；删掉在"一起听歌 → 我们的歌单"里。</p>
        </template>
      </div>
    </van-popup>
  </div>
</template>

<style scoped>
.now {
  display: flex;
  align-items: center;
  gap: 10px;
}
.disc {
  position: relative;
  width: 46px;
  height: 46px;
  border-radius: 50%;
  flex-shrink: 0;
  overflow: hidden;
  background:
    radial-gradient(circle, #111 0 9%, transparent 9.5%),
    radial-gradient(circle, hsl(var(--hue) 55% 62%) 0 34%, transparent 34.5%),
    repeating-radial-gradient(circle, #1d1822 0 2px, #0f0c13 2px 4px);
}
.disc img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.disc.spin {
  animation: spin 14s linear infinite;
}
.ctl {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 19px;
  color: var(--ink);
  flex-shrink: 0;
}
.ctl:disabled {
  opacity: 0.4;
}
.play {
  width: 46px;
  height: 46px;
  border-radius: 50%;
  background: var(--accent);
  color: var(--on-accent);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
  flex-shrink: 0;
}
.spin-icon {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.notice {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  padding: 7px 12px;
  border-radius: 12px;
  background: var(--panel);
  font-size: 12.5px;
  color: var(--ink-2);
}
.notice.tap {
  width: 100%;
  justify-content: center;
  color: var(--accent-ink);
  border: 1px solid var(--accent-line);
}
.chip-opt {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 32px;
  padding: 0 12px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 13px;
  white-space: nowrap;
  flex-shrink: 0;
}
.chip-opt.on {
  background: var(--accent);
  color: var(--on-accent);
  font-weight: 600;
}
.chip-cover {
  width: 20px;
  height: 20px;
  margin-left: -6px;
  border-radius: 50%;
  object-fit: cover;
}
.mode-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 30px;
  padding: 0 10px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 12.5px;
  flex-shrink: 0;
}
.sheet-body {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 16px 16px calc(12px + var(--safe-bottom));
}
.seg {
  display: inline-flex;
  padding: 3px;
  border-radius: 99px;
  background: var(--panel);
}
.seg button {
  height: 30px;
  padding: 0 12px;
  border-radius: 99px;
  font-size: 13px;
  color: var(--ink-2);
}
.seg button.on {
  background: var(--surface);
  color: var(--ink);
  font-weight: 600;
  box-shadow: var(--shadow-sm, 0 1px 3px rgba(0, 0, 0, 0.12));
}
.gear {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 17px;
}
.field {
  flex: 1;
  min-width: 0;
  height: 36px;
  padding: 0 14px;
  border-radius: 18px;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--ink);
  outline: none;
}
.results {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  margin-top: 6px;
}
.song-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 0;
}
.cover {
  width: 42px;
  height: 42px;
  border-radius: 10px;
  background: linear-gradient(135deg, hsl(var(--hue) 60% 65%), hsl(calc(var(--hue) + 40) 50% 40%));
  object-fit: cover;
  flex-shrink: 0;
}
</style>
