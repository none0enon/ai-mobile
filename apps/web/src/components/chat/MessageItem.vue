<script setup lang="ts">
import { applyRegexScripts, hasMath, type Character, type Message, type MessagePart, type RegexNames, type RegexScript } from '@app/shared';
import { computed } from 'vue';
import CodeBlock from './CodeBlock.vue';
import HtmlFrame from './HtmlFrame.vue';
import HtmlText from './HtmlText.vue';
import MessageEditor from './MessageEditor.vue';
import PartCard from './PartCard.vue';
import Avatar from '@/components/common/Avatar.vue';
import ErrorDetails from '@/components/common/ErrorDetails.vue';
import PersonaAvatar from '@/components/common/PersonaAvatar.vue';
import RichText from '@/components/common/RichText.vue';
import { personas } from '@/mock/characters';
import { useAppearanceStore } from '@/stores/appearance';
import { useChatStore } from '@/stores/chat';
import { useMessageSettingsStore } from '@/stores/messageSettings';
import { hashText, isFrontendCode, splitFences } from '@/utils/html';

const props = defineProps<{
  message: Message;
  character: Character;
  isLast: boolean;
  streaming: boolean;
  thinking: boolean;
  /** 点了头像：在头像旁边展开重试 / 编辑 / 复制 / 删除 */
  toolsOpen?: boolean;
  /** 正在就地改这条 */
  editing?: boolean;
  /** 这个角色的对话预设里的正则（这里只跑"只改显示"的） */
  regex?: readonly RegexScript[];
  /** 正则里 {{char}} {{user}} 换成谁 */
  names?: RegexNames;
  /** 这一条是第几条（从 0 数）、最后一条是第几条：正则的深度、HTML 界面只在最后几条里运行 */
  index?: number;
  lastIndex?: number;
}>();
const emit = defineEmits<{
  (e: 'toggle-tools'): void;
  (e: 'swipe', dir: 1 | -1): void;
  (e: 'regenerate'): void;
  (e: 'edit'): void;
  (e: 'copy', text: string): void;
  (e: 'delete'): void;
  (e: 'save-edit', text: string): void;
  (e: 'cancel-edit'): void;
  (e: 'choose', text: string): void;
  (e: 'open-music', part: MessagePart): void;
  (e: 'open-image', part: MessagePart): void;
  (e: 'answer-date', ok: boolean): void;
}>();

const mine = computed(() => props.message.role === 'user');

/** 你上传过头像时，你的消息右边也显示头像（没上传就不占地方） */
const chatStore = useChatStore();
const looks = useAppearanceStore();
const me = computed(() => personas.find((p) => p.id === chatStore.chatById(props.message.chatId)?.personaId) ?? personas[0]);
const showMyAvatar = computed(() => !!me.value && !!looks.imageUrl(looks.avatarKey('persona', me.value.id) ?? me.value.avatar));
const narrator = computed(() => props.message.role === 'narrator' || props.message.role === 'system');
const textParts = computed(() => props.message.parts.filter((p) => p.type === 'text' && p.text));
const pokeParts = computed(() => props.message.parts.filter((p) => p.type === 'poke'));
const cardParts = computed(() => props.message.parts.filter((p) => p.type !== 'text' && p.type !== 'poke'));
const editText = computed(() => textParts.value.map((p) => (p.type === 'text' ? p.text : '')).join('\n'));
/** 复制用的文字：文字部分；只有语音时是转出来的文字 */
const copyText = computed(
  () =>
    editText.value.trim() ||
    props.message.parts
      .map((p) => (p.type === 'voice' ? p.transcript : ''))
      .filter(Boolean)
      .join('\n'),
);

// —— 消息操作平时藏着（沉浸），点头像在头像旁边展开 ——
/** 只有最后一条能重试：她的回复是再出一个备选；你的消息（她还没回）是让她回一条 */
const canRetry = computed(() => props.isLast);
/** 回复失败、被打断时自动展开，好直接点重试 */
const open = computed(() => !props.editing && (!!props.toolsOpen || (!mine.value && props.isLast && !props.streaming && !!(props.message.meta.error || props.message.meta.interrupted))));

