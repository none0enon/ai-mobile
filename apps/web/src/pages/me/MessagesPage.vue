<script setup lang="ts">
import PageHeader from '@/layouts/PageHeader.vue';
import { MESSAGE_RANGES, useMessageSettingsStore } from '@/stores/messageSettings';

/**
 * 我的 → 消息设置（stores/messageSettings.ts）：发送给 AI 的条数、显示条数、HTML 渲染。
 * 改动即时保存在本机；发送设置从下一次调用起生效，显示设置立即生效。
 */
const s = useMessageSettingsStore().settings;
const R = MESSAGE_RANGES;
</script>

<template>
  <div class="page" data-page="messages">
    <PageHeader title="消息设置" fallback="/me" />
    <div class="page-scroll pb-10">
      <div class="group-title">发送给 AI</div>
      <van-cell-group inset>
        <van-cell title="限制条数" center>
          <template #right-icon><van-switch v-model="s.sendLimit" size="22px" class="shrink-0" aria-label="限制发送条数" data-testid="send-limit" /></template>
        </van-cell>
        <van-cell title="最近消息数" center :class="{ dim: !s.sendLimit }">
          <template #right-icon>
            <van-stepper v-model="s.sendLast" :min="R.sendLast.min" :max="R.sendLast.max" :disabled="!s.sendLimit" integer input-width="44px" class="shrink-0" data-testid="send-last" />
          </template>
        </van-cell>
      </van-cell-group>
      <p class="note">范围 {{ R.sendLast.min }}–{{ R.sendLast.max }}，0 表示不发送聊天记录。截取后仍受预设上下文长度限制。</p>

      <div class="group-title">显示</div>
      <van-cell-group inset>
        <van-cell title="限制条数" center>
          <template #right-icon><van-switch v-model="s.showLimit" size="22px" class="shrink-0" aria-label="限制显示条数" data-testid="show-limit" /></template>
        </van-cell>
        <van-cell title="最近消息数" center :class="{ dim: !s.showLimit }">
          <template #right-icon>
            <van-stepper v-model="s.showLast" :min="R.showLast.min" :max="R.showLast.max" :disabled="!s.showLimit" integer input-width="44px" class="shrink-0" data-testid="show-last" />
          </template>
        </van-cell>
      </van-cell-group>
      <p class="note">范围 {{ R.showLast.min }}–{{ R.showLast.max }}。更早的消息可在聊天顶部展开。</p>

      <div class="group-title">HTML 渲染</div>
      <van-cell-group inset>
        <van-cell title="渲染 HTML" center>
          <template #right-icon><van-switch v-model="s.html" size="22px" class="shrink-0" aria-label="渲染 HTML" data-testid="html-on" /></template>
        </van-cell>
        <van-cell title="前端页面渲染条数" center :class="{ dim: !s.html }">
          <template #right-icon>
            <van-stepper v-model="s.frameLast" :min="R.frameLast.min" :max="R.frameLast.max" :disabled="!s.html" integer input-width="44px" class="shrink-0" data-testid="frame-last" />
          </template>
        </van-cell>
      </van-cell-group>
      <p class="note">范围 {{ R.frameLast.min }}–{{ R.frameLast.max }}。代码块中的完整 HTML 页面仅在最近的消息中渲染，运行于沙盒，无法访问应用数据。</p>
    </div>
  </div>
</template>

<style scoped>
.dim :deep(.van-cell__title) {
  color: var(--ink-3);
}
</style>
