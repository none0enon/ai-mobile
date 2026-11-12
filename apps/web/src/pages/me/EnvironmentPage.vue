<script setup lang="ts">
import { formatEnvironmentBlock, WEATHER_PROVIDER_LABEL, type WeatherProviderChoice } from '@app/shared';
import { computed, ref, watch } from 'vue';
import { showToast } from 'vant';
import Avatar from '@/components/common/Avatar.vue';
import ErrorDetails from '@/components/common/ErrorDetails.vue';
import Segmented from '@/components/common/Segmented.vue';
import PageHeader from '@/layouts/PageHeader.vue';
import { mockToday, todayLine } from '@/mock/activity';
import { useCharacterStore } from '@/stores/characters';
import { deviceTimezone, useEnvironmentStore } from '@/stores/environment';
import { useRealWorldStore } from '@/stores/realworld';
import { useServicesStore } from '@/stores/services';
import { useWeatherStore } from '@/stores/weather';
import { listTime } from '@/utils/time';

/** 环境与作息：时间 / 节气 / 天气 / 今日活动，拼成【当前环境】注入每一轮对话 */
const env = useEnvironmentStore().settings;
const weather = useWeatherStore();
const svc = useServicesStore();
const chars = useCharacterStore();
const inject = ref({ time: true, weather: true, calendar: true, activity: true });
const preview = computed(() => chars.list[0]);
const block = computed(() => {
  const w = weather.envInput(preview.value);
  return formatEnvironmentBlock({
    now: new Date(),
    weather: inject.value.weather ? w.weather : null,
    herWeather: inject.value.weather ? w.herWeather : null,
    todayLine: inject.value.activity ? todayLine(mockToday()) : undefined,
    sinceLastChatMin: 3,
  });
});
const MEAL = { breakfast: '早饭', lunch: '午饭', dinner: '晚饭' } as const;

/** 你的真实世界：家的地址只存在这台设备（离开输入框时保存） */
const real = useRealWorldStore();
const homeDraft = ref(real.address);
watch(
  () => real.address,
  (a) => (homeDraft.value = a),
);
const settingHome = ref(false);
async function homeHere() {
  settingHome.value = true;
  try {
    await real.setHomeHere();
    showToast(svc.mapsReady ? '把现在的位置当作家了' : '把现在的位置当作家了（填了 Google 地图的 Key 才查得出地址）');
  } catch (e) {
    showToast(e instanceof Error ? e.message : String(e));
  } finally {
    settingHome.value = false;
  }
}

/** 天气 */
const me = computed(() => weather.mineEntry);
const cityDraft = ref(env.city);
watch(
  () => env.city,
  (c) => (cityDraft.value = c),
);
function saveCity() {
  const v = cityDraft.value.trim();
  if (v !== env.city) env.city = v;
}
const PROVIDERS: { value: WeatherProviderChoice; label: string }[] = [
  { value: 'auto', label: '自动' },
  { value: 'open-meteo', label: 'Open-Meteo' },
  { value: 'qweather', label: '和风天气' },
];
const unit = computed({
  get: () => env.tempUnit ?? 'c',
  set: (v: 'c' | 'f') => (env.tempUnit = v),
});
const sourceText = computed(() => {
  const s = me.value.source;
  if (s === '定位') return '按定位';
  if (s === '家的地址') return '按家的地址';
  return s ? `按城市"${s}"` : '';
});

/** 时区：和这台设备的不一样时提醒（主动消息按这里的时区排） */
const deviceZone = deviceTimezone();
const zoneDiffers = computed(() => !!env.timezone && env.timezone !== deviceZone);
</script>

