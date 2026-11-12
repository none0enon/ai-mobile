<script setup lang="ts">
import { cueIndexAt, isExpression, mediaClock, parseSubtitles, type MessagePart, type SubtitleCue } from '@app/shared';
import { showToast } from 'vant';
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Avatar from '@/components/common/Avatar.vue';
import SceneShell from '@/components/scene/SceneShell.vue';
import { personaOf } from '@/services/prompt';
import { useAppStore } from '@/stores/app';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';
import { uid } from '@/utils/id';
import { readTextFile } from '@/utils/text';
import { fetchYouTubeMeta, parseVideoLink, PLATFORM_LABEL, trackYouTube, type YouTubeInfo } from '@/utils/videoLink';

/**
 * 一起观影（设计文档 §9.9）。AI 不直接看视频，看法有三种：
 * - 在这里放本地视频：视频不上传，时间读播放器的；
 * - 贴链接（参考 siios 的 co-watch）：B 站 / YouTube 用官方嵌入播放器，视频文件链接用 App 自己的播放器。
 *   YouTube 和视频文件读得到播放时间；B 站的嵌入播放器读不到，靠你点"开始计时"。
 *   有字幕文件就照字幕走；没有时她只知道片名、作者、你贴的简介和播到哪了，按话量隔一会儿随口说一句，不编剧情；
 * - 在别处看（电视、电影院、别的 App）：只用字幕文件，听到哪句点哪句对时，也能手动前后调。
 * 有字幕时：字幕按片内时间排好，她读的是接下来一段的字幕，提前批量写好要说的话，每句挂在一条字幕上，播到那一条才出现
 * （出现时存进聊天）。拖进度条就作废重写，晚到 3 秒以上的不出。
 * 你发弹幕她马上回；暂停时可以多聊两句；电影院模式下她不出声，散场后一次翻看她写在"票根背面"的话。
 * 她说的话都来自「陪伴 · 快速」（"一起观影"功能预设 + 这一次的输入）；没接通时写明原因，不出演示台词。
 */
type Phase = 'pick' | 'watching' | 'ended';
type Source = 'local' | 'link' | 'elsewhere';
type Talk = 'quiet' | 'normal' | 'chatty';
const TALK: Record<Talk, { label: string; hint: string }> = {
  quiet: { label: '安静', hint: '这一段最多 1 句' },
  normal: { label: '适中', hint: '这一段 0–2 句' },
  chatty: { label: '话痨', hint: '这一段 2–4 句' },
};
/** 没有字幕时（贴的链接）她隔多久说一句（按一起看了的秒数） */
const CHATTER_EVERY: Record<Talk, number> = { quiet: 180, normal: 90, chatty: 45 };
/** 一批写多长（秒）、提前多久写下一批、晚到多久就不出 */
const WINDOW = 240;
const AHEAD = 60;
const LATE = 3;
const VIDEO_EXT = /\.(mp4|m4v|mkv|webm|mov|ogv)$/i;
const SUB_EXT = /\.(srt|vtt|ass|ssa)$/i;

const app = useAppStore();
const chars = useCharacterStore();
const chat = useChatStore();
const route = useRoute();
const router = useRouter();
const her = computed(() => chars.byId(app.activeCharacterId) ?? chars.list[0]!);
const chatId = computed(() => chat.chatOfCharacter(her.value.id)?.id ?? '');
const userName = computed(() => personaOf(chat.chatById(chatId.value)).name);

// —— 选片 ——
const phase = ref<Phase>('pick');
const source = ref<Source>('local');
const title = ref('');
const videoUrl = ref('');
const videoName = ref('');
const videoError = ref('');
const subName = ref('');
const cues = ref<SubtitleCue[]>([]);
const subError = ref('');
const talk = ref<Talk>('normal');
const cinema = ref(false);
const notConnected = ref('');

