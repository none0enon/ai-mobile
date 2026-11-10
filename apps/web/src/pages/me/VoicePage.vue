<script setup lang="ts">
import { ref } from 'vue';
import Waveform from '@/components/call/Waveform.vue';
import Avatar from '@/components/common/Avatar.vue';
import Segmented from '@/components/common/Segmented.vue';
import PageHeader from '@/layouts/PageHeader.vue';
import { services } from '@/services';
import { useCharacterStore } from '@/stores/characters';

const chars = useCharacterStore();
const autoRead = ref<'off' | 'stage' | 'always'>('stage');
const vad = ref(55);
const bargeIn = ref(true);
const nativeFallback = ref(true);
const playing = ref<string | null>(null);
const level = ref(0);

async function preview(id: string, text: string) {
  playing.value = id;
  await services.tts.speak(text, { onLevel: (l) => (level.value = l) });
  playing.value = null;
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
              <div class="text-[12.5px] text-ink-3 truncate">{{ c.voice.voiceLabel }} · 硅基流动 CosyVoice</div>
            </div>
            <van-button size="small" round :loading="playing === c.id" @click="preview(c.id, c.card.firstMes)">试听</van-button>
          </div>
          <Waveform v-if="playing === c.id" :level="level" class="mt-2" />
          <div class="flex items-center gap-3 mt-2.5">
            <span class="text-[12.5px] text-ink-3 w-14 num">语速 {{ c.voice.speed.toFixed(2) }}</span>
            <van-slider v-model="c.voice.speed" :min="0.5" :max="2" :step="0.05" class="flex-1" bar-height="3px" button-size="14px" />
          </div>
        </div>
      </div>
      <p class="note">支持 OpenAI 兼容 /audio/speech（硅基流动、各家中转）、MiniMax、Fish Audio、自建 GPT-SoVITS；安卓壳里可用系统 TTS 兜底。朗读前会去掉（动作描写）和表情符号，按文本缓存音频。</p>

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
  </div>
</template>

<style scoped>
.voice {
  padding: 12px 14px;
  border-radius: 16px;
  background: var(--surface);
  border: 1px solid var(--border);
}
</style>
