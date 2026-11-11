<script setup lang="ts">
import { computed, ref } from 'vue';
import { showToast } from 'vant';
import PageHeader from '@/layouts/PageHeader.vue';
import { useHubStore } from '@/stores/hub';

const cloud = useHubStore();
const state = computed(() => cloud);
const workerUrl = ref(cloud.config.url);
const password = ref('');
const working = ref(false);
const failure = ref('');
async function run(task: () => Promise<void>) {
  working.value = true; failure.value = '';
  try { await task(); } catch (e) { failure.value = e instanceof Error ? e.message : String(e); }
  finally { working.value = false; }
}
async function connect() {
  await cloud.connect(workerUrl.value.trim(), password.value);
  password.value = '';
  showToast('已连接自己的 Worker');
}
const time = (value: number | null | undefined) => value ? new Date(value).toLocaleString() : '尚未';
</script>

<template>
  <div class="page" data-page="sync">
    <PageHeader title="云端与同步" subtitle="关掉 App，也能收到消息" fallback="/me" />
    <div class="page-scroll pb-10">
      <div class="group-title">我的 Cloudflare Worker</div>
      <van-cell-group inset>
        <van-field v-model="workerUrl" label="Worker 地址" placeholder="https://你的域名" autocomplete="url" />
        <van-field v-model="password" label="登录密码" type="password" placeholder="部署时设置的密码" autocomplete="current-password" />
      </van-cell-group>
      <div class="px-4 mt-3">
        <van-button round block :loading="working" :disabled="!workerUrl || !password" @click="run(connect)">连接 Worker</van-button>
      </div>
      <p class="note">输入自己部署的 Worker 地址和密码。部署步骤见仓库 docs/CLOUDFLARE.md；国内网络可使用绑定的自定义域名。</p>
      <template v-if="state.connected">
        <van-cell-group inset>
          <van-cell title="云端主动消息" :value="state.config.active ? '已开启' : '未开启'" :label="state.config.url" />
          <van-cell title="上次云端检测" :value="time(state.status?.lastCronAt)" />
          <van-cell title="上次消息同步" :value="time(state.lastSyncAt)" />
        </van-cell-group>
        <div class="px-4 mt-3 grid gap-2">
          <van-button v-if="!state.config.active" type="primary" round block :loading="working" @click="run(() => state.enable())">启用云端主动消息</van-button>
          <van-button v-else round block :loading="working" @click="run(() => state.disable())">停止云端主动消息</van-button>
          <van-button round block :loading="state.syncing" @click="state.syncNow()">立即同步</van-button>
          <RouterLink class="text-accent-ink text-center py-2" to="/me/proactive">设置角色与通知通道 →</RouterLink>
        </div>
        <p class="note">启用后，角色卡、所选预设、世界书、最近 200 条聊天、作息，以及主动消息使用的 API 和 Key 会交给你自己的 Worker。Key 经独立接口加密保存，只写不读。设置改动后自动更新；关闭 App 后云端每 5 分钟继续检测、生成并保存消息。</p>
        <p class="note">这次同步用于主动消息上下文和收件箱；素材备份和完整设备间同步尚未接入。多个设备修改同一角色时会提示版本冲突，重新连接会采用这台设备的上下文。</p>
      </template>
      <p v-if="failure || state.error || state.status?.lastError" class="note text-danger" role="alert">{{ failure || state.error || state.status?.lastError }}</p>
    </div>
  </div>
</template>