// —— 贴链接 ——
const linkText = ref('');
const author = ref('');
const notes = ref('');
const parsed = computed(() => parseVideoLink(linkText.value, typeof location === 'undefined' ? undefined : location.origin));
const link = computed(() => (parsed.value?.ok ? parsed.value.link : null));
const canPlayHls = typeof document !== 'undefined' && !!document.createElement('video').canPlayType('application/vnd.apple.mpegurl');
const linkProblem = computed(() => {
  const p = parsed.value;
  if (!p) return '';
  if (!p.ok) return p.reason;
  if (p.link.hls && !canPlayHls) return '这个浏览器不能直接放 m3u8（iPhone / Mac 的 Safari 可以），换一个 .mp4 之类的链接试试';
  return '';
});
/** 分享文字里带的标题、YouTube 的标题和频道：片名没填时顺手填上 */
let metaFor = '';
watch(link, async (l) => {
  if (!l) return;
  if (l.title && !title.value.trim()) title.value = l.title;
  if (l.platform !== 'youtube' || metaFor === l.watchUrl) return;
  metaFor = l.watchUrl;
  const meta = await fetchYouTubeMeta(l.watchUrl);
  if (metaFor !== l.watchUrl) return;
  if (meta.title && !title.value.trim()) title.value = meta.title;
  if (meta.author) author.value = meta.author;
});
function defaultTitle(): string {
  const l = link.value;
  if (!l) return '';
  if (l.platform === 'bilibili') return `B 站视频 ${l.id}${l.page && l.page > 1 ? ` P${l.page}` : ''}`;
  if (l.platform === 'youtube') return 'YouTube 视频';
  return l.title || '视频';
}
// 从别处带着链接进来（装成 App 后在 B 站 / YouTube 里"分享"到这里，或者 ?link=）
if (typeof route.query.link === 'string' && route.query.link.trim()) {
  source.value = 'link';
  linkText.value = route.query.link;
  if (typeof route.query.title === 'string' && route.query.title.trim()) title.value = route.query.title.trim().slice(0, 80);
}

const stem = (name: string) => name.replace(/\.[^.]+$/, '');
async function onPick(e: Event) {
  const files = [...((e.target as HTMLInputElement).files ?? [])];
  (e.target as HTMLInputElement).value = '';
  const video = files.find((f) => f.type.startsWith('video/') || VIDEO_EXT.test(f.name));
  const subs = files.filter((f) => SUB_EXT.test(f.name));
  if (video && source.value === 'local') {
    if (videoUrl.value) URL.revokeObjectURL(videoUrl.value);
    videoUrl.value = URL.createObjectURL(video);
    videoName.value = video.name;
    videoError.value = '';
    if (!title.value) title.value = stem(video.name);
  }
  // 几个字幕文件时，先用和视频同名的
  const sub = subs.find((s) => videoName.value && stem(s.name).startsWith(stem(videoName.value))) ?? subs[0];
  if (sub) {
    const list = parseSubtitles(await readTextFile(sub), sub.name);
    subName.value = sub.name;
    cues.value = list;
    subError.value = list.length ? '' : `${sub.name} 里没读出字幕`;
    if (!title.value) title.value = stem(sub.name);
  }
}
const canStart = computed(() => {
  if (source.value === 'link') return !!link.value && !linkProblem.value;
  return !!cues.value.length && !!title.value.trim() && (source.value === 'elsewhere' || (!!videoUrl.value && !videoError.value));
});

// —— 片内时钟 ——
/**
 * 时间从哪来：video 读播放器（本地视频、视频文件链接）；youtube 读 YouTube 播放器发来的进度；
 * manual 自己计时（在别处看、B 站，或者读不到 YouTube 的进度时）
 */
const ytHeard = ref(false);
const ytGaveUp = ref(false);
const clockKind = computed<'video' | 'youtube' | 'manual'>(() => {
  if (source.value === 'local') return 'video';
  if (source.value === 'link') {
    const p = link.value?.platform;
    if (p === 'direct') return 'video';
    if (p === 'youtube' && !ytGaveUp.value) return 'youtube';
  }
  return 'manual';
});
const videoSrc = computed(() => (source.value === 'link' ? (link.value?.src ?? '') : videoUrl.value));
const videoEl = ref<HTMLVideoElement | null>(null);
const frameEl = ref<HTMLIFrameElement | null>(null);
const t = ref(0);
const playing = ref(false);
let baseSec = 0;
let startedAt = 0;
let watchedSec = 0;
let watchStartAt = 0;
let loop: ReturnType<typeof setInterval> | undefined;
let lastLoopAt = 0;
let ytTime = 0;
let ytAt = 0;
let yt: ReturnType<typeof trackYouTube> | null = null;

