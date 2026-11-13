<script setup lang="ts">
import { errorText, isAbortError } from '@app/ai';
import type { Character } from '@app/shared';
import { showConfirmDialog, showToast } from 'vant';
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import Segmented from '@/components/common/Segmented.vue';
import { chapterLabel, chapterNo, novelChat, novelRewrite, novelStatus, novelWrite, parseChapter } from '@/services/workshop';
import { useWorkshopStore, type NovelChapter } from '@/stores/workshop';

/**
 * 创意工坊 · 一部小说（设计文档 §9.11）：
 * - 商量：和写作助手（"创作 · 小说"的 API + "小说"预设）聊设定、人物、大纲，它建议记进设定的点一下就记上；
 * - 章节：写下一章、写番外（可以写一句想要什么），边写边显示，停下时写了的部分照样留下；点开一章能读、改、重写、拿给她看；
 * - 设定：书名、类型、设定和人物、大纲、文风，都会带进写作助手的提示词。
 */
type Tab = 'talk' | 'chapters' | 'info';

const props = defineProps<{ novelId: string; character: Character; userName: string }>();
const emit = defineEmits<{ back: []; show: [chapterId: string] }>();

const ws = useWorkshopStore();
const router = useRouter();
const novel = computed(() => ws.novelById(props.novelId));
const status = computed(() => novelStatus());

const tab = ref<Tab>('talk');
const TABS: { value: Tab; label: string; icon: string }[] = [
  { value: 'talk', label: '商量', icon: 'i-lucide-message-square-text' },
  { value: 'chapters', label: '章节', icon: 'i-lucide-book-open-text' },
  { value: 'info', label: '设定', icon: 'i-lucide-scroll-text' },
];

let abort: AbortController | null = null;
let alive = true;
onBeforeUnmount(() => {
  alive = false;
  abort?.abort();
});

function stop() {
  abort?.abort();
}

// —— 商量 ——
const said = ref('');
const replying = ref<string | null>(null);
const talkBox = ref<HTMLElement | null>(null);
const IDEAS = ['帮我把主角立起来', '下一章写什么好？', '帮我列个大纲', '给这本书起几个名字'];

