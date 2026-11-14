<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { showToast } from 'vant';
import PageHeader from '@/layouts/PageHeader.vue';
import { useHubStore } from '@/stores/hub';

const cloud = useHubStore();
const state = computed(() => cloud);
const workerUrl = ref(cloud.config.url);
const password = ref(cloud.savedPassword);
watch(() => cloud.savedPassword, (value) => { password.value = value; });
const changed = computed(() => workerUrl.value.trim() !== cloud.config.url || (!!password.value && password.value !== cloud.savedPassword));
const working = ref(false);
const failure = ref('');
async function run(task: () => Promise<void>) {
  working.value = true; failure.value = '';
  try { await task(); } catch (e) { failure.value = e instanceof Error ? e.message : String(e); }
  finally { working.value = false; }
}
async function connect() {
  await cloud.connect(workerUrl.value.trim(), password.value);
  workerUrl.value = cloud.config.url;
  showToast(cloud.error ? '已登录，同步尚未完成，请查看下方原因' : '已连接并同步');
}
async function disconnect() { await cloud.disconnect(); showToast('已断开连接'); }
const time = (value: number | null | undefined) => value ? new Date(value).toLocaleString() : '尚未';
</script>

<template>
  <div class="page" data-page="sync">
    <PageHeader title="云端与同步" subtitle="关掉 App，也能生成节律、收到消息" fallback="/me" />
    <div class="page-scroll pb-10">
      <div class="group-title">我的 Cloudflare Worker</div>
      <van-cell-group inset>
        <van-cell v-if="state.connected" :title="state.error ? '已登录 · 同步异常' : state.lastSyncAt ? '已登录 · 已同步' : '已登录 · 等待同步'" :value="state.syncing ? '同步中' : ''" label="登录信息已保存；设置是否生效以上次完整同步为准。" class="hub-connected" />
        <van-field v-model="workerUrl" label="Worker 地址" placeholder="https://你的域名" autocomplete="url" />
        <van-field v-model="password" label="登录密码" type="password" :placeholder="state.connected ? '••••••••••••' : '输入登录密码'" autocomplete="current-password" />
      </van-cell-group>
      <div class="px-4 mt-3 grid gap-2">
        <van-button v-if="state.connected" round block :loading="working" @click="run(disconnect)">断开连接</van-button>
        <van-button v-if="!state.connected || changed" type="primary" round block :loading="working" :disabled="!workerUrl || !password || state.syncing" @click="run(connect)">{{ state.connected ? '保存修改并重新连接' : '连接 Worker' }}</van-button>
      </div>
      <p v-if="state.connected" class="note">断开连接会停止这台设备的同步，云端仍继续运行。主动消息可用下方开关停止；每日节律可在连接时改为「固定」并同步后停止。</p>
      <p class="note">输入自己部署的 Worker 地址和密码。部署步骤见仓库 docs/CLOUDFLARE.md；国内网络可使用绑定的自定义域名。</p>
      <template v-if="state.connected">
        <van-cell-group inset>
          <van-cell title="云端主动消息" :value="state.config.active ? '已开启' : '未开启'" :label="state.config.url" />
          <van-cell title="云端每日节律" :value="!state.status ? '待检测' : !state.supportsRhythm ? '需要更新 Worker' : state.status.rhythmConfigured ? 'API 已接通' : '尚未配置'" label="每天变化的角色在凌晨 4 点生成，不受主动消息开关影响" is-link to="/me/rhythm" />
          <van-cell title="云端记忆整理" :value="!state.status ? '待检测' : !state.supportsMemory ? '需要更新 Worker' : state.status.memoryConfigured ? 'API 已接通' : '尚未配置'" label="每天凌晨 4 点合并重复的记忆、合并时间线、改时态、修改画像卡；用「记忆整理」的 API" is-link to="/memories?tab=book" />
          <van-cell title="云端朋友圈" :value="!state.status ? '待检测' : !state.supportsSocial ? '需要更新 Worker' : state.status.socialConfigured ? 'API 已接通' : '尚未配置'" label="她们每天在随机的时间发朋友圈（按节律和最近的聊天），不受主动消息开关影响；用「社媒 · 朋友圈」的 API" is-link to="/me?open=moments" />
          <van-cell title="上次云端检测" :value="time(state.status?.lastCronAt)" />
          <van-cell title="上次完整同步" :value="time(state.lastSyncAt)" />
        </van-cell-group>
        <div class="px-4 mt-3 grid gap-2">
          <van-button v-if="!state.config.active" type="primary" round block :loading="working" @click="run(() => state.enable())">启用云端主动消息</van-button>
          <van-button v-else round block :loading="working" @click="run(() => state.disable())">停止云端主动消息</van-button>
          <van-button round block :loading="state.syncing" @click="state.syncNow()">立即同步</van-button>
          <van-button round block :loading="working" :disabled="state.syncing" @click="run(() => state.resyncFromDevice())">用本机设置重新同步</van-button>
          <RouterLink class="text-accent-ink text-center py-2" to="/me/proactive">设置角色与通知通道 →</RouterLink>
        </div>
        <p class="note">启用后，角色卡、所选预设、世界书、最近 200 条聊天、作息，以及主动消息使用的 API 和 Key 会交给你自己的 Worker。Key 经独立接口加密保存，只写不读。设置改动后自动更新；关闭 App 后云端每 5 分钟继续检测、生成并保存消息。</p>
        <p class="note">每日节律在连接后自动同步角色设置、世界、模板、预设和节律 API，Key 加密保存。按「我的环境」里的时区在凌晨 4 点生成，失败会自动重试；打开 App 时同步结果。固定模式的角色不会调用节律 API。</p>
        <p class="note">同步包括主动消息上下文、收件箱和每日节律；素材备份和完整设备间同步尚未接入。多个设备修改同一角色时会提示版本冲突，点击「用本机设置重新同步」会读取云端最新版本，再采用这台设备的角色设置、时区和作息。</p>
      </template>
      <p v-if="failure || state.error || state.status?.lastError || state.status?.lastRhythmError || state.status?.lastMemoryError || state.status?.lastSocialError" class="note text-danger whitespace-pre-line" role="alert">{{ [failure, state.error, state.status?.lastError, state.status?.lastRhythmError, state.status?.lastMemoryError, state.status?.lastSocialError].filter(Boolean).join('\n') }}</p>
    </div>
  </div>
</template>