function clockNow(): number {
  if (clockKind.value === 'video') return videoEl.value?.currentTime ?? 0;
  if (clockKind.value === 'youtube') return playing.value ? ytTime + (Date.now() - ytAt) / 1000 : ytTime;
  return playing.value ? baseSec + (Date.now() - startedAt) / 1000 : baseSec;
}
function startLoop() {
  clearInterval(loop);
  lastLoopAt = Date.now();
  loop = setInterval(() => {
    const now = Date.now();
    if (playing.value) watchedSec += (now - lastLoopAt) / 1000;
    lastLoopAt = now;
    t.value = clockNow();
    // YouTube 播放器十秒都没回音：多半被拦了（广告拦截、内容不让嵌入），改成自己计时
    if (clockKind.value === 'youtube' && !ytHeard.value && now - watchStartAt > 10_000) {
      ytGaveUp.value = true;
      baseSec = 0;
      startedAt = now;
      playing.value = false;
    }
    planAhead();
    fire();
    maybeChatter();
  }, 250);
}
function onYouTube(info: YouTubeInfo) {
  ytHeard.value = true;
  if (info.title && !title.value.trim()) title.value = info.title;
  if (info.author && !author.value) author.value = info.author;
  if (typeof info.state === 'number') {
    const now = clockNow();
    ytTime = now;
    ytAt = Date.now();
    // 1 在播，3 缓冲（缓冲时时间不走，但很快会接着播）
    playing.value = info.state === 1;
  }
  if (typeof info.time === 'number') {
    const jumped = ytAt > 0 && Math.abs(info.time - clockNow()) > 2.5;
    ytTime = info.time;
    ytAt = Date.now();
    if (jumped) onSeek();
  }
}
function playPause() {
  if (clockKind.value === 'video') {
    const v = videoEl.value;
    if (v) void (v.paused ? v.play() : v.pause());
    return;
  }
  if (playing.value) {
    baseSec = clockNow();
    playing.value = false;
  } else {
    startedAt = Date.now();
    playing.value = true;
  }
}
/** 自己计时时：把时钟拨到某一秒（点字幕对时、前后调） */
function setClock(sec: number) {
  baseSec = Math.max(0, sec);
  startedAt = Date.now();
  t.value = baseSec;
  onSeek();
}
const curIndex = computed(() => cueIndexAt(cues.value, t.value));
const curCue = computed(() => {
  const c = cues.value[curIndex.value];
  return c && t.value <= c.end + 0.5 ? c : null;
});
/** 对时用：接下来几句 */
const upcoming = computed(() => cues.value.slice(Math.max(0, curIndex.value - 1), Math.max(0, curIndex.value - 1) + 6).map((c, i) => ({ c, i: Math.max(0, curIndex.value - 1) + i })));

// —— 她的弹幕（有字幕时）：提前一批一批写好，挂在字幕上 ——
interface Reaction {
  at: number;
  cue: number;
  text: string;
  expr?: string;
  done: boolean;
}
let reactions: Reaction[] = [];
const requested = new Set<number>();
let generation = 0;
let summary = '';
const herSaid: string[] = [];
const lastCueEnd = computed(() => cues.value.at(-1)?.end ?? 0);

function planAhead() {
  if (phase.value !== 'watching' || !cues.value.length || notConnected.value) return;
  const k = Math.floor(t.value / WINDOW);
  void requestWindow(k);
  if (t.value > (k + 1) * WINDOW - AHEAD) void requestWindow(k + 1);
}

function parseBatch(valid: Set<number>) {
  return (v: unknown): { reactions: { cue: number; text: string; expr?: string }[]; summary: string } | null => {
    if (!v || typeof v !== 'object') return null;
    const o = v as { reactions?: unknown; summary?: unknown };
    if (!Array.isArray(o.reactions)) return null;
    const list = o.reactions
      .map((x) => x as { cue?: unknown; text?: unknown; expr?: unknown })
      .filter((x) => valid.has(Number(x.cue)) && typeof x.text === 'string' && x.text.trim())
      .map((x) => ({ cue: Number(x.cue), text: String(x.text).trim().slice(0, 60), ...(typeof x.expr === 'string' && isExpression(x.expr) ? { expr: x.expr } : {}) }));
    return { reactions: list, summary: typeof o.summary === 'string' ? o.summary.trim().slice(0, 600) : '' };
  };
}

/** 贴链接时片子的信息（给她看的那几行） */
function linkLines(): string[] {
  const l = link.value;
  if (source.value !== 'link' || !l) return [];
  return [
    l.platform === 'direct' ? '平台：视频文件链接' : `平台：${PLATFORM_LABEL[l.platform]}（${l.watchUrl}）`,
    author.value ? `作者 / 频道：${author.value}` : '',
    notes.value.trim() ? `${userName.value}贴的内容（简介 / 字幕 / 重点）：\n${notes.value.trim().slice(0, 2000)}` : '',
  ].filter(Boolean);
}