function scrollTalk() {
  void nextTick(() => {
    const el = talkBox.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}
watch(tab, (t) => t === 'talk' && scrollTalk(), { immediate: true });

async function send(text = said.value) {
  const n = novel.value;
  const t = text.trim();
  if (!n || !t || replying.value !== null || writing.value) return;
  if (!status.value.live) return showToast(status.value.reason);
  said.value = '';
  ws.addTalk(n.id, { role: 'user', text: t });
  replying.value = '';
  scrollTalk();
  abort = new AbortController();
  try {
    // 你刚说的那句已经在讨论里了：提示词里"这一次要做的"再写一遍，讨论里先去掉这一句
    const r = await novelChat({ ...n, talk: n.talk.slice(0, -1) }, t, {
      character: props.character,
      userName: props.userName,
      signal: abort.signal,
      onText: (x) => {
        if (alive) {
          replying.value = x;
          scrollTalk();
        }
      },
    });
    ws.addTalk(n.id, { role: 'assistant', text: r.text || '（没说什么）', ...(r.notes.length ? { notes: r.notes } : {}) });
  } catch (e) {
    if (isAbortError(e)) {
      if (replying.value?.trim()) ws.addTalk(n.id, { role: 'assistant', text: `${replying.value.trim()}…` });
    } else showToast(errorText(e));
  } finally {
    replying.value = null;
    abort = null;
    scrollTalk();
  }
}

function keepNote(i: number, note: string) {
  const n = novel.value;
  const t = n?.talk[i];
  if (!n || !t?.notes) return;
  ws.addNote(n.id, note);
  t.notes = t.notes.filter((x) => x !== note);
  showToast('记进设定了');
}

async function clearTalk() {
  const n = novel.value;
  if (!n?.talk.length) return;
  const ok = await showConfirmDialog({ title: '清空讨论？', message: '设定、大纲和章节都还在，只是写作助手不再记得之前聊过的', confirmButtonText: '清空' }).then(
    () => true,
    () => false,
  );
  if (ok) ws.clearTalk(n.id);
}

// —— 章节 ——
interface Draft {
  kind: 'chapter' | 'extra';
  title: string;
  text: string;
  /** 重写的是哪一章 */
  rewriteOf?: string;
  done: boolean;
}
const writing = ref<Draft | null>(null);
const asking = ref<{ kind: 'chapter' | 'extra' | 'rewrite'; chapterId?: string } | null>(null);
const wish = ref('');
const reading = ref<string | null>(null);
const editing = ref<{ title: string; text: string } | null>(null);
const chapter = computed(() => novel.value?.chapters.find((c) => c.id === reading.value));
const nextNo = computed(() => (novel.value ? chapterNo(novel.value) : 1));
const askTitle = computed(() => {
  const a = asking.value;
  if (!a) return '';
  if (a.kind === 'chapter') return `写第 ${nextNo.value} 章`;
  if (a.kind === 'extra') return '写一篇番外';
  return '重写这一章';
});
const askHint = computed(() => {
  const k = asking.value?.kind;
  if (k === 'chapter') return '这一章想写什么、写到哪（可以不写，照大纲和讨论接着写）';
  if (k === 'extra') return '想要什么样的番外：日常、配角视角、if 线、后日谈……（可以不写）';
  return '哪里不满意、想怎么改';
});

function ask(kind: 'chapter' | 'extra' | 'rewrite', chapterId?: string) {
  if (writing.value || replying.value !== null) return;
  if (!status.value.live) return showToast(status.value.reason);
  wish.value = '';
  asking.value = { kind, chapterId };
}

async function startWrite() {
  const a = asking.value;
  const n = novel.value;
  if (!a || !n) return;
  asking.value = null;
  const target = a.chapterId ? n.chapters.find((c) => c.id === a.chapterId) : undefined;
  const kind = a.kind === 'rewrite' ? (target?.kind ?? 'chapter') : a.kind;
  writing.value = { kind, title: '', text: '', ...(target ? { rewriteOf: target.id } : {}), done: false };
  reading.value = null;
  editing.value = null;
  tab.value = 'chapters';
  abort = new AbortController();
  const opts = {
    character: props.character,
    userName: props.userName,
    signal: abort.signal,
    onText: (t: string) => {
      const d = writing.value;
      if (!alive || !d) return;
      const p = parseChapter(t);
      d.title = p.title;
      d.text = p.text;
    },
  };
  try {
    const r = a.kind === 'rewrite' && target ? await novelRewrite(n, target, wish.value, opts) : await novelWrite(n, kind, wish.value, opts);
    const d = writing.value;
    if (!d) return;
    d.title = r.title;
    d.text = r.text;
    if (!r.text.trim()) throw new Error('写作助手没写出正文，换个要求再试试');
    finish(d);
  } catch (e) {
    const d = writing.value;
    if (isAbortError(e) && d?.text.trim()) {
      showToast('停下了，写了的部分先留着');
      finish(d);
    } else {
      writing.value = null;
      if (!isAbortError(e)) showToast(errorText(e));
    }
  } finally {
    abort = null;
  }
}

/** 写完：新的一章直接存下；重写的先给你比一比，点"用新的"才替换 */
function finish(d: Draft) {
  const n = novel.value;
  if (!n) return;
  if (d.rewriteOf) {
    d.done = true;
    return;
  }
  const fallback = d.kind === 'extra' ? '番外' : `第 ${nextNo.value} 章`;
  const c = ws.addChapter(n.id, { kind: d.kind, title: d.title || fallback, text: d.text });
  writing.value = null;
  if (c) reading.value = c.id;
}

function acceptRewrite(use: boolean) {
  const d = writing.value;
  const n = novel.value;
  if (!d?.rewriteOf || !n) return;
  if (use) ws.updateChapter(n.id, d.rewriteOf, { title: d.title || chapter.value?.title || '', text: d.text });
  reading.value = d.rewriteOf;
  writing.value = null;
}

function startEdit() {
  const c = chapter.value;
  if (c) editing.value = { title: c.title, text: c.text };
}
function saveEdit() {
  const n = novel.value;
  const c = chapter.value;
  const e = editing.value;
  if (!n || !c || !e) return;
  if (!e.text.trim()) return showToast('正文不能是空的');
  ws.updateChapter(n.id, c.id, { title: e.title.trim(), text: e.text });
  editing.value = null;
}

async function removeChapter() {
  const n = novel.value;
  const c = chapter.value;
  if (!n || !c) return;
  const ok = await showConfirmDialog({ title: `删除「${chapterLabel(n, c)}」？`, confirmButtonText: '删除', confirmButtonColor: 'var(--bad)' }).then(
    () => true,
    () => false,
  );
  if (!ok) return;
  ws.removeChapter(n.id, c.id);
  reading.value = null;
}

const words = (c: Pick<NovelChapter, 'text'>) => c.text.replace(/\s/g, '').length;

// —— 设定 ——
function patch(field: 'title' | 'genre' | 'setting' | 'outline' | 'style', v: string) {
  const n = novel.value;
  if (n) ws.updateNovel(n.id, { [field]: v });
}

async function removeNovel() {
  const n = novel.value;
  if (!n) return;
  const ok = await showConfirmDialog({ title: `删除《${n.title}》？`, message: '设定、讨论和所有章节都会删掉，删了找不回来', confirmButtonText: '删除', confirmButtonColor: 'var(--bad)' }).then(
    () => true,
    () => false,
  );
  if (!ok) return;
  ws.removeNovel(n.id);
  emit('back');
}
</script>

<template>
  <div v-if="novel" class="studio" data-workshop="novel">
    <div class="top">
      <button type="button" class="back" aria-label="回作品列表" @click="emit('back')"><span class="i-lucide-chevron-left" /></button>
      <span class="name truncate">《{{ novel.title }}》</span>
      <span class="text-[12px] text-ink-3 shrink-0">{{ novel.chapters.length }} 篇</span>
    </div>
    <div v-if="!status.live" class="notice">
      <span class="i-lucide-plug-zap shrink-0" />
      <span class="flex-1 min-w-0">{{ status.reason }}</span>
      <button type="button" class="text-accent-ink shrink-0" @click="router.push('/me/api?feature=novel')">去设置</button>
    </div>
    <Segmented v-model="tab" :options="TABS" class="mt-2" />

    <!-- 商量 -->
    <template v-if="tab === 'talk'">
      <div ref="talkBox" class="scroll talk">
        <div v-if="!novel.talk.length && replying === null" class="empty">
          <span class="i-lucide-feather text-[22px]" />
          <div>想写个什么样的故事？先和写作助手聊聊：主角是谁、发生在哪、你最想写的那一幕。</div>
        </div>
        <template v-for="(t, i) in novel.talk" :key="t.at + '-' + i">
          <div class="bubble" :class="t.role">{{ t.text }}</div>
          <div v-if="t.notes?.length" class="notes">
            <button v-for="note in t.notes" :key="note" type="button" class="note press" @click="keepNote(i, note)">
              <span class="i-lucide-plus shrink-0" /><span class="min-w-0">记进设定：{{ note }}</span>
            </button>
          </div>
        </template>
        <div v-if="replying !== null" class="bubble assistant">
          <template v-if="replying">{{ replying }}</template>
          <span v-else class="inline-flex gap-1 text-accent-ink"><span class="typing-dot" /><span class="typing-dot" /><span class="typing-dot" /></span>
        </div>
      </div>
      <div v-if="!novel.talk.length && replying === null" class="ideas">
        <button v-for="s in IDEAS" :key="s" type="button" class="chip press" @click="send(s)">{{ s }}</button>
      </div>
      <div class="composer">
        <textarea v-model="said" class="area" rows="2" placeholder="和写作助手说点什么：设定、人物、下一章的想法……" aria-label="和写作助手说的话" @keydown.enter.exact.prevent="send()" />
        <button v-if="replying !== null" type="button" class="send stop" aria-label="停下" @click="stop"><span class="i-lucide-square" /></button>
        <button v-else type="button" class="send" aria-label="发送" :disabled="!said.trim() || !!writing" @click="send()"><span class="i-lucide-arrow-up" /></button>
      </div>
      <button v-if="novel.talk.length" type="button" class="link mt-1" :disabled="replying !== null" @click="clearTalk">清空讨论</button>
    </template>

    <!-- 章节 -->
    <template v-else-if="tab === 'chapters'">
      <!-- 正在写 / 重写好了 -->
      <div v-if="writing" class="scroll reader">
        <div class="r-head">
          <span class="text-[12px] text-accent-ink">{{ writing.rewriteOf ? (writing.done ? '重写好了' : '正在重写') : writing.kind === 'extra' ? '正在写番外' : `正在写第 ${nextNo} 章` }}</span>
          <div class="r-title">{{ writing.title || '…' }}</div>
        </div>
        <div class="r-text">{{ writing.text }}<span v-if="!writing.done" class="caret" /></div>
      </div>
      <div v-if="writing" class="actions">
        <template v-if="writing.done">
          <van-button type="primary" size="small" round block @click="acceptRewrite(true)">用新的</van-button>
          <van-button size="small" round block @click="acceptRewrite(false)">保留原来的</van-button>
        </template>
        <van-button v-else size="small" round block icon="stop-circle-o" @click="stop">停下</van-button>
      </div>

      <!-- 读一章 -->
      <template v-else-if="chapter">
        <div class="scroll reader">
          <button type="button" class="link" @click="(reading = null), (editing = null)"><span class="i-lucide-chevron-left" />全部章节</button>
          <template v-if="editing">
            <input v-model="editing.title" class="field mt-2" placeholder="标题" aria-label="标题" />
            <textarea v-model="editing.text" class="area edit mt-2" aria-label="正文" />
          </template>
          <template v-else>
            <div class="r-head">
              <span class="text-[12px] text-ink-3">{{ chapter.kind === 'extra' ? '番外' : `第 ${chapterNo(novel, chapter)} 章` }} · {{ words(chapter) }} 字</span>
              <div class="r-title">{{ chapter.title || '无题' }}</div>
            </div>
            <div class="r-text">{{ chapter.text }}</div>
          </template>
        </div>
        <div class="actions">
          <template v-if="editing">
            <van-button type="primary" size="small" round block @click="saveEdit">保存</van-button>
            <van-button size="small" round block @click="editing = null">不改了</van-button>
          </template>
          <template v-else>
            <van-button type="primary" size="small" round block icon="eye-o" @click="emit('show', chapter.id)">给{{ character.name }}看</van-button>
            <van-button size="small" round block @click="ask('rewrite', chapter.id)">重写</van-button>
            <van-button size="small" round block @click="startEdit">改</van-button>
            <van-button size="small" round block @click="removeChapter">删</van-button>
          </template>
        </div>
      </template>

      <!-- 章节列表 -->
      <template v-else>
        <div class="scroll">
          <div v-if="!novel.chapters.length" class="empty">
            <span class="i-lucide-book-open text-[22px]" />
            <div>还没有章节。先在"设定"里写几句，或者在"商量"里聊聊，再让写作助手写第一章。</div>
          </div>
          <button v-for="c in novel.chapters" :key="c.id" type="button" class="row press" @click="reading = c.id">
            <span :class="c.kind === 'extra' ? 'i-lucide-gift' : 'i-lucide-file-text'" class="shrink-0 text-accent-ink" />
            <span class="flex-1 min-w-0">
              <span class="block truncate text-[14px]">{{ chapterLabel(novel, c) }}</span>
              <span class="block truncate text-[12px] text-ink-3">{{ words(c) }} 字 · {{ c.text.replace(/\s+/g, ' ').slice(0, 40) }}</span>
            </span>
            <span class="i-lucide-chevron-right text-ink-3 shrink-0" />
          </button>
        </div>
        <div class="actions">
          <van-button type="primary" size="small" round block icon="edit" :disabled="!status.live" @click="ask('chapter')">写第 {{ nextNo }} 章</van-button>
          <van-button size="small" round block icon="gift-o" :disabled="!status.live" @click="ask('extra')">写番外</van-button>
        </div>
      </template>
    </template>

    <!-- 设定 -->
    <div v-else class="scroll info">
      <label class="lbl">书名</label>
      <input :value="novel.title" class="field" placeholder="书名" @change="patch('title', ($event.target as HTMLInputElement).value.trim() || '未命名')" />
      <label class="lbl">类型</label>
      <input :value="novel.genre" class="field" placeholder="校园恋爱、仙侠、悬疑、科幻……" @change="patch('genre', ($event.target as HTMLInputElement).value)" />
      <label class="lbl">设定和人物</label>
      <textarea :value="novel.setting" class="area" rows="6" placeholder="世界观、主角和重要配角（名字、性格、关系）……商量时写作助手建议的设定，点一下也会记到这里" @change="patch('setting', ($event.target as HTMLTextAreaElement).value)" />
      <label class="lbl">大纲</label>
      <textarea :value="novel.outline" class="area" rows="5" placeholder="大概怎么开始、中间发生什么、怎么结尾（可以只写个开头）" @change="patch('outline', ($event.target as HTMLTextAreaElement).value)" />
      <label class="lbl">文风和尺度</label>
      <input :value="novel.style" class="field" placeholder="第一人称、轻松搞笑、细腻虐心、多写对白……" @change="patch('style', ($event.target as HTMLInputElement).value)" />
      <div class="text-[12px] text-ink-3 mt-2">这些都会带给写作助手；提示词在"我的 → 预设 → 小说"里改，模型在"我的 → API 设置 → 创作 · 小说"里选。</div>
      <button type="button" class="link danger mt-3" @click="removeNovel"><span class="i-lucide-trash-2" />删除这部小说</button>
    </div>

    <van-popup :show="!!asking" position="bottom" round teleport="body" @update:show="(v: boolean) => !v && (asking = null)">
      <div class="sheet">
        <div class="text-[15px] font-600">{{ askTitle }}</div>
        <textarea v-model="wish" class="area mt-2" rows="3" :placeholder="askHint" :aria-label="askHint" />
        <van-button type="primary" round block class="!mt-3" @click="startWrite">开始写</van-button>
      </div>
    </van-popup>
  </div>
</template>

<style scoped>
.studio {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}
.top {
  display: flex;
  align-items: center;
  gap: 6px;
}
.back {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--panel);
  font-size: 18px;
}
.name {
  flex: 1;
  min-width: 0;
  font-size: 15px;
  font-weight: 600;
}
.notice {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  padding: 8px 12px;
  border-radius: 12px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 12.5px;
}
.scroll {
  flex: 1;
  min-height: 0;
  margin-top: 10px;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 24px 12px;
  color: var(--ink-3);
  font-size: 13px;
  line-height: 1.6;
  text-align: center;
}
.talk {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bubble {
  max-width: 88%;
  padding: 8px 12px;
  border-radius: 16px;
  font-size: 14px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
.bubble.user {
  align-self: flex-end;
  background: var(--accent-soft);
  color: var(--ink);
  border-bottom-right-radius: 6px;
}
.bubble.assistant {
  align-self: flex-start;
  background: var(--panel);
  border: 1px solid var(--border);
  border-bottom-left-radius: 6px;
}
.notes {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
}
.note {
  display: inline-flex;
  align-items: flex-start;
  gap: 4px;
  max-width: 88%;
  padding: 5px 10px;
  border-radius: 12px;
  border: 1px dashed var(--accent-line);
  color: var(--accent-ink);
  font-size: 12.5px;
  line-height: 1.5;
  text-align: left;
}
.ideas {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
.composer {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  margin-top: 8px;
}
.send {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border-radius: 50%;
  background: var(--accent);
  color: #fff;
  font-size: 18px;
}
.send:disabled {
  opacity: 0.4;
}
.send.stop {
  background: var(--panel);
  color: var(--ink);
}
.link {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  align-self: flex-start;
  padding: 2px 0;
  font-size: 12.5px;
  color: var(--ink-3);
}
.link.danger {
  color: var(--bad);
}
.reader {
  padding: 2px 2px 8px;
}
.r-head {
  margin: 6px 0 10px;
}
.r-title {
  margin-top: 2px;
  font-family: var(--font-serif);
  font-size: 18px;
  font-weight: 600;
}
.r-text {
  font-family: var(--font-serif);
  font-size: 15px;
  line-height: 1.9;
  white-space: pre-wrap;
  word-break: break-word;
}
.caret {
  display: inline-block;
  width: 2px;
  height: 1em;
  margin-left: 2px;
  vertical-align: -0.15em;
  background: var(--accent);
  animation: blink 1s steps(2) infinite;
}
@keyframes blink {
  50% {
    opacity: 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .caret {
    animation: none;
  }
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  margin-bottom: 8px;
  padding: 10px 12px;
  border-radius: 14px;
  background: var(--panel);
  border: 1px solid var(--border);
  text-align: left;
}
.actions {
  display: flex;
  flex: none;
  gap: 8px;
  margin-top: 8px;
}
.actions :deep(.van-button) {
  padding: 0 6px;
  white-space: nowrap;
}
.info {
  display: flex;
  flex-direction: column;
}
.lbl {
  margin: 10px 0 4px;
  font-size: 12.5px;
  color: var(--ink-2);
}
.area {
  width: 100%;
  padding: 10px 12px;
  border-radius: 14px;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--ink);
  outline: none;
  font-size: 14px;
  line-height: 1.6;
  resize: none;
}
.area.edit {
  min-height: 50vh;
  font-family: var(--font-serif);
  resize: vertical;
}
.field {
  width: 100%;
  height: 36px;
  padding: 0 12px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--ink);
  outline: none;
  font-size: 14px;
}
.sheet {
  padding: 18px 16px calc(var(--safe-bottom, 0px) + 16px);
}
</style>
