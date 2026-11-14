import { errorText } from '@app/ai';
import { expressionPromptLines } from '@app/shared';
import { computed, reactive, watch, type Ref } from 'vue';
import { services } from '@/services';
import { ttsLiveFor } from '@/services/ai';
import { CallListener, looksLikeEcho } from '@/services/listener';
import { personaOf } from '@/services/prompt';
import { SentenceStream, SpeechQueue } from '@/services/speech';
import { useAiStore } from '@/stores/ai';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';
import { useVoiceStore, type CallInput } from '@/stores/voice';
import { sleep } from '@/utils/id';
import { clock } from '@/utils/time';

/**
 * 语音通话（设计文档 §11.2）：
 *   说话检测（你说完了）→ 语音识别 → 主对话（"语音通话"的预设：短句、不写动作）流式回复 → 按句合成语音、边合成边播放。
 * - 她先开口：你打给她时她接起来打招呼，她打给你时你接听后她说为什么打来；
 * - 你一开口她就停（可以在"我的 → 语音"关掉），聊天里只留下她已经说出口的部分；
 * - 语音识别没接通、麦克风用不了时改成打字；语音合成没接通时只有字幕、不出声；主对话没接通时写明原因。都不出演示台词；
 * - 说的话都存进你们的聊天（带"语音通话"的标记），挂断时发一张通话记录卡片。
 */

export type CallPhase = 'ringing' | 'dialing' | 'connected' | 'ended';

export interface Caption {
  id: number;
  who: 'her' | 'you';
  text: string;
  /** 还在识别 / 还在说 */
  pending?: boolean;
}

