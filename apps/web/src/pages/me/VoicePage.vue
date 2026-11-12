<script setup lang="ts">
import { apiLabel, compileFilter, DEFAULT_TTS_TEXT, errorReport, kindOf, prepareTtsText, splitSentences, volcengineClone, volcengineCloneStatus } from '@app/ai';
import { apiKeyId, type Character, type CharacterVoice, type TtsTextOptions } from '@app/shared';
import { computed, ref } from 'vue';
import Waveform from '@/components/call/Waveform.vue';
import Avatar from '@/components/common/Avatar.vue';
import ErrorDetails from '@/components/common/ErrorDetails.vue';
import Segmented from '@/components/common/Segmented.vue';
import PageHeader from '@/layouts/PageHeader.vue';
import { services } from '@/services';
import { ttsLiveFor } from '@/services/ai';
import { useAiStore } from '@/stores/ai';
import { useCharacterStore } from '@/stores/characters';
import { useLibraryStore } from '@/stores/library';
import { useVoiceStore } from '@/stores/voice';

const chars = useCharacterStore();
const ai = useAiStore();
const lib = useLibraryStore();
const voice = useVoiceStore();
const autoRead = ref<'off' | 'stage' | 'always'>('stage');
/** 停顿多久算说完：滑块用秒 */
const endSilenceSec = computed({ get: () => voice.call.endSilenceMs / 1000, set: (v: number) => (voice.call.endSilenceMs = Math.round(v * 1000)) });
const playing = ref<string | null>(null);
const level = ref(0);

/** 语音合成用的 API（API 设置里"语音合成"功能的渠道），所有角色共用；音色按角色设置 */
const ttsApi = computed(() => ai.routeOf('tts').api);
const ttsKind = computed(() => (ttsApi.value ? kindOf(ttsApi.value, 'tts') : undefined));
const ttsName = computed(() => (ttsApi.value ? apiLabel(ttsApi.value, 'tts') : '还没设置'));
function voiceLine(c: Character) {
  return `${c.voice.voiceLabel || c.voice.voiceId || '还没选音色'} · ${ttsName.value}`;
}
/** 语音识别用的 API */
const sttLine = computed(() => ai.apiLine('stt', ai.routeOf('stt').api));

/** 朗读哪些字：存在"语音合成"功能上，所有角色共用 */
const ttsText = computed<TtsTextOptions>(() => ai.routeOf('tts')?.ttsText ?? DEFAULT_TTS_TEXT);
function setTtsText(patch: Partial<TtsTextOptions>) {
  const r = ai.routeOf('tts');
  if (r) r.ttsText = { ...(r.ttsText ?? DEFAULT_TTS_TEXT), ...patch };
}
const regexBad = computed(() => !!ttsText.value.regex && !compileFilter(ttsText.value.regex));

/** 试听只读开场白的第一句（省钱也省时间），按上面的朗读设置处理 */
function sample(c: Character): string {
  return splitSentences(prepareTtsText(c.card.firstMes, { ...ttsText.value, speakerName: c.name }))[0] ?? '你好呀，今天过得怎么样？';
}

async function preview(c: Character) {
  playing.value = c.id;
  await services.tts.speak(sample(c), { characterId: c.id, onLevel: (l) => (level.value = l) });
  playing.value = null;
}

// —— 音色编辑 ——
const editingId = ref<string | null>(null);
const draft = ref<CharacterVoice | null>(null);
const editOpen = computed({ get: () => !!editingId.value, set: (v) => !v && (editingId.value = null) });
const draftKind = ttsKind;
const VOICE_HINT: Record<string, string> = {
  openai: '硅基流动系统音色写名字即可（claire、anna、alex…），上传的音色写 speech:…；OpenAI 写 alloy、coral…',
  minimax: 'voice_id，例如 female-shaonv，或你克隆的音色 id',
  volcengine: '音色 ID，例如 zh_female_vv_uranus_bigtts；复刻的音色是 S_ 开头的 Speaker ID',
  'fish-audio': '音色模型页上的 reference_id（不填用默认音色）',
  'gpt-sovits': '参考音频在服务器上的路径，例如 /data/ref/suwan.wav',
};
function openVoice(c: Character) {
  editingId.value = c.id;
  draft.value = JSON.parse(JSON.stringify(c.voice)) as CharacterVoice;
  cloneFile.value = null;
  cloneStatus.value = '';
  cloneError.value = '';
}

