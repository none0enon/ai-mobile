import { errorText } from '@app/ai';
import type { Character, ControlTagKind, ParsedReply, PresetUseId } from '@app/shared';
import { computed, reactive, watch, type Ref } from 'vue';
import { services } from '@/services';
import { CallListener, looksLikeEcho } from '@/services/listener';
import { SentenceStream, type SpeechQueue } from '@/services/speech';
import { useAiStore } from '@/stores/ai';
import { useChatStore } from '@/stores/chat';
import { useVoiceStore } from '@/stores/voice';
import { sleep } from '@/utils/id';
import { clock } from '@/utils/time';

/**
 * 连麦（设计文档 §9.4；共同的家做家务时也用，§9.12）：说话她就听得到，她用自己的声音回你。下面按哄睡写，别的场景用 tasks / input 换掉：
 * 和语音通话（composables/useVoiceCall.ts）一样：说话检测 → 语音识别 → 她流式回复 → 按句合成、边合成边播；
 * 你一开口她就停（"我的 → 语音"里能关），聊天里只留她说出口的部分。不一样的是：
 * - 她的话由「陪伴 · 快速」按"哄睡"功能预设写：回你是 sleep-call，你安静久了她低语一句是 sleep-whisper（一次比一次隔得久，三句以后就不说了）；
 * - 她的声音和讲故事、晚安共用场景里的一路（newSpeech：同一时间只有一段，低语的音色和语速），白噪音、音乐在她说话时压低；
 * - 连上以后换到故事、白噪音、音乐也不断；她讲故事时你开口（识别出来不是回声），故事先停下来听你说；
 * - 定时到点、离开哄睡时挂断，麦克风随之关掉；连着时屏幕保持常亮（网页熄屏后就听不到了）；
 * - 语音识别没接通、麦克风用不了时改成打字；哪一步没接通写明原因，不出演示台词。
 * 说的话都存进你们的聊天（带"连麦"的标记），在哄睡这一段里。
 */

export type LinkInput = 'auto' | 'type';

export interface LinkCaption {
  id: number;
  who: 'her' | 'you';
  text: string;
  /** 还在识别 */
  pending?: boolean;
}

export interface MicLinkOptions {
  chatId: Ref<string>;
  character: Ref<Character>;
  userName: Ref<string>;
  /** 新开一段她的声音：场景里同一时间只有一段，正在念的故事、晚安会停下 */
  newSpeech(opts: { onSentence?(text: string, index: number): void }): SpeechQueue;
  /** 现在的情况（几点、灯、白噪音、在放什么歌），写进场景任务 */
  context(): string;
  /** 她在说别的（讲故事）：这时听你说话的门槛提高；要响应式的 */
  herBusy(): boolean;
  /** 你开口打断了她在说的别的（故事）：场景把它停下 */
  onInterrupt(): void;
  /** 你安静久了她要不要低语一句；要响应式的 */
  autoWhisper(): boolean;
  /** 连上、有人说话：场景开始计时、不再算"睡着了" */
  onActivity?(): void;
  /** 这件事里连麦用的任务名：回你、你安静久了她说一句（不给按哄睡：sleep-call / sleep-whisper） */
  tasks?: { reply: string; whisper?: string };
  /** 场景任务里这一次的输入怎么写（不给按哄睡：躺在床上、小声） */
  input?(kind: 'open' | 'reply' | 'whisper', info: { context: string; linked: string; quietMin: number }): string;
  /** 她的话按哪个用途的预设写（心跳的连麦用"心跳 · 语音"）；不给按场景的功能预设 */
  use?: PresetUseId;
  /** 这一次另外打开的预设触发条件（每次她开口前问一次） */
  flags?(): string[];
  /** 能执行哪些标签（不给只换表情） */
  allowedTags?(): ControlTagKind[];
  /** 她开口前（还没写）：心跳在这里开一条新的指令时间线 */
  onTurnStart?(): void;
  /** 流式时每次、写完时给解析好的正文和标签 */
  onParsed?(parsed: ParsedReply, done: boolean): void;
  /** 她这句写完了（还在念）：正文和这条消息的 id */
  onReply?(text: string, messageId: string): void;
}

/** 你安静多久她低语一句（秒）：一次比一次隔得久，说完这几句就不说了，让你睡 */
const WHISPER_AFTER_SEC = [45, 90, 180];

