<script setup lang="ts">
import { lrcIndexAt, parseLrc } from '@app/shared';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import SceneShell from '@/components/scene/SceneShell.vue';
import Avatar from '@/components/common/Avatar.vue';
import { danmaku, lyricLrc, lyricTranslation, songs } from '@/mock/music';
import { services, type SongInfo } from '@/services';
import { useAppStore } from '@/stores/app';
import { useCharacterStore } from '@/stores/characters';
import { clock } from '@/utils/time';

/**
 * 一起听歌：封面唱片 + 逐行歌词（带译文）+ 她按歌词发的"弹幕"。
 * 正式版：网易云 Worker /search → /song（地址约 20 分钟过期，播放前现取）→ /lyric。示例歌曲是虚构的。
 */
const app = useAppStore();
const chars = useCharacterStore();
const character = computed(() => chars.byId(app.activeCharacterId) ?? chars.list[0]!);

const song = ref<SongInfo>(songs[0]!);
const lines = parseLrc(lyricLrc, lyricTranslation);
const pos = ref(52_000);
const playing = ref(true);
const liked = ref(true);
const current = computed(() => lrcIndexAt(lines, pos.value));
const comment = ref<{ id: number; text: string } | null>(null);

let timer: ReturnType<typeof setInterval> | undefined;
function setPlaying(on: boolean) {
  playing.value = on;
  clearInterval(timer);
  if (on) {
    timer = setInterval(() => {
      pos.value += 250;
      if (pos.value >= song.value.durationMs) pos.value = 0;
    }, 250);
  }
}
setPlaying(true);
onBeforeUnmount(() => clearInterval(timer));

const lyricsBox = ref<HTMLElement | null>(null);

function scrollToLine(i: number, smooth = true) {
  const box = lyricsBox.value;
  const el = box?.querySelector<HTMLElement>(`[data-line="${i}"]`);
  if (el && box) box.scrollTo({ top: el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2, behavior: smooth ? 'smooth' : 'auto' });
}

watch(current, async (i) => {
  const text = danmaku[i];
  if (text) {
    comment.value = { id: Date.now(), text };
    setTimeout(() => {
      if (comment.value?.text === text) comment.value = null;
    }, 4200);
  }
  await nextTick();
  scrollToLine(i);
});
onMounted(() => scrollToLine(current.value, false));

const listOpen = ref(false);
const searchOpen = ref(false);
const keyword = ref('');
const results = ref<SongInfo[]>([]);
async function search() {
  results.value = await services.music.search(keyword.value);
}
function pickSong(s: SongInfo) {
  song.value = s;
  pos.value = 0;
  listOpen.value = false;
  searchOpen.value = false;
  setPlaying(true);
}
const line = computed(() => (comment.value ? '' : '这首歌，下雨天听刚刚好。'));
</script>

<template>
  <SceneShell scene-id="music" hide-figure :line="line">
    <template #actions>
      <button class="pill-btn" aria-label="搜歌" @click="(searchOpen = true), search()"><span class="i-lucide-search" /></button>
      <button class="pill-btn" aria-label="我们的歌单" @click="listOpen = true"><span class="i-lucide-list-music" /></button>
    </template>

    <template #overlay>
      <div class="vinyl-wrap">
        <div class="vinyl" :class="{ spin: playing }" :style="{ '--hue': song.hue }"><span class="label" /></div>
        <Transition name="dm">
          <div v-if="comment" :key="comment.id" class="danmaku">
            <Avatar :character="character" :size="24" live />
            <span>{{ comment.text }}</span>
          </div>
        </Transition>
      </div>
    </template>

    <div class="text-center">
      <div class="text-[19px] font-700">{{ song.title }}</div>
      <div class="text-[13px] text-ink-3">{{ song.artist }} · 示例歌曲</div>
    </div>

    <div ref="lyricsBox" class="lyrics hide-scrollbar">
      <div v-for="(l, i) in lines" :key="i" class="lyric" :class="{ on: i === current }" :data-line="i">
        <div>{{ l.text || '♪' }}</div>
        <div v-if="l.translation" class="tr">{{ l.translation }}</div>
      </div>
    </div>

    <div class="flex items-center gap-2 text-[11.5px] text-ink-3 num">
      <span>{{ clock(pos / 1000) }}</span>
      <van-slider v-model="pos" :max="song.durationMs" class="flex-1" bar-height="3px" button-size="12px" />
      <span>{{ clock(song.durationMs / 1000) }}</span>
    </div>
    <div class="controls">
      <button class="ctl" aria-label="喜欢" @click="liked = !liked"><span :class="liked ? 'i-lucide-heart text-accent' : 'i-lucide-heart'" /></button>
      <button class="ctl" aria-label="上一首" @click="pickSong(songs[(songs.indexOf(song) + songs.length - 1) % songs.length]!)"><span class="i-lucide-skip-back" /></button>
      <button class="ctl main" :aria-label="playing ? '暂停' : '播放'" @click="setPlaying(!playing)"><span :class="playing ? 'i-lucide-pause' : 'i-lucide-play'" /></button>
      <button class="ctl" aria-label="下一首" @click="pickSong(songs[(songs.indexOf(song) + 1) % songs.length]!)"><span class="i-lucide-skip-forward" /></button>
      <button class="ctl" aria-label="我们的歌单" @click="listOpen = true"><span class="i-lucide-list-music" /></button>
    </div>

    <van-popup v-model:show="listOpen" position="bottom" round>
      <div class="p-4">
        <div class="text-[16px] font-600">我们的歌单</div>
        <div class="text-[12px] text-ink-3 mb-2">一起听过、她推荐过的歌</div>
        <button v-for="s in songs" :key="s.id" class="song-row" @click="pickSong(s)">
          <span class="cover" :style="{ '--hue': s.hue }" />
          <span class="flex-1 min-w-0 text-left">
            <span class="block truncate text-[14.5px]" :class="{ 'text-accent-ink font-600': s.id === song.id }">{{ s.title }}</span>
            <span class="block truncate text-[12px] text-ink-3">{{ s.artist }}</span>
          </span>
          <span class="num text-[12px] text-ink-3">{{ clock(s.durationMs / 1000) }}</span>
        </button>
      </div>
    </van-popup>

    <van-popup v-model:show="searchOpen" position="bottom" round :style="{ height: '70%' }">
      <div class="p-4">
        <div class="flex gap-2">
          <input v-model="keyword" class="field" placeholder="搜歌名或歌手（网易云）" aria-label="搜歌" @keydown.enter="search" />
          <van-button type="primary" round size="small" @click="search">搜索</van-button>
        </div>
        <p class="text-[12px] text-ink-3 my-2">地址约 20 分钟过期，播放前现取；cookie 存在你的 Worker 里</p>
        <button v-for="s in results" :key="s.id" class="song-row" @click="pickSong(s)">
          <span class="cover" :style="{ '--hue': s.hue }" />
          <span class="flex-1 min-w-0 text-left">
            <span class="block truncate text-[14.5px]">{{ s.title }}</span>
            <span class="block truncate text-[12px] text-ink-3">{{ s.artist }}</span>
          </span>
          <span class="i-lucide-play text-ink-3" />
        </button>
      </div>
    </van-popup>
  </SceneShell>