<template>
  <div class="page" data-page="environment">
    <PageHeader title="环境与作息" subtitle="她知道现在几点、下不下雨、你吃没吃饭" fallback="/me" />
    <div class="page-scroll pb-10">
      <div class="group-title">每轮对话会带上</div>
      <div class="px-4">
        <div class="block-preview" data-testid="env-block">{{ block }}</div>
        <div class="flex flex-wrap gap-2 mt-2.5">
          <label v-for="(label, k) in { time: '时间', calendar: '节气 / 节假日', weather: '天气', activity: '今日活动' }" :key="k" class="toggle">
            <van-checkbox v-model="inject[k]" icon-size="16px" />{{ label }}
          </label>
        </div>
      </div>

      <div class="group-title">
        天气
        <button class="action" :disabled="me.loading" @click="weather.refresh(true)">{{ me.loading ? '正在取…' : '刷新' }}</button>
      </div>
      <div class="px-4">
        <div class="wx-card" data-testid="my-weather">
          <span :class="weather.mine?.icon ?? 'i-lucide-cloud-off'" class="wx-icon" />
          <div class="flex-1 min-w-0">
            <template v-if="weather.mine">
              <div class="text-[16px] font-600 truncate">你那边 · {{ weather.mine.place }} {{ weather.mine.text }} {{ weather.temp(weather.mine.tempC) }}</div>
              <div class="text-[12.5px] text-ink-2 mt-0.5">{{ weather.outlook(weather.mine) || '—' }}</div>
              <div v-if="weather.mine.alert" class="text-[12.5px] text-warn mt-0.5"><span class="i-lucide-triangle-alert" /> {{ weather.mine.alert }}</div>
              <div class="text-[11.5px] text-ink-3 mt-1">
                {{ WEATHER_PROVIDER_LABEL[weather.mine.provider] }} · {{ sourceText }} · {{ listTime(weather.mine.fetchedAt) }}更新
                <template v-if="weather.mine.feelsC != null"> · 体感 {{ weather.temp(weather.mine.feelsC) }}</template>
                <template v-if="weather.mine.humidity != null"> · 湿度 {{ Math.round(weather.mine.humidity) }}%</template>
              </div>
            </template>
            <template v-else>
              <div class="text-[15px] font-600">{{ me.loading ? '正在取天气…' : '还没有你那边的天气' }}</div>
              <div class="text-[12.5px] text-ink-3 mt-0.5">{{ me.error || '在下面填你在的城市，或者打开定位' }}</div>
            </template>
          </div>
        </div>
        <ErrorDetails v-if="me.error && me.detail" class="mt-2" :detail="`${me.error}\n${me.detail}`" :title="me.error" max-height="160px" />
      </div>
      <van-cell-group inset class="!mt-3">
        <van-field v-model="cityDraft" label="你在的城市" placeholder="例如 旧金山 / San Francisco / 上海" input-align="right" enterkeyhint="done" @blur="saveCity" @keydown.enter="saveCity" />
        <van-cell title="天气来源">
          <template #label>
            <Segmented v-model="env.weatherProvider" class="mt-2" :options="PROVIDERS" />
            <div class="mt-1.5 leading-relaxed">
              自动：在国内用和风天气（要在"地图、天气、音乐"里填 Key 和 API Host），其他地方用 Open-Meteo。<br />
              Open-Meteo 免 Key、全球都有，在美国用的是 NOAA 的高分辨率模型，还会顺便取美国国家气象局的天气预警。
            </div>
          </template>
        </van-cell>
        <van-cell title="温度单位" center>
          <template #right-icon>
            <div class="w-[132px] shrink-0">
              <Segmented
                v-model="unit"
                :options="[
                  { value: 'c', label: '°C' },
                  { value: 'f', label: '°F' },
                ]"
              />
            </div>
          </template>
        </van-cell>
        <van-cell title="和风天气" :value="svc.qweatherReady ? '已填 Key' : '没填（国内的城市也能用 Open-Meteo）'" is-link to="/me/services" />
      </van-cell-group>
      <p class="note">查天气按这个顺序：打开了定位就按你此刻的位置，否则按家的地址（要 Google 地图的 Key），再否则按这里的城市。半小时更新一次；取不到时不写天气，不编。</p>

      <div class="group-title">她们那边的天气</div>
      <van-cell-group inset>
        <van-cell v-for="c in chars.list" :key="c.id" :to="`/me/characters/${c.id}#weather`" is-link center>
          <template #icon><Avatar :character="c" :size="28" class="mr-2.5" /></template>
          <template #title>
            <span class="text-[14.5px]">{{ c.name }}</span>
          </template>
          <template #label>
            <template v-if="weather.hasOwnCity(c)">
              住在{{ c.weather?.city }}<template v-if="weather.forCharacter(c)"> · {{ weather.forCharacter(c)!.text }} {{ weather.temp(weather.forCharacter(c)!.tempC) }} · {{ WEATHER_PROVIDER_LABEL[weather.forCharacter(c)!.provider] }}</template>
              <template v-else-if="weather.entryFor(c).error"> · {{ weather.entryFor(c).error }}</template>
            </template>
            <template v-else>和你在同一个地方（用你那边的天气）</template>
          </template>
        </van-cell>
      </van-cell-group>
      <p class="note">住在国内的角色，在角色设定 → 基本 → "住在哪座城市"里写城市（例如上海），就用中国的天气（填了和风天气时用和风）。她的作息还是和你用同一个时间。</p>

      <div class="group-title">你的真实世界</div>
      <van-cell-group inset>
        <van-field v-model="homeDraft" label="家的地址" placeholder="门牌号 + 街道 + 城市，例如 1 Main St, San Jose" input-align="right" @blur="real.setAddress(homeDraft)" @keydown.enter="real.setAddress(homeDraft)" />
        <van-cell title="家在地图上" :label="real.geocoding ? '正在用 Google 地图找这个地址…' : real.homeGeo ? real.homeGeo.formatted || '已经换成坐标了' : real.geocodeError || (svc.mapsReady ? '填好地址后自动换成坐标' : '填了 Google 地图的 Key 才能把地址换成坐标')">
          <template #right-icon>
            <van-button size="small" round :loading="settingHome" @click="homeHere">用现在的位置</van-button>
          </template>
        </van-cell>
        <van-cell title="地图" :label="real.mapsReady ? 'Google 地图已接入：我的世界画真地图，附近的地方来自 Google' : '还没接入 Google 地图，现在是示意图和演示地点'" is-link to="/me/services" />
        <van-cell title="用定位" center>
          <template #label>
            <span>只在打开 App 时看一眼：你在不在家、离家多远、天气按你此刻的位置（不在后台定位）</span>
            <span v-if="env.useLocation" class="block mt-1" :class="real.hereError ? 'text-bad' : 'text-ink-2'">
              {{ real.locating ? '正在定位…' : real.hereError || (real.here ? `${real.whereLine}${real.here.accuracy ? `（误差约 ${Math.round(real.here.accuracy)} 米）` : ''}` : '') }}
            </span>
          </template>
          <template #right-icon><van-switch v-model="env.useLocation" size="22px" /></template>
        </van-cell>
        <van-cell v-if="env.useLocation" title="重新定位" is-link @click="real.locateNow()" />
      </van-cell-group>
      <p class="note">家的地址只存在这台设备，用来在地图上标出你家、找附近的地方，不会发给对话模型；她只知道你在不在家、出门了多远。打开地图时坐标会发给 Google（用 Google 地图绕不开）。</p>

      <div class="group-title">时区</div>
      <van-cell-group inset>
        <van-field v-model="env.timezone" label="时区" placeholder="America/Los_Angeles" input-align="right" />
        <van-cell v-if="zoneDiffers" title="这台设备的时区不一样" :label="`设备是 ${deviceZone}；主动消息按上面填的时区排`">
          <template #right-icon>
            <van-button size="small" round type="primary" @click="env.timezone = deviceZone">用 {{ deviceZone }}</van-button>
          </template>
        </van-cell>
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
.wx-card {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 14px;
  border-radius: 18px;
  background: var(--surface);
  border: 1px solid var(--border);
}
.wx-icon {
  font-size: 30px;
  color: var(--accent-ink);
  margin-top: 2px;
}
</style>
