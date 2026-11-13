<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { showToast } from 'vant';
import { useRoute } from 'vue-router';
import ErrorDetails from '@/components/common/ErrorDetails.vue';
import PageHeader from '@/layouts/PageHeader.vue';
import { services } from '@/services';
import { pingNetease } from '@/services/music';
import { searchNearby } from '@/services/maps';
import { fetchWeather, geocodeCity } from '@/services/weather';
import { useRealWorldStore } from '@/stores/realworld';
import { NETEASE_QUALITIES, normalizeBase, SECRET_IDS, useServicesStore } from '@/stores/services';
import { useWeatherStore } from '@/stores/weather';

/**
 * 我的 → 地图、天气、音乐：一起听歌的网易云 Worker、你的真实世界用的 Google 地图、国内天气用的和风天气。
 * Key 和 Cookie 只存在这台设备（secrets 表），请求从浏览器直接发给服务商 / 你自己的 Worker。
 */
const svc = useServicesStore();
const real = useRealWorldStore();
const weather = useWeatherStore();
const route = useRoute();

interface TestResult {
  ok: boolean;
  text: string;
  detail?: string;
}
function failed(e: unknown): TestResult {
  const msg = e instanceof Error ? e.message : String(e);
  const detail = (e as { detail?: string }).detail;
  return { ok: false, text: msg, ...(detail ? { detail } : {}) };
}

// —— 网易云 ——
const workerDraft = ref(svc.netease.workerUrl);
const cookieDraft = ref(svc.neteaseCookie);
const musicTest = ref<TestResult | null>(null);
const musicTesting = ref(false);
function saveMusic() {
  svc.netease.workerUrl = workerDraft.value.trim();
  svc.setSecret(SECRET_IDS.neteaseCookie, cookieDraft.value);
}
async function testMusic() {
  saveMusic();
  const base = normalizeBase(svc.netease.workerUrl);
  if (!base) return showToast('先填 Worker 地址');
  musicTesting.value = true;
  musicTest.value = null;
  try {
    const info = await pingNetease(base);
    const songs = await services.music.search('晴天 周杰伦', 3);
    musicTest.value = {
      ok: true,
      text: `连上了（${[info.name, info.version].filter(Boolean).join(' ') || 'Worker'}）· 搜"晴天"得到 ${songs.length} 首${songs[0] ? `：${songs[0].title} - ${songs[0].artist}` : ''}`,
    };
  } catch (e) {
    musicTest.value = failed(e);
  } finally {
    musicTesting.value = false;
  }
}

// —— Google 地图 ——
const mapsDraft = ref(svc.mapsKey);
const mapsTest = ref<TestResult | null>(null);
const mapsTesting = ref(false);
async function testMaps() {
  svc.setSecret(SECRET_IDS.googleMaps, mapsDraft.value);
  if (!svc.mapsKey) return showToast('先填 Key');
  mapsTesting.value = true;
  mapsTest.value = null;
  const lines: string[] = [];
  try {
    const addr = real.address.trim() || '1600 Amphitheatre Parkway, Mountain View, CA';
    const g = await services.maps.geocode(addr);
    if (!g) throw new Error(`Geocoding 找不到"${addr}"`);
    lines.push(`Geocoding ✓ ${real.address.trim() ? '家' : '测试地址'} → ${g.lat.toFixed(4)}, ${g.lng.toFixed(4)}`);
    const near = await searchNearby(g, ['cafe'], svc.mapsKey, { force: true });
    lines.push(`Places API (New) ✓ 附近的咖啡店 ${near.length} 家${near[0] ? `（最近：${near[0].name}）` : ''}`);
    mapsTest.value = { ok: true, text: lines.join('\n') };
    if (real.address.trim()) void real.geocodeHome(true).then(() => real.refreshNearby(true));
  } catch (e) {
    const r = failed(e);
    mapsTest.value = { ...r, text: [...lines, r.text].join('\n') };
  } finally {
    mapsTesting.value = false;
  }
}
function saveMapsKey() {
  if (mapsDraft.value.trim() === svc.mapsKey) return;
  svc.setSecret(SECRET_IDS.googleMaps, mapsDraft.value);
}