</template>

<style scoped>
.pill-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border-radius: 99px;
  background: var(--glass);
  border: 1px solid var(--glass-line);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  font-size: 17px;
}
.vinyl-wrap {
  position: absolute;
  z-index: 7;
  top: calc(var(--safe-top) + 110px);
  left: 0;
  right: 0;
  display: flex;
  justify-content: center;
}
.vinyl {
  width: min(48vw, 200px);
  aspect-ratio: 1;
  border-radius: 50%;
  background:
    radial-gradient(circle, #111 0 6%, transparent 6.5%),
    radial-gradient(circle, hsl(var(--hue) 60% 62%) 0 30%, transparent 30.5%),
    repeating-radial-gradient(circle, #1d1822 0 2px, #0f0c13 2px 4px);
  box-shadow:
    0 0 0 6px rgba(255, 255, 255, 0.04),
    0 20px 50px rgba(0, 0, 0, 0.5);
}
.vinyl.spin {
  animation: spin 8s linear infinite;
}
.danmaku {
  position: absolute;
  top: 58%;
  left: 50%;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px 5px 5px;
  border-radius: 99px;
  background: var(--glass-strong);
  border: 1px solid var(--accent-line);
  font-size: 14px;
  white-space: nowrap;
  transform: translateX(-50%);
}
.dm-enter-active {
  transition: all 0.6s var(--ease);
}
.dm-leave-active {
  transition: all 0.5s;
}
.dm-enter-from {
  opacity: 0;
  transform: translate(10%, 0);
}
.dm-leave-to {
  opacity: 0;
  transform: translate(-110%, 0);
}
.lyrics {
  height: 132px;
  overflow-y: auto;
  margin: 10px 0 8px;
  text-align: center;
  mask-image: linear-gradient(transparent, #000 25%, #000 75%, transparent);
  -webkit-mask-image: linear-gradient(transparent, #000 25%, #000 75%, transparent);
}
.lyric {
  padding: 5px 0;
  font-size: 14.5px;
  color: var(--ink-3);
  transition:
    color 0.3s,
    transform 0.3s;
}
.lyric.on {
  color: var(--accent-ink);
  font-weight: 600;
  transform: scale(1.06);
}
.lyric .tr {
  font-size: 11.5px;
  opacity: 0.8;
}
.controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 8px;
  padding: 0 6px;
}
.ctl {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 21px;
  color: var(--ink);
}
.ctl.main {
  width: 58px;
  height: 58px;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 24px;
}
.song-row {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 9px 0;
}
.cover {
  width: 42px;
  height: 42px;
  border-radius: 10px;
  background: linear-gradient(135deg, hsl(var(--hue) 60% 65%), hsl(calc(var(--hue) + 40) 50% 40%));
  flex-shrink: 0;
}
.field {
  flex: 1;
  min-width: 0;
  height: 36px;
  padding: 0 14px;
  border-radius: 18px;
  border: 1px solid var(--border);
  background: var(--panel);
  outline: none;
}
</style>