// —— 火山引擎声音复刻（同 SleepTogether）：先在控制台买好音色位，拿到 S_ 开头的 Speaker ID ——
const cloneFile = ref<File | null>(null);
const cloneBusy = ref(false);
const cloneStatus = ref('');
const cloneError = ref('');
function cloneEndpoint() {
  const a = ttsApi.value;
  if (!a) throw new Error('先在"API 设置 → 语音合成"里选火山引擎');
  const key = ai.keyOf(apiKeyId('tts'));
  if (!key) throw new Error('先在"API 设置 → 语音合成"里填 Access Token');
  const ep = ai.endpointOf(a, 'tts', key);
  if ('reason' in ep) throw new Error(ep.reason);
  return ep;
}
function pickCloneFile(e: Event) {
  cloneFile.value = (e.target as HTMLInputElement).files?.[0] ?? null;
}
async function uploadClone() {
  const v = draft.value;
  const file = cloneFile.value;
  if (!v || !file) return;
  cloneBusy.value = true;
  cloneError.value = '';
  try {
    const audio = new Uint8Array(await file.arrayBuffer());
    const format = file.name.split('.').pop()?.toLowerCase() || 'wav';
    const r = await volcengineClone(cloneEndpoint(), { speakerId: v.voiceId, audio, format });
    v.voiceId = r.speakerId;
    cloneStatus.value = '已上传，训练中';
    await checkClone();
  } catch (e) {
    cloneError.value = errorReport(e);
  } finally {
    cloneBusy.value = false;
  }
}
async function checkClone() {
  const v = draft.value;
  if (!v?.voiceId) return;
  cloneError.value = '';
  try {
    cloneStatus.value = (await volcengineCloneStatus(cloneEndpoint(), v.voiceId)).text;
  } catch (e) {
    cloneStatus.value = '';
    cloneError.value = errorReport(e);
  }
}
function saveVoice() {
  const c = chars.byId(editingId.value);
  const v = draft.value;
  if (!c || !v) return;
  v.voiceId = v.voiceId.trim();
  c.voice = { ...v, connectionId: undefined, model: v.model?.trim() || undefined, style: v.style?.trim() || undefined, refText: v.refText?.trim() || undefined, refLang: v.refLang?.trim() || undefined };
  editingId.value = null;
}
</script>

