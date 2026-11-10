<script setup lang="ts">
import { formatEnvironmentBlock } from '@app/shared';
import { computed, ref } from 'vue';
import Segmented from '@/components/common/Segmented.vue';
import PageHeader from '@/layouts/PageHeader.vue';
import { mockToday, todayLine, weather } from '@/mock/activity';
import { envSettings } from '@/mock/settings';

/** 环境与作息：时间 / 节气 / 天气 / 今日活动，拼成【当前环境】注入每一轮对话 */
const env = ref({ ...envSettings, meals: { ...envSettings.meals } });
const inject = ref({ time: true, weather: true, calendar: true, activity: true });
const block = computed(() =>
  formatEnvironmentBlock({
    now: new Date(),
    weather: inject.value.weather ? { ...weather, city: env.value.city } : null,
    todayLine: inject.value.activity ? todayLine(mockToday()) : undefined,
    sinceLastChatMin: 3,
  }),
);
const MEAL = { breakfast: '早饭', lunch: '午饭', dinner: '晚饭' } as const;
</script>

<template>
  <div class="page" data-page="environment">
    <PageHeader title="环境与作息" subtitle="她知道现在几点、下不下雨、你吃没吃饭" fallback="/me" />
    <div class="page-scroll pb-10">
      <div class="group-title">每轮对话会带上</div>
      <div class="px-4">
        <div class="block-preview">{{ block }}</div>
        <div class="flex flex-wrap gap-2 mt-2.5">
          <label v-for="(label, k) in { time: '时间', calendar: '节气 / 节假日', weather: '天气', activity: '今日活动' }" :key="k" class="toggle">
            <van-checkbox v-model="inject[k]" icon-size="16px" />{{ label }}
          </label>
        </div>
      </div>

      <div class="group-title">位置与天气</div>
      <van-cell-group inset>
        <van-field v-model="env.city" label="城市" placeholder="例如：上海" input-align="right" />
        <van-cell title="用定位" label="只在打开 App 时取一次" center>
          <template #right-icon><van-switch v-model="env.useLocation" size="22px" /></template>
        </van-cell>
        <van-cell title="天气来源">
          <template #label>
            <Segmented
              v-model="env.weatherProvider"
              class="mt-2"
              :options="[
                { value: 'qweather', label: '和风天气' },
                { value: 'open-meteo', label: 'Open-Meteo' },
              ]"
            />
            <div class="mt-1.5">和风天气国内更准（需要 key，由 Worker 代取并缓存）；Open-Meteo 免 key</div>
          </template>
        </van-cell>
        <van-cell title="时区" :value="env.timezone" />
      </van-cell-group>

      <div class="group-title">作息</div>
      <van-cell-group inset>
        <van-field v-model="env.wakeTime" label="起床" input-align="right" />
        <van-field v-model="env.sleepTime" label="睡觉" input-align="right" />
      </van-cell-group>
      <p class="note">起床时间到了，她会打电话叫醒你；过了睡觉时间还在玩手机，她会来催。</p>

      <div class="group-title">三餐时间</div>
      <van-cell-group inset>
        <van-cell v-for="(label, k) in MEAL" :key="k" :title="label" :value="`${env.meals[k].start} - ${env.meals[k].end}`" is-link />
      </van-cell-group>
      <p class="note">时间段内还没记录吃饭，她先暗示；过了时间再正式邀约。</p>

      <div class="group-title">今日活动从哪来</div>
      <van-cell-group inset>
        <van-cell title="安卓：计步 / Health Connect" label="安卓壳的原生桥读取" />
        <van-cell title="iPhone：快捷指令" label="把健康数据定时推给你的 Worker（M6 提供快捷指令模板）" />
        <van-cell title="运动截图识别" label="视觉模型读出距离和时长" />
        <van-cell title="App 内记录" label="一起运动 / 吃饭 / 学习 / 哄睡 场景自动记下" />
      </van-cell-group>
    </div>
  </div>
</template>

<style scoped>
.block-preview {
  padding: 12px 14px;
  border-radius: 16px;
  background: var(--panel);
  border: 1px dashed var(--accent-line);
  font-size: 13.5px;
  line-height: 1.7;
  color: var(--ink-2);
}
.toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 10px;
  border-radius: 99px;
  background: var(--panel);
  font-size: 12.5px;
}
</style>
