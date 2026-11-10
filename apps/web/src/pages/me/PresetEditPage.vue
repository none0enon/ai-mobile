<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import Segmented from '@/components/common/Segmented.vue';
import PageHeader from '@/layouts/PageHeader.vue';
import { useLibraryStore } from '@/stores/library';

const route = useRoute();
const lib = useLibraryStore();
const preset = computed(() => lib.presetById(route.params.id as string) ?? lib.presets[0]!);
const tab = ref<'order' | 'sampler' | 'regex'>('order');
const ROLE: Record<string, string> = { system: '系统', user: '用户', assistant: '助手' };
</script>

<template>
  <div class="page" data-page="preset-edit">
    <PageHeader :title="preset.name" subtitle="拖动调整顺序（M1）· 开关控制是否发送" fallback="/me/presets" />
    <div class="page-scroll pb-10">
      <Segmented
        v-model="tab"
        sticky
        :options="[
          { value: 'order', label: '提示词顺序' },
          { value: 'sampler', label: '采样参数' },
          { value: 'regex', label: '正则' },
        ]"
      />

      <div v-if="tab === 'order'" class="px-4 grid gap-1.5">
        <div v-for="b in preset.blocks" :key="b.identifier" class="block" :class="{ off: !b.enabled }">
          <span class="i-lucide-grip-vertical text-ink-3" />
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-1.5">
              <span class="text-[14px] truncate" :class="{ 'font-600': !b.marker }">{{ b.name }}</span>
              <span class="tag">{{ ROLE[b.role] }}</span>
              <span v-if="b.marker" class="tag accent">程序填充</span>
            </div>
            <div class="text-[11.5px] text-ink-3 truncate">
              {{ b.injection.position === 'absolute' ? `插在聊天记录倒数第 ${b.injection.depth} 条前` : b.marker ? '按顺序' : b.content }}
            </div>
          </div>
          <van-switch v-model="b.enabled" size="20px" />
        </div>
        <p class="text-[12px] text-ink-3 mt-1 mb-0 leading-relaxed">
          "程序填充"的块由 App 生成：角色卡字段、命中的世界书、记忆、【当前环境】、场景规则、聊天记录。导入 ST 预设时，这几块会自动插进它的顺序里。
        </p>
      </div>

      <van-cell-group v-else-if="tab === 'sampler'" inset>
        <van-cell :title="`温度 ${preset.sampler.temperature.toFixed(2)}`" label="越高越随性；0 也能发（math-reader 的 bug 修掉了）">
          <template #label><van-slider v-model="preset.sampler.temperature" :min="0" :max="2" :step="0.05" class="!mt-3" bar-height="4px" button-size="16px" /></template>
        </van-cell>
        <van-cell :title="`Top P ${preset.sampler.topP.toFixed(2)}`">
          <template #label><van-slider v-model="preset.sampler.topP" :min="0" :max="1" :step="0.01" class="!mt-3" bar-height="4px" button-size="16px" /></template>
        </van-cell>
        <van-cell title="回复最长（token）" center>
          <template #right-icon><van-stepper v-model="preset.sampler.maxTokens" min="64" max="8000" step="64" /></template>
        </van-cell>
        <van-cell title="上下文预算（token）" center>
          <template #right-icon><van-stepper v-model="preset.sampler.contextTokens" min="2000" max="200000" step="2000" /></template>
        </van-cell>
        <van-cell :title="`频率惩罚 ${preset.sampler.frequencyPenalty.toFixed(1)}`">
          <template #label><van-slider v-model="preset.sampler.frequencyPenalty" :min="-2" :max="2" :step="0.1" class="!mt-3" bar-height="4px" button-size="16px" /></template>
        </van-cell>
        <van-cell title="流式输出" center>
          <template #right-icon><van-switch v-model="preset.sampler.stream" size="22px" /></template>
        </van-cell>
      </van-cell-group>

      <div v-else class="px-4 grid gap-2">
        <div v-for="r in preset.regex" :key="r.id" class="block">
          <span class="i-lucide-regex text-accent-ink" />
          <div class="flex-1 min-w-0">
            <div class="text-[14px]">{{ r.name }}</div>
            <div class="text-[11.5px] text-ink-3 font-mono truncate">/{{ r.find }}/ → "{{ r.replace }}"</div>
          </div>
          <van-switch v-model="r.enabled" size="20px" />
        </div>
        <p v-if="!preset.regex.length" class="text-[13px] text-ink-3 text-center py-6">这个预设没有正则脚本</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.block {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 14px;
  background: var(--surface);
  border: 1px solid var(--border);
}
.block.off {
  opacity: 0.55;
}
</style>