<template>
  <div class="page" data-page="voice">
    <PageHeader title="语音" subtitle="语音合成、语音识别、通话" fallback="/me" />
    <div class="page-scroll pb-10">
      <div class="group-title">她们的声音（语音合成）</div>
      <div class="px-4 grid gap-2.5">
        <div v-for="c in chars.list" :key="c.id" class="voice">
          <div class="flex items-center gap-3">
            <Avatar :character="c" :size="42" />
            <div class="flex-1 min-w-0">
              <div class="text-[15px] font-600">{{ c.name }}</div>
              <div class="text-[12.5px] text-ink-3 truncate">{{ voiceLine(c) }}</div>
              <div class="text-[11.5px] truncate" :class="ttsLiveFor(c) ? 'text-good' : 'text-ink-3'">{{ ttsLiveFor(c) ? '已接通' : '演示（没有声音）：在 API 设置里给语音合成选渠道、填 Key，再选音色' }}</div>
            </div>
            <van-button size="small" round @click="openVoice(c)">音色</van-button>
            <van-button size="small" round :loading="playing === c.id" @click="preview(c)">试听</van-button>
          </div>
          <Waveform v-if="playing === c.id" :level="level" class="mt-2" />
          <div class="flex items-center gap-3 mt-2.5">
            <span class="text-[12.5px] text-ink-3 num shrink-0 whitespace-nowrap">语速 {{ c.voice.speed.toFixed(2) }}</span>
            <van-slider v-model="c.voice.speed" :min="0.5" :max="2" :step="0.05" class="flex-1" bar-height="3px" button-size="14px" />
          </div>
        </div>
      </div>
      <p class="note">支持 OpenAI 兼容 /audio/speech（硅基流动 CosyVoice、各家中转）、MiniMax、火山引擎豆包语音（可以复刻声音）、Fish Audio、自建 GPT-SoVITS。按她当时的表情加情绪，同一句话的音频会复用。</p>

      <div class="group-title">朗读哪些字</div>
      <van-cell-group inset>
        <van-cell title="只读引号里的话" label="旁白、描写都跳过；一句引号都没有时照常读" center>
          <template #right-icon><van-switch :model-value="ttsText.quotedOnly" size="22px" @update:model-value="setTtsText({ quotedOnly: !!$event })" /></template>
        </van-cell>
        <van-cell title="读 *星号* 里的字" label="默认当作动作描写跳过" center>
          <template #right-icon><van-switch :model-value="ttsText.asterisks === 'keep'" size="22px" @update:model-value="setTtsText({ asterisks: $event ? 'keep' : 'drop' })" /></template>
        </van-cell>
        <van-cell title="读（括号）里的字" label="默认当作神态、旁白跳过" center>
          <template #right-icon><van-switch :model-value="ttsText.parentheses === 'keep'" size="22px" @update:model-value="setTtsText({ parentheses: $event ? 'keep' : 'drop' })" /></template>
        </van-cell>
        <van-cell title="跳过代码块和状态栏" label="``` 代码块、<状态栏>…</状态栏> 这类标签" center>
          <template #right-icon>
            <van-switch :model-value="ttsText.skipCodeBlocks && ttsText.skipTags" size="22px" @update:model-value="setTtsText({ skipCodeBlocks: !!$event, skipTags: !!$event })" />
          </template>
        </van-cell>
      </van-cell-group>
      <div class="px-4">
        <label class="field-label" for="tts-regex">另外跳过（正则，例如 /【.*?】/g）</label>
        <input
          id="tts-regex"
          class="input"
          :value="ttsText.regex ?? ''"
          autocomplete="off"
          spellcheck="false"
          @change="setTtsText({ regex: ($event.target as HTMLInputElement).value.trim() || undefined })"
        />
        <p v-if="regexBad" class="text-[12px] text-bad mt-1 mb-0">这条正则写错了，朗读时不会用</p>
      </div>
      <p class="note">表情符号、链接、Markdown 记号总是不读；消息开头的"名字："也会去掉。</p>

      <div class="group-title">自动朗读她的消息</div>
      <div class="px-4">
        <Segmented
          v-model="autoRead"
          :options="[
            { value: 'off', label: '不读' },
            { value: 'stage', label: '剧场模式读' },
            { value: 'always', label: '总是读' },
          ]"
        />
      </div>

      <div class="group-title">语音识别 · 通话</div>
      <van-cell-group inset>
        <van-cell title="识别服务" :value="sttLine" label="语音消息和通话都用它；在 API 设置 → 语音识别里改" is-link to="/me/api?feature=stt" />
        <van-cell title="通话时怎么说话" center>
          <template #label>
            <Segmented
              v-model="voice.call.input"
              class="!mt-2"
              :options="[
                { value: 'auto', label: '自动听' },
                { value: 'hold', label: '按住说' },
                { value: 'type', label: '打字' },
              ]"
            />
          </template>
        </van-cell>
        <van-cell :title="`说话检测灵敏度 ${voice.call.sensitivity}`" label="越高越容易判定你在说话；环境吵就调低">
          <template #label><van-slider v-model="voice.call.sensitivity" class="!mt-3" bar-height="4px" button-size="16px" /></template>
        </van-cell>
        <van-cell :title="`停顿 ${endSilenceSec.toFixed(1)} 秒算说完`" label="说话慢、爱停顿就调长一点">
          <template #label><van-slider v-model="endSilenceSec" :min="0.4" :max="2" :step="0.1" class="!mt-3" bar-height="4px" button-size="16px" /></template>
        </van-cell>
        <van-cell title="允许打断她" label="你一开口，她就停下来听（聊天里只留下她说出口的部分）" center>
          <template #right-icon><van-switch v-model="voice.call.bargeIn" size="22px" /></template>
        </van-cell>
        <van-cell title="通话用的预设" :value="lib.presetForUse('call')?.name ?? '没有对话预设'" is-link to="/me/presets?cat=chat" />
      </van-cell-group>
      <p class="note">通话流程：检测到你说完 → 语音识别 → 主对话模型（"语音通话"选的预设）流式回复 → 按句合成语音、边合成边播放。说的话都存进你们的聊天。语音识别没接通或麦克风用不了时可以打字；语音合成没接通时只有字幕。</p>
    </div>

    <!-- 音色编辑 -->
    <van-popup v-model:show="editOpen" position="bottom" round :style="{ maxHeight: '88%' }">
      <div v-if="draft" class="sheet">
        <div class="sheet-title">{{ chars.byId(editingId)?.name }}的声音</div>
        <div class="text-[12.5px] text-ink-3 mt-1">
          用 API 设置里"语音合成"的渠道：{{ ttsName }}
          <router-link to="/me/api" class="text-accent-ink ml-1">去改</router-link>
        </div>
        <label class="field-label" for="voice-id">音色</label>
        <input id="voice-id" v-model="draft.voiceId" class="input" autocomplete="off" />
        <p v-if="draftKind && VOICE_HINT[draftKind]" class="text-[12px] text-ink-3 mt-1.5 mb-0">{{ VOICE_HINT[draftKind] }}</p>
        <label class="field-label" for="voice-label">名字（只是显示用）</label>
        <input id="voice-label" v-model="draft.voiceLabel" class="input" placeholder="温柔女声" />
        <label class="field-label" for="voice-model">模型（空着用"语音合成"设置里的）</label>
        <input id="voice-model" v-model="draft.model" class="input" autocomplete="off" />
        <label class="field-label" for="voice-style">说话风格（CosyVoice、gpt-4o-mini-tts 会参考）</label>
        <input id="voice-style" v-model="draft.style" class="input" placeholder="温柔、语速稍慢" />
        <template v-if="draftKind === 'volcengine'">
          <label class="field-label">声音复刻（音色填 S_ 开头的 Speaker ID，再上传一段 10 秒以上的清晰录音）</label>
          <input class="block w-full text-[13px]" type="file" accept="audio/*,.wav,.mp3,.m4a,.ogg,.aac,.pcm" aria-label="用来复刻的录音" @change="pickCloneFile" />
          <div class="flex gap-2 mt-2">
            <van-button size="small" round :disabled="!cloneFile || !draft.voiceId" :loading="cloneBusy" loading-text="上传中" @click="uploadClone">上传并训练</van-button>
            <van-button size="small" round :disabled="!draft.voiceId" @click="checkClone">查看进度</van-button>
          </div>
          <p v-if="cloneStatus" class="text-[12px] text-ink-3 mt-1.5 mb-0">{{ cloneStatus }}</p>
          <ErrorDetails v-if="cloneError" :detail="cloneError" title="声音复刻出错" max-height="30vh" />
        </template>
        <template v-if="draftKind === 'gpt-sovits'">
          <label class="field-label" for="voice-ref">参考音频里说的话</label>
          <input id="voice-ref" v-model="draft.refText" class="input" />
          <label class="field-label" for="voice-lang">参考音频的语言（zh / ja / en）</label>
          <input id="voice-lang" v-model="draft.refLang" class="input" placeholder="zh" />
        </template>
        <div class="flex items-center gap-3 mt-3">
          <span class="text-[12.5px] text-ink-3 num shrink-0 whitespace-nowrap">语速 {{ draft.speed.toFixed(2) }}</span>
          <van-slider v-model="draft.speed" :min="0.5" :max="2" :step="0.05" class="flex-1" bar-height="3px" button-size="14px" />
        </div>
        <van-button round block type="primary" class="!mt-4" @click="saveVoice">保存</van-button>
      </div>
    </van-popup>
  </div>
</template>

<style scoped>
.opt {
  height: 32px;
  padding: 0 12px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 13px;
}
.opt.on {
  background: var(--accent);
  color: var(--on-accent);
  font-weight: 600;
}
.voice {
  padding: 12px 14px;
  border-radius: 16px;
  background: var(--surface);
  border: 1px solid var(--border);
}
</style>