async function requestWindow(k: number) {
  if (requested.has(k) || k * WINDOW > lastCueEnd.value || !chatId.value) return;
  requested.add(k);
  const from = k * WINDOW;
  const to = from + WINDOW;
  const idx = cues.value.map((c, i) => ({ c, i })).filter(({ c }) => c.start >= from && c.start < to);
  if (!idx.length) return;
  const g = generation;
  const r = await chat.sceneJson(
    chatId.value,
    {
      name: 'watch-batch',
      input: [
        `片名：${title.value}`,
        ...linkLines(),
        `前情提要：${summary || '（刚开始）'}`,
        `话量：${TALK[talk.value].label}（${TALK[talk.value].hint}）`,
        '这一段的字幕（编号 片内时间 台词）：',
        ...idx.map(({ c, i }) => `#${i} ${mediaClock(c.start)} ${c.text}`),
      ].join('\n'),
    },
    parseBatch(new Set(idx.map((x) => x.i))),
  );
  if (g !== generation) return;
  if (!r.ok) {
    if (r.notConnected) notConnected.value = r.reason;
    else {
      requested.delete(k);
      showToast(`${her.value.name}这一段没写出来：${r.reason}`);
    }
    return;
  }
  if (r.value.summary) summary = r.value.summary;
  for (const x of r.value.reactions) {
    const c = cues.value[x.cue];
    if (c) reactions.push({ at: c.start + 0.3, cue: x.cue, text: x.text, expr: x.expr, done: false });
  }
}

function fire() {
  for (const r of reactions) {
    if (r.done || t.value < r.at) continue;
    r.done = true;
    if (t.value - r.at > LATE) continue;
    const c = cues.value[r.cue];
    const label = c ? `${mediaClock(c.start)}「${c.text.slice(0, 24)}」` : mediaClock(r.at);
    chat.push(chatId.value, 'assistant', [{ type: 'text', text: r.text }], { meta: { scene: 'watch', cue: label, agent: 'companion' }, expression: r.expr ?? null });
    herSaid.push(r.text);
    if (r.expr) chars.setExpression(her.value.id, r.expr);
    if (!cinema.value) pushDanmaku('her', r.text);
  }
}

/** 拖了进度条 / 拨了时钟：没出现的作废，从新位置重新写 */
function onSeek() {
  generation += 1;
  reactions = reactions.filter((r) => r.done);
  requested.clear();
  t.value = clockNow();
  planAhead();
}

// —— 她随口说一句（贴链接、没有字幕时）：按话量隔一会儿说一句 ——
let lastChatterAt = -1;
let chattering = false;
/** 这一刻的位置：读得到进度时是"播到 xx"，自己计时时是"大概播到 xx" */
function whereLine(): string {
  const now = clockNow();
  if (clockKind.value === 'manual') {
    return playing.value || baseSec > 0 ? `大概播到 ${mediaClock(now)}（${userName.value}点"开始计时"算的）` : `你们已经一起看了约 ${mediaClock(watchedSec)}`;
  }
  return `现在播到 ${mediaClock(now)}${playing.value ? '' : '（暂停中）'}`;
}
function maybeChatter() {
  if (phase.value !== 'watching' || source.value !== 'link' || cues.value.length || notConnected.value || chattering || !playing.value || replying.value) return;
  const due = lastChatterAt < 0 ? 20 : lastChatterAt + CHATTER_EVERY[talk.value];
  if (watchedSec >= due) void chatter();
}
async function chatter() {
  if (!chatId.value) return;
  chattering = true;
  lastChatterAt = watchedSec;
  const r = await chat.sceneReply(chatId.value, {
    task: 'watch-link',
    input: [`片名：${title.value}`, ...linkLines(), whereLine(), herSaid.length ? `你刚才说过：${herSaid.slice(-5).join(' / ')}` : ''].filter(Boolean).join('\n'),
    cue: mediaClock(clockNow()),
    allowedTags: ['expr'],
  });
  chattering = false;
  if (!r.ok) {
    if (r.notConnected) notConnected.value = r.reason;
    return;
  }
  herSaid.push(r.message.text);
  if (!cinema.value) pushDanmaku('her', r.message.text);
}

// —— 弹幕层 ——
interface Dm {
  id: number;
  who: 'her' | 'you';
  text: string;
}
const danmaku = ref<Dm[]>([]);
let dmSeq = 0;
function pushDanmaku(who: Dm['who'], text: string) {
  const id = (dmSeq += 1);
  danmaku.value = [...danmaku.value.slice(-3), { id, who, text }];
  setTimeout(() => (danmaku.value = danmaku.value.filter((d) => d.id !== id)), 6000);
}