export function useMicLink(opts: MicLinkOptions) {
  const chat = useChatStore();
  const ai = useAiStore();
  const voice = useVoiceStore();
  const companion = computed(() => ai.status('companion'));
  const sttStatus = computed(() => ai.status('stt'));

  const state = reactive({
    /** 连着 */
    on: false,
    seconds: 0,
    her: 'idle' as 'idle' | 'thinking' | 'speaking',
    you: 'idle' as 'idle' | 'speaking' | 'recognizing',
    youLevel: 0,
    /** 自动听你说话，或者打字（语音识别没接通、麦克风用不了时退回打字） */
    input: 'auto' as LinkInput,
    /** 闭麦 */
    muted: false,
    /** 浏览器要求先点一下屏幕才能开始听 */
    needTap: false,
    captions: [] as LinkCaption[],
    llmIssue: '',
    sttIssue: '',
    micIssue: '',
    hint: '',
  });

  let captionSeq = 0;
  let clockTimer: ReturnType<typeof setInterval> | undefined;
  let hintTimer: ReturnType<typeof setTimeout> | undefined;
  let queue: SpeechQueue | null = null;
  let generating: Promise<string | undefined> | null = null;
  let replyId: string | null = null;
  let sttCtrl = new AbortController();
  /** 她最近说过的话（判断识别结果是不是回声） */
  const herRecent: string[] = [];
  /** 从什么时候开始没人说话（她低语用） */
  let quietSince = 0;
  /** 你上次开口的时间（连上时算一次） */
  let lastYouAt = 0;
  /** 你上次开口以后她低语了几句 */
  let whispered = 0;
  /** 你选的说话方式（这一次连麦因为没接通退回打字，下次连上时还按你选的来） */
  let preferred: LinkInput = 'auto';

  /** 这条聊天正在生成的那条回复（generate 一开始就登记好了） */
  function streamingId(chatId: string): string | null {
    return chat.streams[chatId]?.messageId ?? null;
  }

  function addCaption(who: LinkCaption['who'], text: string, pending = false): LinkCaption {
    state.captions.push({ id: (captionSeq += 1), who, text, pending });
    if (state.captions.length > 20) state.captions.splice(0, state.captions.length - 20);
    return state.captions.at(-1)!;
  }
  function dropCaption(id: number) {
    state.captions = state.captions.filter((c) => c.id !== id);
  }
  function hint(text: string) {
    state.hint = text;
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => (state.hint = ''), 2600);
  }
  /** 她说出口的一句（连麦里回的、讲的故事）：记下来认回声 */
  function noteHerLine(text: string) {
    herRecent.push(text);
    if (herRecent.length > 8) herRecent.shift();
  }

  // —— 听你说话 ——
  const listener = new CallListener({
    sensitivity: voice.call.sensitivity,
    endSilenceMs: voice.call.endSilenceMs,
    onLevel: (l) => (state.youLevel = l),
    onSpeechStart: () => {
      state.you = 'speaking';
      quietSince = Date.now();
      // 她还没开口（在想）：你接着说，作废她这次的回复；她在说：允许打断时停下来听
      if (state.her === 'thinking') void interruptHer();
      else if (state.her === 'speaking' && voice.call.bargeIn) void interruptHer();
    },
    onDiscard: () => {
      if (state.you === 'speaking') state.you = 'idle';
    },
    onUtterance: (wav) => void heard(wav),
  });
  watch(
    () => [voice.call.sensitivity, voice.call.endSilenceMs] as const,
    ([sensitivity, endSilenceMs]) => listener.configure({ sensitivity, endSilenceMs }),
  );
  watch(
    () => voice.call.bargeIn,
    (on) => (listener.ignoreWhileHerSpeaking = !on),
    { immediate: true },
  );
  watch(
    () => state.input,
    (m) => (listener.auto = m === 'auto'),
    { immediate: true },
  );
  // 她在说话（连麦里回你、讲故事）：扬声器漏进麦克风的声音不容易被当成你在说
  watch(
    () => state.her === 'speaking' || opts.herBusy(),
    (on) => (listener.herSpeaking = on),
    { immediate: true },
  );

  async function startListening() {
    if (!state.on || state.input === 'type' || listener.active) return;
    if (!sttStatus.value.live) {
      state.sttIssue = `语音识别还没接通（${sttStatus.value.reason}），先打字和${opts.character.value.pronoun}说`;
      state.input = 'type';
      return;
    }
    try {
      await listener.start();
      state.micIssue = '';
      state.needTap = listener.suspended;
    } catch (e) {
      if (!state.on) return;
      state.micIssue = errorText(e);
      state.input = 'type';
    }
  }

  /** 点了屏幕：恢复被挂起的音频（浏览器要求用户先操作一下） */
  async function tapToListen() {
    await listener.resume();
    state.needTap = listener.suspended;
  }

  async function heard(wav: Blob) {
    if (!state.on) return;
    state.you = 'recognizing';
    const cap = addCaption('you', '……', true);
    const ctrl = sttCtrl;
    let text = '';
    try {
      text = await services.stt.transcribe(wav, { signal: ctrl.signal });
    } catch (e) {
      dropCaption(cap.id);
      if (state.you === 'recognizing') state.you = 'idle';
      if (ctrl.signal.aborted || !state.on) return;
      const msg = errorText(e);
      if (/没有识别到/.test(msg)) hint('没听清，再说一遍？');
      else state.sttIssue = `语音识别失败：${msg}（完整报错在"我的 → API 设置 → 语音识别"）`;
      return;
    }
    if (state.you === 'recognizing') state.you = 'idle';
    if (!state.on || looksLikeEcho(text, herRecent.slice(-4))) {
      dropCaption(cap.id);
      return;
    }
    state.sttIssue = '';
    Object.assign(cap, { text, pending: false });
    await youSaid(text, false);
  }

  /** 你说了一句（识别出来的，或者打的字） */
  async function youSaid(text: string, typed: boolean) {
    const t = text.trim();
    const id = opts.chatId.value;
    if (!t || !id || !state.on) return;
    if (typed) addCaption('you', t);
    whispered = 0;
    lastYouAt = quietSince = Date.now();
    opts.onActivity?.();
    // 她在讲故事：先停下来听你说（继续时从停下的那句读）
    if (opts.herBusy()) opts.onInterrupt();
    if (state.her !== 'idle') await interruptHer();
    if (!state.on) return;
    chat.push(id, 'user', [{ type: 'text', text: t }], { meta: { scene: chat.chatById(id)?.currentScene ?? undefined, cue: '连麦' } });
    await herTurn('reply');
  }

  // —— 她说话 ——
  function quietMinutes(): number {
    return Math.max(1, Math.round((Date.now() - lastYouAt) / 60_000));
  }

  function taskInput(kind: 'open' | 'reply' | 'whisper'): string {
    const ctx = opts.context();
    if (opts.input) return opts.input(kind, { context: ctx, linked: clock(state.seconds), quietMin: quietMinutes() });
    const user = opts.userName.value;
    if (kind === 'open') return `${ctx}你们刚连上麦，${user}躺在床上。先小声开口说第一句，1–2 个短句。`;
    if (kind === 'whisper') return `${ctx}连麦中（已经连了 ${clock(state.seconds)}），${user}已经安静了 ${quietMinutes()} 分钟，可能快睡着了。`;
    return `${ctx}连麦中（已经连了 ${clock(state.seconds)}）。回${user}刚才说的话。`;
  }

  async function herTurn(kind: 'open' | 'reply' | 'whisper') {
    const id = opts.chatId.value;
    if (!id || !state.on) return;
    if (!companion.value.live) {
      state.llmIssue = `「陪伴 · 快速」还没接通：${companion.value.reason}`;
      return;
    }
    // 聊天里还有一条在生成（故事还在写、刚才在聊天页发的）：停掉，等它收尾
    if (chat.streams[id]) {
      chat.stop(id);
      for (let i = 0; i < 40 && chat.streams[id]; i += 1) await sleep(50);
    }
    if (!state.on || chat.streams[id]) return;
    state.her = 'thinking';
    opts.onActivity?.();
    opts.onTurnStart?.();
    let cap: LinkCaption | null = null;
    const q = opts.newSpeech({
      onSentence: (text) => {
        if (queue !== q) return;
        state.her = 'speaking';
        noteHerLine(text);
        if (!cap) cap = addCaption('her', text);
        else cap.text += text;
      },
    });
    queue = q;
    const stream = new SentenceStream();
    let mine: string | null = null;
    const run = chat.generate(id, undefined, {
      agent: 'companion',
      task: { name: kind === 'whisper' ? (opts.tasks?.whisper ?? 'sleep-whisper') : (opts.tasks?.reply ?? 'sleep-call'), input: taskInput(kind) },
      cue: '连麦',
      allowedTags: opts.allowedTags?.() ?? ['expr'],
      // 要快：认得思考参数的接口把思考关到最少
      quick: true,
      ...(opts.use ? { use: opts.use } : {}),
      ...(opts.flags ? { flags: opts.flags() } : {}),
      ...(opts.onParsed ? { onParsed: opts.onParsed } : {}),
      onText: (full) => {
        // 被顶掉了（开始讲故事、定时到了说晚安）：后面不用再写了
        if (q.stopped) {
          if (mine && streamingId(id) === mine) chat.stop(id);
          return;
        }
        q.pushAll(stream.feed(full));
      },
    });
    generating = run;
    mine = replyId = streamingId(id);
    const msgId = await run;
    if (generating === run) generating = null;
    if (!q.stopped) {
      const msg = msgId ? chat.list(id).find((m) => m.id === msgId) : undefined;
      if (!msg || msg.meta.error) {
        state.llmIssue = msg?.meta.error ? `${opts.character.value.name}没回上：${msg.meta.error}` : '没有生成回复';
        q.stop();
        finishHer(q);
        return;
      }
      state.llmIssue = '';
      q.pushAll(stream.flush(msg.text));
      q.end();
      opts.onReply?.(msg.text, msg.id);
      await q.drained();
    }
    // 说到一半被别的声音顶掉了：聊天里只留说出口的（被你打断的已经在 interruptHer 里留好了）
    if (q.stopped && queue === q && msgId) chat.keepSpoken(id, msgId, q.spoken.join(''));
    finishHer(q);
  }

  function finishHer(q: SpeechQueue) {
    if (queue !== q) return;
    queue = null;
    replyId = null;
    state.her = 'idle';
    quietSince = Date.now();
  }

  /** 你开口了：她停下，聊天里只留已经说出口的部分 */
  async function interruptHer() {
    const q = queue;
    const id = replyId;
    const run = generating;
    if (!q) return;
    const spoken = q.spoken.join('');
    q.stop();
    finishHer(q);
    const cid = opts.chatId.value;
    if (cid && id && streamingId(cid) === id) chat.stop(cid);
    await run?.catch(() => undefined);
    if (cid && id) chat.keepSpoken(cid, id, spoken);
  }

  /** 每秒：连了多久；你安静久了她低语一句 */
  function tick() {
    state.seconds += 1;
    if (!state.on || !opts.autoWhisper() || whispered >= WHISPER_AFTER_SEC.length) return;
    if (state.her !== 'idle' || state.you !== 'idle' || opts.herBusy() || chat.streams[opts.chatId.value]) {
      quietSince = Date.now();
      return;
    }
    if (Date.now() - quietSince < WHISPER_AFTER_SEC[whispered]! * 1000) return;
    whispered += 1;
    void herTurn('whisper');
  }

  // —— 连上、挂断 ——

  /** 连麦（在点击里调用：麦克风和音频在这时申请）。她先小声开口 */
  function connect() {
    if (state.on) return;
    Object.assign(state, { on: true, seconds: 0, her: 'idle', you: 'idle', input: preferred, muted: false, needTap: false, captions: [], llmIssue: '', sttIssue: '', micIssue: '', hint: '' });
    listener.muted = false;
    sttCtrl = new AbortController();
    whispered = 0;
    lastYouAt = quietSince = Date.now();
    clearInterval(clockTimer);
    clockTimer = setInterval(tick, 1000);
    void services.native.keepAwake(true);
    opts.onActivity?.();
    void startListening();
    void herTurn('open');
  }

  /** 挂断：麦克风关掉，她说到一半的只留说出口的 */
  async function hangUp() {
    if (!state.on) return;
    state.on = false;
    clearInterval(clockTimer);
    clearTimeout(hintTimer);
    sttCtrl.abort();
    listener.stop();
    Object.assign(state, { you: 'idle', youLevel: 0, needTap: false, hint: '' });
    void services.native.keepAwake(false);
    await interruptHer();
  }

  function setInput(m: LinkInput) {
    preferred = m;
    state.input = m;
    listener.reset();
    if (m === 'type') {
      listener.stop();
      state.needTap = false;
      return;
    }
    state.micIssue = '';
    state.sttIssue = '';
    void startListening();
  }

  function setMuted(on: boolean) {
    state.muted = on;
    listener.muted = on;
  }

  /** 离开这件事时 */
  function dispose() {
    void hangUp();
    listener.stop();
  }

  return {
    state,
    connect,
    hangUp,
    setInput,
    setMuted,
    tapToListen,
    say: (text: string) => youSaid(text, true),
    /** 你要她做别的（讲故事）：她在连麦里正回着的先停下，只留说出口的 */
    interrupt: interruptHer,
    noteHerLine,
    dispose,
  };
}