export function useVoiceCall(characterId: Ref<string>, opts: { incoming: boolean; reason?: string; video?: () => boolean }) {
  const chars = useCharacterStore();
  const chat = useChatStore();
  const ai = useAiStore();
  const voice = useVoiceStore();
  const character = computed(() => chars.byId(characterId.value) ?? chars.list[0]!);
  const chatId = computed(() => chat.chatOfCharacter(character.value.id)?.id ?? '');
  const userName = computed(() => personaOf(chat.chatById(chatId.value)).name);

  const state = reactive({
    phase: (opts.incoming ? 'ringing' : 'dialing') as CallPhase,
    seconds: 0,
    her: 'idle' as 'idle' | 'thinking' | 'speaking',
    you: 'idle' as 'idle' | 'speaking' | 'recognizing',
    herLevel: 0,
    herAudioLevel: 0,
    sentence: '',
    sentenceId: 0,
    youLevel: 0,
    captions: [] as Caption[],
    /** 这次通话实际用的输入方式（麦克风用不了时退回打字） */
    input: voice.call.input as CallInput,
    muted: false,
    /** 浏览器要求先点一下屏幕才能开始听 */
    needTap: false,
    llmIssue: '',
    sttIssue: '',
    micIssue: '',
    ttsIssue: '',
    hint: '',
  });

  const llmStatus = computed(() => ai.status('main'));
  const sttStatus = computed(() => ai.status('stt'));
  const voiceLive = computed(() => ttsLiveFor(character.value));

  let captionSeq = 0;
  let clockTimer: ReturnType<typeof setInterval> | undefined;
  let queue: SpeechQueue | null = null;
  let generating: Promise<string | undefined> | null = null;
  let replyId: string | null = null;
  let hintTimer: ReturnType<typeof setTimeout> | undefined;
  const sttCtrl = new AbortController();
  /** 她最近说过的话（判断识别结果是不是回声） */
  const herRecent: string[] = [];

  /** 挂断了没有（await 之后要重新看，所以写成函数） */
  const ended = () => state.phase === 'ended';
  const callLabel = () => opts.video?.() ? '视频通话' : '语音通话';
  let hadVideo = !!opts.video?.();
  watch(() => opts.video?.(), on => { if (on) hadVideo = true; });

  function addCaption(who: Caption['who'], text: string, pending = false): Caption {
    const c: Caption = { id: (captionSeq += 1), who, text, pending };
    state.captions.push(c);
    if (state.captions.length > 40) state.captions.splice(0, state.captions.length - 40);
    return state.captions.at(-1)!;
  }

  function hint(text: string) {
    state.hint = text;
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => (state.hint = ''), 2600);
  }

  // —— 听你说话 ——
  const listener = new CallListener({
    sensitivity: voice.call.sensitivity,
    endSilenceMs: voice.call.endSilenceMs,
    onLevel: (l) => (state.youLevel = l),
    onSpeechStart: () => {
      state.you = 'speaking';
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

  async function startListening() {
    if (state.input === 'type' || listener.active) return;
    if (!sttStatus.value.live) {
      state.sttIssue = `语音识别还没接通（${sttStatus.value.reason}），先打字和${character.value.pronoun}说`;
      state.input = 'type';
      return;
    }
    try {
      await listener.start();
      state.micIssue = '';
      state.needTap = listener.suspended;
    } catch (e) {
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
    if (state.phase === 'ended') return;
    state.you = 'recognizing';
    const cap = addCaption('you', '……', true);
    let text = '';
    try {
      text = await services.stt.transcribe(wav, { signal: sttCtrl.signal });
    } catch (e) {
      state.captions = state.captions.filter((c) => c.id !== cap.id);
      state.you = 'idle';
      if (sttCtrl.signal.aborted) return;
      const msg = errorText(e);
      if (/没有识别到/.test(msg)) hint('没听清，再说一遍？');
      else state.sttIssue = `语音识别失败：${msg}（完整报错在"我的 → API 设置 → 语音识别"）`;
      return;
    }
    state.you = 'idle';
    if (looksLikeEcho(text, herRecent.slice(-4))) {
      state.captions = state.captions.filter((c) => c.id !== cap.id);
      return;
    }
    state.sttIssue = '';
    Object.assign(cap, { text, pending: false });
    await youSaid(text, false);
  }

  /** 你说了一句（识别出来的，或者打的字） */
  async function youSaid(text: string, typed: boolean) {
    const t = text.trim();
    if (!t || !chatId.value || state.phase === 'ended') return;
    if (typed) addCaption('you', t);
    if (state.her !== 'idle') await interruptHer();
    chat.push(chatId.value, 'user', [{ type: 'text', text: t }], { meta: { scene: chat.chatById(chatId.value)?.currentScene ?? undefined, cue: callLabel() } });
    await herTurn('reply');
  }

  // —— 她说话 ——
  function taskInput(kind: 'open' | 'reply'): string {
    const user = userName.value;
    // 表情列她自己的（有立绘时是立绘上的那些）
    const visual = opts.video?.() ? `你的形象在画面中。根据当前情绪在句首写一个表情标签 [expr:表情]。${expressionPromptLines(character.value.portraits)}。无需朗读标签；没有用户摄像头画面，不要声称看见用户。` : '';
    if (kind === 'reply') return `${callLabel()}中（已经通话 ${clock(state.seconds)}）。回${user}刚才说的话。${visual}`;
    if (opts.incoming) return `这是一通${callLabel()}：你打电话给${user}，对方刚接起来${opts.reason ? `（你打来是因为：${opts.reason}）` : ''}。先开口说第一句，1–2 个短句。${visual}`;
    return `这是一通${callLabel()}：${user}打电话给你，你刚接起来。先开口打招呼，1–2 个短句。${visual}`;
  }

  async function herTurn(kind: 'open' | 'reply') {
    if (!chatId.value || state.phase === 'ended') return;
    if (!llmStatus.value.live) {
      state.llmIssue = `主对话还没接通：${llmStatus.value.reason}`;
      if (state.phase === 'dialing') connectNow();
      return;
    }
    // 聊天里还有一条在生成（比如刚才在聊天页发的）：停掉，等它收尾
    if (chat.streams[chatId.value]) {
      chat.stop(chatId.value);
      for (let i = 0; i < 40 && chat.streams[chatId.value]; i += 1) await sleep(50);
    }
    if (ended()) return;
    state.her = 'thinking';
    let cap: Caption | null = null;
    const q = new SpeechQueue({
      characterId: character.value.id,
      onLevel: (l) => (state.herLevel = l),
      onAudioLevel: (l) => { state.herAudioLevel = l; if (l > 0) state.ttsIssue = ''; },
      onSentence: (text) => {
        if (state.phase === 'dialing') connectNow();
        state.her = 'speaking';
        state.sentence = text;
        state.sentenceId++;
        listener.herSpeaking = true;
        herRecent.push(text);
        if (herRecent.length > 8) herRecent.shift();
        if (!cap) cap = addCaption('her', text);
        else cap.text += text;
      },
      onError: (msg) => (state.ttsIssue = `${msg}（完整报错在"我的 → API 设置 → 语音合成"）`),
    });
    queue = q;
    const stream = new SentenceStream();
    const run = chat.generate(chatId.value, undefined, {
      use: 'call',
      task: { name: kind === 'open' ? 'call-open' : 'call', input: taskInput(kind) },
      cue: callLabel(),
      allowedTags: ['expr'],
      // 通话要快：认得思考参数的接口把思考关到最少（会思考的模型另外留了思考的余量，不会再回空话）
      quick: true,
      onText: (full) => {
        if (!q.stopped) q.pushAll(stream.feed(full));
      },
    });
    generating = run;
    replyId = chat.streams[chatId.value]?.messageId ?? null;
    const id = await run;
    if (generating === run) generating = null;
    if (q.stopped) return;
    const msg = id ? chat.list(chatId.value).find((m) => m.id === id) : undefined;
    if (!msg || msg.meta.error) {
      state.llmIssue = msg?.meta.error ? `主对话回复失败：${msg.meta.error}` : '没有生成回复';
      q.stop();
      finishHer(q);
      if (state.phase === 'dialing') connectNow();
      return;
    }
    state.llmIssue = '';
    q.pushAll(stream.flush(msg.text));
    q.end();
    await q.drained();
    finishHer(q);
  }

  function finishHer(q: SpeechQueue) {
    if (queue !== q) return;
    queue = null;
    replyId = null;
    state.her = 'idle';
    state.herLevel = 0;
    state.herAudioLevel = 0;
    state.sentence = '';
    listener.herSpeaking = false;
  }

  /** 你开口了：她停下来，聊天里只留已经说出口的部分 */
  async function interruptHer() {
    const q = queue;
    const id = replyId;
    const run = generating;
    if (!q) return;
    const spoken = q.spoken.join('');
    q.stop();
    finishHer(q);
    if (chatId.value && chat.streams[chatId.value]) chat.stop(chatId.value);
    await run?.catch(() => undefined);
    if (id && chatId.value) chat.keepSpoken(chatId.value, id, spoken);
  }

  // —— 接通、挂断 ——
  let connected = false;
  function connectNow() {
    if (connected || state.phase === 'ended') return;
    connected = true;
    state.phase = 'connected';
    clearInterval(clockTimer);
    clockTimer = setInterval(() => (state.seconds += 1), 1000);
  }

  /** 来电：接听（在点击里调用，麦克风和音频在这时申请） */
  function accept() {
    if (state.phase !== 'ringing') return;
    connectNow();
    void services.native.keepAwake(true);
    void startListening();
    void herTurn('open');
  }

  /** 去电：打开页面就开始拨，她接起来（第一句开始说）时算接通 */
  function dial() {
    if (state.phase !== 'dialing') return;
    void services.native.keepAwake(true);
    void startListening();
    void herTurn('open');
  }

  function setInput(m: CallInput) {
    voice.call.input = m;
    state.input = m;
    listener.reset();
    if (m === 'type') {
      listener.stop();
      return;
    }
    void startListening();
  }

  function setMuted(on: boolean) {
    state.muted = on;
    listener.muted = on;
  }

  /** 按住说话 */
  function holdStart() {
    if (state.her !== 'idle') void interruptHer();
    listener.hold(true);
  }
  function holdEnd() {
    listener.hold(false);
  }

  /** 挂断：停掉一切，发通话记录卡片。missed：来电没接 */
  async function hangUp(missed = false) {
    if (state.phase === 'ended') return;
    const wasConnected = connected;
    state.phase = 'ended';
    clearInterval(clockTimer);
    clearTimeout(hintTimer);
    sttCtrl.abort();
    listener.stop();
    void services.native.keepAwake(false);
    const id = chatId.value;
    // 她说到一半挂了：只留说出口的
    await interruptHer();
    if (!id) return;
    if (missed || !wasConnected) {
      chat.postCard(id, opts.incoming ? 'assistant' : 'user', { type: 'call-log', durationSec: 0, missed: true, video: hadVideo });
      // 她打来你没接：让她发条消息（主对话接通时由模型写；没接通就只有未接来电卡片）
      if (opts.incoming && llmStatus.value.live) {
        void chat.generate(id, undefined, { task: { name: 'call-missed', input: `你刚才给${userName.value}打语音电话，对方没接。发一条消息给对方。` } });
      }
      return;
    }
    // 通话里说的话已经一句句存在聊天里了（卡片上面），卡片只记时长
    chat.postCard(id, 'user', { type: 'call-log', durationSec: state.seconds, video: hadVideo });
  }

  /** 来电时回一句"在忙"：存进聊天，主对话接通时她会回 */
  async function replyBusy(text: string) {
    if (state.phase === 'ended') return;
    state.phase = 'ended';
    const id = chatId.value;
    if (!id) return;
    chat.postCard(id, 'assistant', { type: 'call-log', durationSec: 0, missed: true, video: hadVideo });
    chat.push(id, 'user', [{ type: 'text', text }]);
    if (llmStatus.value.live) void chat.generate(id);
  }

  /** 页面关掉（返回、切走）时 */
  function dispose() {
    if (state.phase !== 'ended') void hangUp(state.phase === 'ringing');
    clearInterval(clockTimer);
    listener.stop();
    queue?.stop();
  }

  return {
    state,
    character,
    chatId,
    voiceLive,
    llmStatus,
    accept,
    dial,
    hangUp,
    replyBusy,
    youSaid,
    setInput,
    setMuted,
    holdStart,
    holdEnd,
    tapToListen,
    dispose,
  };
}