// —— 你发弹幕 / 暂停时聊 ——
const input = ref('');
const replying = computed(() => !!chat.streams[chatId.value]);
async function send() {
  const text = input.value.trim();
  if (!text || !chatId.value || replying.value) return;
  input.value = '';
  if (!cinema.value) pushDanmaku('you', text);
  const now = t.value;
  const recent = cues.value.filter((c) => c.start <= now && c.start >= now - 60).map((c) => `${mediaClock(c.start)} ${c.text}`);
  const r = await chat.sceneReply(chatId.value, {
    task: playing.value ? 'watch-chat' : 'watch-pause',
    input: [
      `片名：${title.value}`,
      ...linkLines(),
      `前情提要：${summary || '（刚开始）'}`,
      cues.value.length ? `现在：${mediaClock(now)}${playing.value ? '' : '（暂停中）'}` : whereLine(),
      recent.length ? '最近 60 秒的字幕：' : '',
      ...recent,
      !cues.value.length && herSaid.length ? `你刚才说过：${herSaid.slice(-5).join(' / ')}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    userText: text,
    cue: mediaClock(now),
  });
  if (!r.ok) {
    if (r.notConnected) notConnected.value = r.reason;
    else showToast(r.reason);
    return;
  }
  herSaid.push(r.message.text);
  if (!cinema.value) pushDanmaku('her', r.message.text);
}

// —— 开始 / 散场 ——
async function start() {
  if (!canStart.value) return;
  if (source.value === 'link' && !title.value.trim()) title.value = defaultTitle();
  phase.value = 'watching';
  t.value = 0;
  baseSec = source.value === 'link' ? (link.value?.start ?? 0) : 0;
  ytTime = baseSec;
  ytAt = 0;
  playing.value = false;
  watchStartAt = Date.now();
  startLoop();
  await nextTick();
  if (clockKind.value === 'video') void videoEl.value?.play().catch(() => undefined);
  else if (clockKind.value === 'youtube' && frameEl.value) yt = trackYouTube(frameEl.value, onYouTube);
}
const yourScore = ref(0);
const yourWords = ref('');
const herReview = ref('');
const herScore = ref(0);
const posted = ref(false);
const backOfTicket = ref<string[]>([]);
function stopWatching() {
  videoEl.value?.pause();
  yt?.command('pauseVideo');
  yt?.destroy();
  yt = null;
  playing.value = false;
  clearInterval(loop);
  phase.value = 'ended';
  backOfTicket.value = [...herSaid];
}
async function leaveTheater() {
  if (!chatId.value || posted.value) return;
  const minutes = Math.max(1, Math.round(watchedSec / 60));
  const r = await chat.sceneReply(chatId.value, {
    task: 'watch-end',
    input: [`片名：${title.value}`, ...linkLines(), `前情提要：${summary || '（没有）'}`, `一起看了 ${minutes} 分钟`].join('\n'),
    userText: yourScore.value ? `我打 ${yourScore.value}/5${yourWords.value.trim() ? `：${yourWords.value.trim()}` : ''}` : yourWords.value.trim() || '看完了',
    cue: '散场',
  });
  if (r.ok) {
    const m = /评分[:：]\s*(\d(?:\.\d)?)\s*\/\s*5/.exec(r.message.text);
    herScore.value = m ? Math.round(Number(m[1])) : 0;
    herReview.value = r.message.text.replace(/\n?.*评分[:：].*$/m, '').trim();
  } else if (r.notConnected) notConnected.value = r.reason;
  else showToast(r.reason);
  const spread = herSaid.length <= 3 ? herSaid : [herSaid[0], herSaid[Math.floor(herSaid.length / 2)], herSaid.at(-1)];
  const card: MessagePart = {
    type: 'watch',
    logId: uid('watch'),
    title: title.value.trim(),
    minutes,
    ...(yourScore.value ? { yourScore: yourScore.value } : {}),
    ...(herScore.value ? { herScore: herScore.value } : {}),
    ...(herReview.value ? { review: herReview.value } : {}),
    highlights: spread.filter((x): x is string => !!x),
    ...(source.value === 'link' && link.value ? { link: link.value.watchUrl } : {}),
  };
  chat.postCard(chatId.value, 'user', card);
  chat.leaveScene(her.value.id, `一起看了《${title.value.trim()}》`);
  posted.value = true;
}

onBeforeUnmount(() => {
  clearInterval(loop);
  yt?.destroy();
  if (videoUrl.value) URL.revokeObjectURL(videoUrl.value);
});
</script>

<template>
  <SceneShell scene-id="watch" :hide-figure="phase === 'watching'" :title="phase === 'watching' ? `《${title}》` : undefined" pose="sit" :line="phase === 'ended' ? herReview : ''" :typing="replying && phase === 'ended'" :layout="{ left: 78, bottom: 56, height: 30 }">
    <template #overlay>
      <div v-if="phase === 'watching'" class="screen">
        <video
          v-if="clockKind === 'video'"
          ref="videoEl"
          class="video"
          :src="videoSrc"
          controls
          playsinline
          @play="playing = true"
          @pause="playing = false"
          @seeked="onSeek"
          @error="videoError = source === 'link' ? '这个链接放不了：可能失效了、不是视频文件，或者网站不让别的网页播放' : '这个视频浏览器放不了'"
        />
        <iframe
          v-else-if="source === 'link' && link && link.platform !== 'direct'"
          ref="frameEl"
          class="video"
          :src="link.src"
          :title="`${PLATFORM_LABEL[link.platform]}播放器`"
          allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
          allowfullscreen
          data-testid="player-frame"
        />
        <div v-else class="elsewhere">
          <div class="num text-[34px] font-700">{{ mediaClock(t) }}</div>
          <div class="text-[13px] text-ink-2 mt-1 px-4 text-center line-clamp-2">{{ curCue?.text ?? '　' }}</div>
        </div>
        <div v-if="!cinema" class="dm-layer">
          <TransitionGroup name="dm">
            <div v-for="d in danmaku" :key="d.id" class="dm" :class="d.who">
              <Avatar v-if="d.who === 'her'" :character="her" :size="20" />
              <span>{{ d.text }}</span>
            </div>
          </TransitionGroup>
        </div>
      </div>
    </template>

    <div v-if="notConnected" class="notice">
      <span class="i-lucide-plug-zap shrink-0" />
      <span class="flex-1 min-w-0">{{ notConnected }}</span>
      <button class="text-accent-ink shrink-0" @click="router.push('/me/api?feature=companion')">去设置</button>
    </div>

    <!-- 选片 -->
    <template v-if="phase === 'pick'">
      <div class="flex gap-2 overflow-x-auto no-scrollbar">
        <button type="button" class="chip" :class="{ on: source === 'local' }" @click="source = 'local'">在这里放视频</button>
        <button type="button" class="chip" :class="{ on: source === 'link' }" data-testid="source-link" @click="source = 'link'">贴链接</button>
        <button type="button" class="chip" :class="{ on: source === 'elsewhere' }" @click="source = 'elsewhere'">在别处看</button>
      </div>

      <template v-if="source === 'link'">
        <textarea
          v-model="linkText"
          class="field area mt-2.5"
          rows="2"
          placeholder="贴 B 站 / YouTube 视频链接，或者视频文件的地址（.mp4 / .m3u8）；App 里点“分享”复制的整段文字也行"
          aria-label="视频链接"
          data-testid="link-input"
        />
        <div v-if="link && !linkProblem" class="text-[12.5px] text-good mt-1.5" data-testid="link-ok">
          <span class="i-lucide-link align-[-2px]" /> {{ PLATFORM_LABEL[link.platform] }}<template v-if="link.id"> · {{ link.id }}</template><template v-if="link.page && link.page > 1"> · 第 {{ link.page }}P</template><template v-if="link.start"> · 从 {{ mediaClock(link.start) }} 开始</template><template v-if="link.guessed"> · 看不出是不是视频文件，先试着放</template>
        </div>
        <div v-else-if="linkProblem" class="text-[12.5px] text-[var(--bad)] mt-1.5" data-testid="link-problem">{{ linkProblem }}</div>
        <div class="text-[12px] text-ink-3 mt-1 leading-relaxed">
          <template v-if="link?.platform === 'bilibili'">B 站的嵌入播放器不告诉网页播到哪了：开始后在播放器里点播放的同时点"开始计时"，{{ her.pronoun }}才知道看到哪儿。清晰度由 B 站决定。</template>
          <template v-else-if="link?.platform === 'youtube'">YouTube 播放器会告诉{{ her.pronoun }}播到哪了；拖进度条{{ her.pronoun }}也跟得上。</template>
          <template v-else>{{ her.pronoun }}看不到画面、听不到声音：有字幕文件最好；没有的话，在下面写几句简介，{{ her.pronoun }}才能说到点子上。</template>
        </div>
        <div class="label">片名</div>
        <input v-model="title" class="field w-full" :placeholder="defaultTitle() || '片名'" aria-label="片名" />
        <div class="label">内容（选填）：简介、剧情、你看到的重点</div>
        <textarea v-model="notes" class="field area" rows="2" :placeholder="`${her.pronoun}只知道片名和你写的这些，不会编没出现的剧情`" aria-label="视频内容" />
        <label class="pick press">
          <span class="i-lucide-captions text-[20px]" />
          <span>{{ subName ? `字幕：${subName} · ${cues.length} 句` : '有这个视频的字幕文件就选上（选填）' }}</span>
          <input type="file" class="hidden" accept=".srt,.vtt,.ass,.ssa" @change="onPick" />
        </label>
        <div v-if="subError" class="text-[12.5px] text-[var(--bad)] mt-1">{{ subError }}</div>
      </template>

      <template v-else>
        <label class="pick press">
          <span class="i-lucide-folder-open text-[20px]" />
          <span v-if="source === 'local'">选视频和字幕文件（可以一起选）</span>
          <span v-else>选字幕文件</span>
          <input type="file" class="hidden" multiple :accept="source === 'local' ? 'video/*,.mkv,.srt,.vtt,.ass,.ssa' : '.srt,.vtt,.ass,.ssa'" @change="onPick" />
        </label>
        <div class="text-[12.5px] text-ink-3 mt-1.5">
          <div v-if="source === 'local'">视频：{{ videoName || '还没选' }}<span v-if="videoError" class="text-[var(--bad)]"> · {{ videoError }}</span></div>
          <div>字幕：{{ subName ? `${subName} · ${cues.length} 句` : '还没选' }}<span v-if="subError" class="text-[var(--bad)]"> · {{ subError }}</span></div>
          <div v-if="!cues.length" class="mt-1">放本地视频、在别处看要有字幕文件（srt / vtt / ass）。视频不上传，发给模型的只有字幕和你们的弹幕。没有字幕的片可以"贴链接"看。</div>
        </div>
        <div class="label">片名</div>
        <input v-model="title" class="field w-full" placeholder="片名" aria-label="片名" />
      </template>

      <div class="label">{{ her.pronoun }}的话量</div>
      <div class="flex gap-2">
        <button v-for="(v, k) in TALK" :key="k" type="button" class="chip" :class="{ on: talk === k }" @click="talk = k">{{ v.label }}</button>
      </div>
      <label class="flex items-center gap-2 mt-3 text-[13.5px]">
        <van-switch v-model="cinema" size="18px" />电影院模式（放映时{{ her.pronoun }}不出声，散场后一次看）
      </label>
      <van-button type="primary" round block class="!mt-3.5" :disabled="!canStart" data-testid="watch-start" @click="start">开始一起看</van-button>
    </template>

    <!-- 看的时候 -->
    <template v-else-if="phase === 'watching'">
      <div v-if="clockKind === 'manual'">
        <div v-if="source === 'link'" class="text-[12px] text-ink-3 mb-2 leading-relaxed">
          {{ link?.platform === 'youtube' ? '读不到 YouTube 播放器的进度（可能被浏览器拦了）' : 'B 站播放器不告诉网页播到哪了' }}：在播放器里播放 / 暂停时，也点一下这里。
        </div>
        <div class="flex gap-2 btns">
          <van-button round block size="small" @click="setClock(t - 5)">-5 秒</van-button>
          <van-button type="primary" round block size="small" data-testid="clock-toggle" @click="playPause">{{ playing ? '暂停计时' : '开始计时' }}</van-button>
          <van-button round block size="small" @click="setClock(t + 5)">+5 秒</van-button>
        </div>
        <template v-if="cues.length">
          <div class="label">听到哪句点哪句，时间就对上了</div>
          <button v-for="u in upcoming" :key="u.i" type="button" class="cue" :class="{ on: u.i === curIndex }" @click="setClock(u.c.start)">
            <span class="num text-ink-3">{{ mediaClock(u.c.start) }}</span><span class="truncate">{{ u.c.text }}</span>
          </button>
        </template>
        <div v-else class="text-[12.5px] text-ink-3 mt-1.5 num">计时 {{ mediaClock(t) }}</div>
      </div>
      <div v-else-if="clockKind === 'youtube'" class="text-[12.5px] text-ink-3 num" data-testid="yt-clock">
        {{ ytHeard ? `播到 ${mediaClock(t)}${playing ? '' : ' · 暂停中'}` : '连接 YouTube 播放器…' }}
      </div>
      <div v-if="videoError" class="text-[12.5px] text-[var(--bad)] mt-1">{{ videoError }}</div>
      <div class="flex gap-2 mt-2.5">
        <input v-model="input" class="field" :placeholder="playing ? '发一句弹幕' : `暂停了，和${her.pronoun}聊两句`" aria-label="弹幕" @keydown.enter="send" />
        <van-button size="small" round :disabled="replying" @click="send">发送</van-button>
      </div>
      <div class="flex items-center gap-2 mt-2.5">
        <span class="text-[12.5px] text-ink-3">话量</span>
        <button v-for="(v, k) in TALK" :key="k" type="button" class="chip sm" :class="{ on: talk === k }" @click="talk = k">{{ v.label }}</button>
        <span class="flex-1" />
        <van-button size="small" round @click="stopWatching">看完了</van-button>
      </div>
    </template>

    <!-- 散场 -->
    <template v-else>
      <div class="text-[16px] font-700">《{{ title }}》散场了</div>
      <template v-if="!posted">
        <div class="label">你打几分</div>
        <van-rate v-model="yourScore" :count="5" />
        <input v-model="yourWords" class="field w-full mt-2" placeholder="想说点什么（可以不写）" aria-label="你的感想" />
        <van-button type="primary" round block class="!mt-3" :loading="replying" @click="leaveTheater">散场</van-button>
      </template>
      <template v-else>
        <div class="text-[12.5px] text-ink-3 mt-1">票根已经发进聊天<template v-if="herScore"> · {{ her.pronoun }}打了 {{ herScore }}/5</template></div>
        <van-button round block class="!mt-3" @click="router.push(`/chat/${chatId}`)">回聊天</van-button>
      </template>
      <template v-if="cinema && backOfTicket.length">
        <div class="label">票根背面：{{ her.pronoun }}憋了一整场的话</div>
        <div v-for="(s, i) in backOfTicket" :key="i" class="back">「{{ s }}」</div>
      </template>
    </template>
  </SceneShell>
</template>

<style scoped>
.screen {
  position: absolute;
  z-index: 9;
  top: calc(var(--safe-top) + 58px);
  left: 0;
  right: 0;
  aspect-ratio: 16 / 9;
  max-height: 34vh;
  background: #000;
}
.video {
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #000;
  border: 0;
  display: block;
}
.elsewhere {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: #fff;
}
.dm-layer {
  position: absolute;
  left: 8px;
  right: 8px;
  top: 8px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  pointer-events: none;
}
.dm {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 92%;
  padding: 3px 10px 3px 3px;
  border-radius: 99px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 13px;
}
.dm.you {
  align-self: flex-end;
  padding-left: 10px;
  background: rgba(255, 255, 255, 0.25);
}
.dm-enter-active,
.dm-leave-active {
  transition: all 0.4s var(--ease);
}
.dm-enter-from,
.dm-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}
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
.label {
  margin: 12px 0 6px;
  font-size: 12.5px;
  color: var(--ink-3);
}
.chip {
  height: 30px;
  padding: 0 12px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 13px;
  white-space: nowrap;
  flex-shrink: 0;
}
.chip.sm {
  height: 26px;
  padding: 0 10px;
  font-size: 12.5px;
}
.chip.on {
  background: var(--accent-soft);
  color: var(--accent-ink);
  outline: 1px solid var(--accent-line);
}
.pick {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  padding: 12px 14px;
  border-radius: 14px;
  border: 1px dashed var(--border);
  background: var(--panel);
  font-size: 14px;
}
.field {
  flex: 1;
  min-width: 0;
  height: 34px;
  padding: 0 12px;
  border-radius: 17px;
  border: 1px solid var(--border);
  background: var(--panel);
  outline: none;
  font-size: 14px;
}
.field.area {
  display: block;
  width: 100%;
  height: auto;
  min-height: 58px;
  padding: 8px 12px;
  border-radius: 14px;
  line-height: 1.5;
  resize: vertical;
  font-family: inherit;
}
.btns :deep(.van-button) {
  white-space: nowrap;
}
.cue {
  display: flex;
  gap: 8px;
  width: 100%;
  padding: 6px 4px;
  font-size: 13.5px;
  text-align: left;
  border-radius: 8px;
}
.cue.on {
  background: var(--accent-soft);
}
.back {
  padding: 6px 0;
  font-size: 13.5px;
  color: var(--ink-2);
  border-bottom: 1px dashed var(--border);
}
</style>