// —— 和风天气 ——
const qwHostDraft = ref(svc.weather.qweatherHost);
const qwKeyDraft = ref(svc.qweatherKey);
const qwTest = ref<TestResult | null>(null);
const qwTesting = ref(false);
function saveQw() {
  svc.weather.qweatherHost = qwHostDraft.value.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  qwHostDraft.value = svc.weather.qweatherHost;
  svc.setSecret(SECRET_IDS.qweather, qwKeyDraft.value);
}
async function testQw() {
  saveQw();
  if (!svc.qweatherReady) return showToast('API Host 和 Key 都要填');
  qwTesting.value = true;
  qwTest.value = null;
  try {
    const place = await geocodeCity('上海');
    if (!place) throw new Error('找不到上海（地理编码出错了）');
    const r = await fetchWeather({ ...place, countryCode: 'CN' }, 'qweather');
    qwTest.value = { ok: true, text: `和风天气 ✓ 上海 ${r.text} ${weather.temp(r.tempC)}${r.today ? `，今天 ${weather.temp(r.today.minC)}~${weather.temp(r.today.maxC)}` : ''}` };
    void weather.refresh(true);
  } catch (e) {
    qwTest.value = failed(e);
  } finally {
    qwTesting.value = false;
  }
}

// —— Open-Meteo（免 Key）——
const omTest = ref<TestResult | null>(null);
const omTesting = ref(false);
async function testOm() {
  omTesting.value = true;
  omTest.value = null;
  try {
    const place = await geocodeCity('San Francisco');
    if (!place) throw new Error('Open-Meteo 地理编码没找到旧金山');
    const r = await fetchWeather(place, 'open-meteo');
    omTest.value = { ok: true, text: `Open-Meteo ✓ ${r.place} ${r.text} ${weather.temp(r.tempC)}${r.alert ? `（预警：${r.alert}）` : ''}` };
  } catch (e) {
    omTest.value = failed(e);
  } finally {
    omTesting.value = false;
  }
}

// 从别处带着 #music / #maps / #weather 进来时滚到那一块
onMounted(() => {
  const id = route.hash.slice(1);
  if (['music', 'maps', 'weather'].includes(id)) setTimeout(() => document.getElementById(id)?.scrollIntoView({ block: 'start' }), 200);
});
const musicState = computed(() => (svc.musicReady ? '已填 Worker 地址' : '没填：一起听歌是示例歌曲'));
const mapsState = computed(() => (svc.mapsReady ? '已填 Key' : '没填：示意图'));
const quality = computed({
  get: () => svc.netease.quality,
  set: (v) => (svc.netease.quality = v),
});
</script>

