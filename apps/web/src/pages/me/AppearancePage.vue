<script setup lang="ts">
import { computed, ref } from 'vue';
import Avatar from '@/components/common/Avatar.vue';
import Segmented from '@/components/common/Segmented.vue';
import PageHeader from '@/layouts/PageHeader.vue';
import { useAppStore, type ThemeSetting } from '@/stores/app';
import { useCharacterStore } from '@/stores/characters';

const app = useAppStore();
const chars = useCharacterStore();
const theme = computed<ThemeSetting>({ get: () => app.themeSetting, set: (v) => app.setTheme(v) });
const fontScale = ref(100);
const defaultMode = ref<'im' | 'stage'>('im');
const reduceMotion = ref(false);
</script>

<template>
  <div class="page" data-page="appearance">
    <PageHeader title="外观" fallback="/me" />
    <div class="page-scroll pb-10">
      <div class="group-title">主题</div>
      <div class="px-4">
        <Segmented
          v-model="theme"
          :options="[
            { value: 'system', label: '跟随系统', icon: 'i-lucide-sun-moon' },
            { value: 'dark', label: '夜', icon: 'i-lucide-moon' },
            { value: 'light', label: '昼', icon: 'i-lucide-sun' },
          ]"
        />
        <div class="preview">
          <div class="bubble ai">今天也辛苦了。</div>
          <div class="bubble me">嗯，想你了</div>
        </div>
      </div>

      <div class="group-title">角色主题色</div>
      <div class="px-4 grid gap-2">
        <RouterLink v-for="c in chars.list" :key="c.id" :to="`/me/characters/${c.id}`" class="accent-row">
          <Avatar :character="c" :size="34" />
          <span class="flex-1">{{ c.name }}</span>
          <span class="swatch" :style="{ background: c.accent }" />
          <span class="i-lucide-chevron-right text-ink-3" />
        </RouterLink>
      </div>
      <p class="note">和谁聊天，界面的点缀色就跟着谁。</p>

      <div class="group-title">阅读</div>
      <van-cell-group inset>
        <van-cell :title="`字号 ${fontScale}%`">
          <template #label><van-slider v-model="fontScale" :min="85" :max="130" :step="5" class="!mt-3" bar-height="4px" button-size="16px" /></template>
        </van-cell>
        <van-cell title="聊天默认模式">
          <template #label>
            <Segmented
              v-model="defaultMode"
              class="mt-2"
              :options="[
                { value: 'im', label: '聊天气泡' },
                { value: 'stage', label: '剧场立绘' },
              ]"
            />
          </template>
        </van-cell>
        <van-cell title="减少动效" label="关掉呼吸、淡入淡出等动画" center>
          <template #right-icon><van-switch v-model="reduceMotion" size="22px" /></template>
        </van-cell>
      </van-cell-group>
    </div>
  </div>
</template>

<style scoped>
.preview {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 12px;
  padding: 14px;
  border-radius: 18px;
  background: var(--bg-2);
  border: 1px solid var(--border);
}
.bubble {
  max-width: 70%;
  padding: 8px 12px;
  border-radius: 16px;
  font-size: 14.5px;
}
.bubble.ai {
  align-self: flex-start;
  background: var(--bubble-ai);
  border: 1px solid var(--border);
}
.bubble.me {
  align-self: flex-end;
  background: var(--bubble-me);
  color: var(--on-bubble-me);
}
.accent-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 14px;
  background: var(--surface);
  border: 1px solid var(--border);
  color: inherit;
  text-decoration: none;
}
.swatch {
  width: 22px;
  height: 22px;
  border-radius: 50%;
}
</style>