/** 你没设头像时，点你的消息展开（点到卡片里的按钮、选了文字时不算） */
function onColClick(e: MouseEvent) {
  if (!mine.value || showMyAvatar.value || props.editing) return;
  if ((e.target as Element).closest('button, a, input, textarea')) return;
  if (window.getSelection()?.toString()) return;
  e.stopPropagation();
  emit('toggle-tools');
}

/** 把（动作描写）和 *动作* 拆出来，用淡一点的字显示 */
function segments(text: string) {
  return text.split(/(（[^）]*）|\([^)]*\)|\*[^*]+\*)/).filter(Boolean).map((s) => ({
    text: s,
    action: /^（|^\(|^\*/.test(s),
  }));
}

// —— 显示：预设里"只改显示"的正则 → 分出 ``` 代码块 → 文字（HTML 打开时按网页显示）、HTML 界面（沙盒小窗）、折起来的代码 ——
const msgSettings = useMessageSettingsStore();
/** 倒数第几条（0 = 最后一条） */
const depth = computed(() => (props.index !== undefined && props.lastIndex !== undefined ? props.lastIndex - props.index : undefined));
const htmlOn = computed(() => msgSettings.settings.html);
/** HTML 界面只在最后几条消息里运行 */
const framesOn = computed(() => htmlOn.value && depth.value !== undefined && depth.value < msgSettings.settings.frameLast);

type Block =
  | { key: string; kind: 'text'; text: string }
  | { key: string; kind: 'frame'; code: string }
  | { key: string; kind: 'code'; code: string; lang: string; frontend: boolean; note: string };

function shown(text: string): string {
  if (!props.regex?.length || !props.names || narrator.value) return text;
  return applyRegexScripts(props.regex, text, { target: 'display', placement: mine.value ? 'user_input' : 'ai_output', depth: depth.value, ...props.names });
}

/** 折叠的 HTML 页面未渲染的原因（我的 → 消息设置） */
function codeNote(closed: boolean): string {
  if (!htmlOn.value) return 'HTML 渲染已关闭';
  if (!closed) return props.streaming ? '生成中' : '代码块不完整';
  if (props.streaming) return '生成完成后渲染';
  const n = msgSettings.settings.frameLast;
  return n ? `仅渲染最近 ${n} 条` : '已设为不渲染';
}

const blocks = computed<Block[]>(() => {
  const out: Block[] = [];
  textParts.value.forEach((p, pi) => {
    if (p.type !== 'text') return;
    splitFences(shown(p.text)).forEach((s, si) => {
      if (s.kind === 'text') {
        const text = s.text.replace(/^\s*\n|\n\s*$/g, '');
        if (text.trim()) out.push({ key: `${pi}-t${si}`, kind: 'text', text });
        return;
      }
      const frontend = isFrontendCode(s.code);
      // 同样的代码 key 不变：前面的字变了、新消息来了，小窗都不重新加载
      if (frontend && framesOn.value && s.closed && !props.streaming) out.push({ key: `${pi}-f${hashText(s.code)}`, kind: 'frame', code: s.code });
      else out.push({ key: `${pi}-c${si}`, kind: 'code', code: s.code, lang: s.lang, frontend, note: frontend ? codeNote(s.closed) : '' });
    });
  });
  return out;
});
const lastTextKey = computed(() => [...blocks.value].reverse().find((b) => b.kind === 'text')?.key);
/** 有 HTML 界面时这一条占满整行（界面一般按手机宽度做的） */
const wide = computed(() => blocks.value.some((b) => b.kind === 'frame'));
</script>