<template>
  <div class="page" data-page="services">
    <PageHeader title="地图、天气、音乐" subtitle="网易云音乐 · Google 地图 · 天气" fallback="/me" />
    <div class="page-scroll pb-10">
      <!-- 网易云音乐 -->
      <div id="music" class="group-title"><span class="i-lucide-music-2" />网易云音乐（一起听歌）<span class="ml-auto text-[12px]">{{ musicState }}</span></div>
      <van-cell-group inset>
        <van-field
          v-model="workerDraft"
          label="Worker 地址"
          placeholder="https://xxx.workers.dev"
          autocomplete="off"
          inputmode="url"
          data-testid="netease-worker"
          @blur="saveMusic"
        />
        <van-field
          v-model="cookieDraft"
          label="黑胶 Cookie"
          type="textarea"
          rows="2"
          autosize
          placeholder="可选：MUSIC_U=…（填了能放无损、会员歌）"
          autocomplete="off"
          @blur="saveMusic"
        />
        <van-cell title="音质">
          <template #right-icon>
            <select v-model="quality" class="sel" aria-label="音质">
              <option v-for="q in NETEASE_QUALITIES" :key="q.value" :value="q.value">{{ q.label }}</option>
            </select>
          </template>
        </van-cell>
      </van-cell-group>
      <div class="px-4 mt-3">
        <van-button round block :loading="musicTesting" data-testid="netease-test" @click="testMusic">测试连接</van-button>
        <div v-if="musicTest?.ok" class="ok-line">{{ musicTest.text }}</div>
        <ErrorDetails v-else-if="musicTest" class="mt-2" :detail="[musicTest.text, musicTest.detail].filter(Boolean).join('\n')" :title="musicTest.text" max-height="160px" />
      </div>
      <p class="note">
        和 SleepTogether 一样，对接你自己部署的 <b>Netease_url</b> Cloudflare Worker（浏览器不能直接请求网易云）：已经给 SleepTogether 部署过的，填同一个地址就行。
        Cookie 只存在这台设备，随请求发给你自己的 Worker。在国外时有的歌因为版权拿不到播放地址，会提示并跳过；填黑胶 Cookie 能好一些。
      </p>

      <!-- Google 地图 -->
      <div id="maps" class="group-title"><span class="i-lucide-map" />Google 地图（我的世界）<span class="ml-auto text-[12px]">{{ mapsState }}</span></div>
      <van-cell-group inset>
        <van-field v-model="mapsDraft" label="API Key" type="password" placeholder="AIza…" autocomplete="off" data-testid="maps-key" @blur="saveMapsKey" />
      </van-cell-group>
      <div class="px-4 mt-3">
        <van-button round block :loading="mapsTesting" data-testid="maps-test" @click="testMaps">测试（地理编码 + 附近搜索）</van-button>
        <div v-if="mapsTest?.ok" class="ok-line">{{ mapsTest.text }}</div>
        <ErrorDetails v-else-if="mapsTest" class="mt-2" :detail="[mapsTest.text, mapsTest.detail].filter(Boolean).join('\n')" :title="mapsTest.text.split('\n').at(-1)" max-height="180px" />
      </div>
      <div class="note leading-relaxed">
        在 Google Cloud 控制台建一个 API Key，给它开通这三个 API：<b>Maps JavaScript API</b>（画地图）、<b>Geocoding API</b>（家的地址换成坐标）、<b>Places API (New)</b>（附近的地方；排健康计划时也用它找附近能吃饭的地方和超市）。
        记得在 Key 的"应用限制"里选"网站"，只允许这个 App 的地址（例如 <code>https://none0enon.github.io/*</code>），"API 限制"里只勾这三个。
        每月有免费额度：附近搜索结果缓存一天（健康计划找餐馆、超市也是一天最多各一次）、家的地址只查一次，自己用基本不花钱。换了 Key 以后刷新一下页面，地图才会用新的 Key。
      </div>

      <!-- 天气 -->
      <div id="weather" class="group-title"><span class="i-lucide-cloud-sun" />天气</div>
      <van-cell-group inset>
        <van-cell title="Open-Meteo（你那边、国外的城市）" label="免 Key、全球都有；在美国用 NOAA 的高分辨率模型，还会取美国国家气象局（weather.gov）的天气预警" />
      </van-cell-group>
      <div class="px-4 mt-3">
        <van-button round block :loading="omTesting" @click="testOm">测试 Open-Meteo（旧金山）</van-button>
        <div v-if="omTest?.ok" class="ok-line">{{ omTest.text }}</div>
        <ErrorDetails v-else-if="omTest" class="mt-2" :detail="[omTest.text, omTest.detail].filter(Boolean).join('\n')" :title="omTest.text" max-height="160px" />
      </div>

      <van-cell-group inset class="!mt-3">
        <van-cell title="和风天气（国内的城市）" label="国内更准。住在国内的角色（角色设定里写了国内的城市）、你在国内时用它" />
        <van-field v-model="qwHostDraft" label="API Host" placeholder="abcxyz.re.qweatherapi.com" autocomplete="off" inputmode="url" data-testid="qweather-host" @blur="saveQw" />
        <van-field v-model="qwKeyDraft" label="API Key" type="password" placeholder="控制台 → 项目 → 凭据" autocomplete="off" data-testid="qweather-key" @blur="saveQw" />
      </van-cell-group>
      <div class="px-4 mt-3">
        <van-button round block :loading="qwTesting" @click="testQw">测试和风天气（上海）</van-button>
        <div v-if="qwTest?.ok" class="ok-line">{{ qwTest.text }}</div>
        <ErrorDetails v-else-if="qwTest" class="mt-2" :detail="[qwTest.text, qwTest.detail].filter(Boolean).join('\n')" :title="qwTest.text" max-height="160px" />
      </div>
      <p class="note">
        API Host 在和风天气控制台的"设置"里（每个账号一个，形如 xxx.qweatherapi.com；以前的 devapi.qweather.com 已经不能用了），Key 在"项目管理 → 凭据"里建，选"API KEY"。
        没填时国内的城市也能查（用 Open-Meteo），只是不如和风准。
      </p>
      <p class="note">你在哪座城市、她们住在哪，在 <RouterLink to="/me/environment" class="text-accent-ink">环境与作息</RouterLink> 和角色设定里设。</p>
    </div>
  </div>
</template>

<style scoped>
.ok-line {
  margin-top: 8px;
  padding: 8px 12px;
  border-radius: 12px;
  background: var(--panel);
  color: var(--good);
  font-size: 12.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
.sel {
  height: 30px;
  padding: 0 8px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--ink);
}
code {
  font-size: 11.5px;
  word-break: break-all;
}
</style>
