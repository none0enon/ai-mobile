<script setup lang="ts">
import { prepareTtsText, splitSentences } from '@app/ai';
import type { Character, CharacterVoice } from '@app/shared';
import { computed, ref } from 'vue';
import Waveform from '@/components/call/Waveform.vue';
import Avatar from '@/components/common/Avatar.vue';
import Segmented from '@/components/common/Segmented.vue';
import PageHeader from '@/layouts/PageHeader.vue';
import { services } from '@/services';
import { ttsLiveFor } from '@/services/ai';
import { useAiStore } from '@/stores/ai';
import { useCharacterStore } from '@/stores/characters';

const chars = useCharacterStore();
const ai = useAiStore();
const autoRead = ref<'off' | 'stage' | 'always'>('stage');
const vad = ref(55);
const bargeIn = ref(true);
const nativeFallback = ref(true);
const playing = ref<string | null>(null);
const level = ref(0);

/** 她用哪个 TTS 连接：自己选的，或者"语音合成"智能体分配的 */
function voiceConn(c: Character) {
  return ai.byId(c.voice.connectionId ?? ai.routeOf('tts')?.connectionId);
}
function voiceLine(c: Character) {
  const conn = voiceConn(c);
  return `${c.voice.voiceLabel || c.voice.voiceId || '还没选音色'} · ${conn?.name ?? '未选择连接'}`;
}

/** 试听只读开场白的第一句（省钱也省时间） */
function sample(c: Character): string {
  return splitSentences(prepareTtsText(c.card.firstMes))[0] ?? '你好呀，今天过得怎么样？';
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
const ttsConns = computed(() => ai.connections.filter((c) => c.capabilities.includes('tts')));
const draftKind = computed(() => ai.byId(draft.value?.connectionId ?? ai.routeOf('tts')?.connectionId)?.kind);
const VOICE_HINT: Record<string, string> = {
  openai: '硅基流动系统音色写名字即可（claire、anna、alex…），上传的音色写 speech:…；OpenAI 写 alloy、coral…',
  minimax: 'voice_id，例如 female-shaonv，或你克隆的音色 id',
  'fish-audio': '音色模型页上的 reference_id（不填用默认音色）',
  'gpt-sovits': '参考音频在服务器上的路径，例如 /data/ref/suwan.wav',
};
function openVoice(c: Character) {
  editingId.value = c.id;
  draft.value = JSON.parse(JSON.stringify(c.voice)) as CharacterVoice;
}
function saveVoice() {
  const c = chars.byId(editingId.value);
  const v = draft.value;
  if (!c || !v) return;
  v.voiceId = v.voiceId.trim();
  c.voice = { ...v, model: v.model?.trim() || undefined, style: v.style?.trim() || undefined, refText: v.refText?.trim() || undefined, refLang: v.refLang?.trim() || undefined };
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
              <div class="text-[11.5px] truncate" :class="ttsLiveFor(c) ? 'text-good' : 'text-ink-3'">{{ ttsLiveFor(c) ? '已接通' : '演示（没有声音）：给语音合成分配连接并填 Key' }}</div>
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
      <p class="note">支持 OpenAI 兼容 /audio/speech（硅基流动 CosyVoice、各家中转）、MiniMax、Fish Audio、自建 GPT-SoVITS。朗读前去掉（动作描写）和表情符号，按她当时的表情加情绪，同一句话的音频会复用。</p>

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
        <van-cell title="识别服务" value="硅基流动 SenseVoice" label="OpenAI 兼容 /audio/transcriptions" />
        <van-cell title="安卓系统识别兜底" label="网络不好时用手机自带的识别" center>
          <template #right-icon><van-switch v-model="nativeFallback" size="22px" /></template>
        </van-cell>
        <van-cell :title="`说话检测灵敏度 ${vad}`" label="判断你什么时候说完了">
          <template #label><van-slider v-model="vad" class="!mt-3" bar-height="4px" button-size="16px" /></template>
        </van-cell>
        <van-cell title="允许打断她" label="你一开口，她就停下来听" center>
          <template #right-icon><van-switch v-model="bargeIn" size="22px" /></template>
        </van-cell>
        <van-cell title="通话用的预设" value="通话 · 短句" is-link to="/me/presets/preset-call" />
      </van-cell-group>
      <p class="note">通话流程：检测到你说完 → 识别成文字 → 主对话模型流式回复 → 按句合成语音、边合成边播放。目标是首句 2 秒内出声。</p>
    </div>

    <!-- 音色编辑 -->
    <van-popup v-model:show="editOpen" position="bottom" round :style="{ maxHeight: '88%' }">
      <div v-if="draft" class="sheet">
        <div class="sheet-title">{{ chars.byId(editingId)?.name }}的声音</div>
        <label class="field-label">用哪个连接</label>
        <div class="flex flex-wrap gap-1.5">
          <button class="opt" :class="{ on: !draft.connectionId }" @click="draft.connectionId = null">跟随"语音合成"智能体</button>
          <button v-for="c in ttsConns" :key="c.id" class="opt" :class="{ on: draft.connectionId === c.id }" @click="draft.connectionId = c.id">{{ c.name }}</button>
        </div>
        <label class="field-label" for="voice-id">音色</label>
        <input id="voice-id" v-model="draft.voiceId" class="input" autocomplete="off" />
        <p v-if="draftKind && VOICE_HINT[draftKind]" class="text-[12px] text-ink-3 mt-1.5 mb-0">{{ VOICE_HINT[draftKind] }}</p>
        <label class="field-label" for="voice-label">名字（只是显示用）</label>
        <input id="voice-label" v-model="draft.voiceLabel" class="input" placeholder="温柔女声" />
        <label class="field-label" for="voice-model">模型（空着用智能体分配的）</label>
        <input id="voice-model" v-model="draft.model" class="input" autocomplete="off" />
        <label class="field-label" for="voice-style">说话风格（CosyVoice、gpt-4o-mini-tts 会参考）</label>
        <input id="voice-style" v-model="draft.style" class="input" placeholder="温柔、语速稍慢" />
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