<template>
  <div class="msg" :class="{ mine, narrator }" :data-role="message.role">
    <!-- 拍一拍：居中的一行提示 -->
    <div v-for="(p, i) in pokeParts" :key="`poke-${i}`" class="center-line">
      <PartCard :part="p" :character="character" :mine="mine" />
    </div>

    <!-- 旁白 / 场景分段 / 场景记录：居中，按顺序显示 -->
    <template v-if="narrator">
      <template v-for="(p, i) in message.parts" :key="i">
        <p v-if="p.type === 'text'" class="narration">{{ p.text }}</p>
        <div v-else-if="p.type !== 'poke'" class="center-line">
          <PartCard :part="p" :character="character" :mine="false" />
        </div>
      </template>
    </template>

    <div v-else-if="textParts.length || cardParts.length || streaming || message.meta.error || message.meta.interrupted" class="row">
      <button v-if="!mine" type="button" class="ava-btn mt-0.5" :aria-label="`${character.name}这条消息的操作`" :aria-expanded="open" @click.stop="emit('toggle-tools')">
        <Avatar :character="character" :size="34" />
      </button>
      <div class="col" :class="{ editing, wide: wide && !editing }" @click="onColClick">
        <Transition name="tools">
          <div v-if="open" class="tools" role="toolbar" aria-label="消息操作" @click.stop>
            <template v-if="canRetry && !mine && message.swipes.length > 1">
              <button type="button" class="tool" aria-label="上一个回复" :disabled="streaming" @click="emit('swipe', -1)"><span class="i-lucide-chevron-left" /></button>
              <span class="num count">{{ message.swipeIndex + 1 }}/{{ message.swipes.length }}</span>
              <button type="button" class="tool" aria-label="下一个回复" :disabled="streaming" @click="emit('swipe', 1)"><span class="i-lucide-chevron-right" /></button>
              <span class="sep" />
            </template>
            <button v-if="canRetry" type="button" class="tool" :aria-label="mine ? `让${character.pronoun}回复` : '重新生成'" :disabled="streaming" @click="emit('regenerate')">
              <span class="i-lucide-refresh-cw" />
            </button>
            <button v-if="textParts.length" type="button" class="tool" aria-label="编辑" :disabled="streaming" @click="emit('edit')"><span class="i-lucide-pencil" /></button>
            <button v-if="copyText" type="button" class="tool" aria-label="复制" @click="emit('copy', copyText)"><span class="i-lucide-copy" /></button>
            <button type="button" class="tool danger" aria-label="删除" :disabled="streaming" @click="emit('delete')"><span class="i-lucide-trash-2" /></button>
          </div>
        </Transition>
        <span v-if="message.proactive" class="proactive">
          <span class="i-lucide-bell-ring text-[11px]" />她主动找你
        </span>
        <div v-if="streaming && thinking && !message.text" class="bubble ai">
          <span class="typing-dot" /> <span class="typing-dot" /> <span class="typing-dot" />
        </div>
        <MessageEditor v-if="editing" :text="editText" :mine="mine" :allow-empty="cardParts.length > 0" @save="(t) => emit('save-edit', t)" @cancel="emit('cancel-edit')" />
        <template v-else>
          <template v-for="b in blocks" :key="b.key">
            <div v-if="b.kind === 'text'" class="bubble" :class="[mine ? 'me' : 'ai', { 'stream-caret': !htmlOn && streaming && b.key === lastTextKey }]">
              <!-- HTML 渲染打开：标签按白名单显示（<details> 折叠……），标签外的字照常（动作淡一点、公式） -->
              <HtmlText v-if="htmlOn" :text="b.text" :caret="streaming && b.key === lastTextKey" />
              <!-- 有公式（一起读专业书时的批注、讲题）：公式用 KaTeX 显示，括号里的动作照样淡一点 -->
              <RichText v-else-if="hasMath(b.text)" :text="b.text" actions />
              <template v-for="(s, j) in segments(b.text)" v-else :key="j">
                <span :class="{ action: s.action }">{{ s.text }}</span>
              </template>
            </div>
            <HtmlFrame v-else-if="b.kind === 'frame'" class="frame" :class="{ 'frame-mine': mine }" :code="b.code" :message-index="index ?? 0" :last-index="lastIndex ?? 0" />
            <CodeBlock v-else :code="b.code" :lang="b.lang" :frontend="b.frontend" :note="b.note" />
          </template>
        </template>
        <PartCard
          v-for="(p, i) in cardParts"
          :key="`card-${i}`"
          :part="p"
          :character="character"
          :mine="mine"
          @open-music="(part) => emit('open-music', part)"
          @open-image="emit('open-image', p)"
          @answer-date="(ok) => emit('answer-date', ok)"
        />
        <div v-if="!mine && isLast && !editing && message.meta.choices?.length" class="choices">
          <button v-for="c in message.meta.choices" :key="c" class="choice press" @click="emit('choose', c)">{{ c }}</button>
        </div>
        <span v-if="message.meta.interrupted" class="text-[12px] text-warn">回复被打断了 · 点上面的 ↻ 重新生成</span>
        <ErrorDetails v-if="message.meta.error" class="err-details" :detail="message.meta.errorDetail ?? message.meta.error" title="回复失败（点上面的 ↻ 重新生成）" max-height="220px" />
      </div>
      <button v-if="mine && showMyAvatar && me" type="button" class="ava-btn mt-0.5" aria-label="这条消息的操作" :aria-expanded="open" @click.stop="emit('toggle-tools')">
        <PersonaAvatar :persona="me" :size="34" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.err-details {
  width: 100%;
  max-width: 100%;
  margin-top: 4px;
}
.err {
  max-width: 100%;
  font-size: 12px;
  line-height: 1.5;
  color: var(--bad);
  white-space: pre-wrap;
  word-break: break-word;
}
.msg {
  padding: 5px 14px;
}
.row {
  display: flex;
  gap: 8px;
  align-items: flex-start;
}
.mine .row {
  justify-content: flex-end;
}
.ava-btn {
  display: inline-flex;
  flex-shrink: 0;
  border-radius: 50%;
}
.col {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  max-width: 78%;
  min-width: 0;
}
.mine .col {
  align-items: flex-end;
}
/* 改消息时编辑框占满一行 */
.col.editing {
  flex: 1;
  max-width: 100%;
}
/* 有 HTML 界面：这一条占满一行，界面从头像下面开始（播放器、状态栏一般按手机宽度做） */
.col.wide {
  flex: 1;
  max-width: 100%;
}
.frame {
  width: calc(100% + 42px);
  margin-left: -42px;
}
.frame.frame-mine {
  width: 100%;
  margin-left: 0;
}
.bubble {
  padding: 9px 13px;
  border-radius: 18px;
  font-size: 15.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
.bubble.ai {
  background: var(--bubble-ai);
  border: 1px solid var(--border);
  border-top-left-radius: 6px;
  color: var(--ink);
}
.bubble.me {
  background: var(--bubble-me);
  color: var(--on-bubble-me);
  border-top-right-radius: 6px;
}
.action,
.bubble :deep(.action) {
  opacity: 0.62;
  font-style: italic;
}
.proactive {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--accent-ink);
}
/* 头像旁边展开的一排操作：和头像一样高，排在气泡上面 */
.tools {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 2px;
  width: max-content;
  height: 34px;
  padding: 0 3px;
  border-radius: 99px;
  background: var(--surface);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-sm);
}
.tool {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  color: var(--ink-2);
  font-size: 15px;
}
.tool:active {
  background: var(--panel);
}
.tool:disabled {
  opacity: 0.35;
}
.tool.danger {
  color: var(--bad);
}
.count {
  padding: 0 1px;
  font-size: 12px;
  color: var(--ink-3);
}
.sep {
  width: 1px;
  height: 16px;
  margin: 0 3px;
  background: var(--border);
}
.tools-enter-active,
.tools-leave-active {
  transition:
    opacity 0.16s,
    transform 0.16s var(--ease);
}
.tools-enter-from,
.tools-leave-to {
  opacity: 0;
  transform: translateX(-6px);
}
.mine .tools-enter-from,
.mine .tools-leave-to {
  transform: translateX(6px);
}
.choices {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.choice {
  padding: 6px 12px;
  border-radius: 99px;
  border: 1px solid var(--accent-line);
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: 13.5px;
}
.center-line {
  display: flex;
  justify-content: center;
  margin: 2px 0;
}
.narration {
  margin: 4px auto;
  max-width: 86%;
  text-align: center;
  font-size: 13px;
  color: var(--ink-3);
  font-style: italic;
}
</style>
