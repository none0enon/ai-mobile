<script setup lang="ts">
import { ref } from 'vue';
import { showToast } from 'vant';
import Segmented from '@/components/common/Segmented.vue';
import { useHubStore } from '@/stores/hub';
const hub = useHubStore();
const busy = ref(false);
const error = ref('');
const webhookUrl = ref('');
const preset = ref('bark');
const headers = ref('{}');
const body = ref('{"title":"{{title}}","body":"{{body}}","url":"{{url}}"}');
async function run(work: () => Promise<void>) {
  busy.value = true; error.value = '';
  try { await work(); showToast('已完成'); }
  catch (e) { error.value = e instanceof Error ? e.message : String(e); }
  finally { busy.value = false; }
}
async function add() {
  await hub.addWebhook({ url: webhookUrl.value.trim(), preset: preset.value, headers: JSON.parse(headers.value), ...(preset.value === 'custom' ? { body: JSON.parse(body.value) } : {}) });
  webhookUrl.value = ''; headers.value = '{}';
}
</script>
<template>
  <div class="group-title">通知通道</div>
  <p v-if="!hub.connected" class="note"><RouterLink to="/me/sync" class="text-accent-ink">先连接自己的 Cloudflare Worker →</RouterLink></p>
  <template v-else>
    <div class="px-4 grid gap-2">
      <van-button round block :loading="busy" @click="run(() => hub.subscribe())">开启这台设备的通知</van-button>
      <p class="text-[12px] text-ink-3">iPhone 请先添加到主屏幕，再从主屏幕打开并允许通知。</p>
    </div>
    <van-cell-group v-if="hub.status?.channels.length" inset class="!mt-3">
      <van-cell v-for="ch in hub.status.channels" :key="ch.id" :title="ch.label" :label="ch.lastOkAt ? `上次成功：${new Date(ch.lastOkAt).toLocaleString()}` : '尚未成功推送'">
        <template #value>
          <van-button size="mini" :disabled="busy" @click="run(() => hub.testChannel(ch.id))">测试</van-button>
          <van-button size="mini" class="!ml-2" :disabled="busy" @click="run(() => hub.removeChannel(ch.id))">删除</van-button>
        </template>
      </van-cell>
    </van-cell-group>
    <p v-else class="note">还没有通知通道。消息会保存在云端，开启通知后才能在 App 关闭时收到提醒。</p>
    <div class="group-title">添加 webhook</div>
    <div class="px-4 mb-2"><Segmented v-model="preset" :options="[{ value: 'bark', label: 'Bark' }, { value: 'ntfy', label: 'ntfy' }, { value: 'custom', label: '自定义' }]" /></div>
    <van-cell-group inset>
      <van-field v-model="webhookUrl" label="推送地址" placeholder="完整 HTTPS 地址（含 token 或主题）" type="password" autocomplete="off" />
      <van-field v-model="headers" label="请求头 JSON" type="textarea" rows="1" autosize />
      <van-field v-if="preset === 'custom'" v-model="body" label="JSON 模板" type="textarea" rows="2" autosize />
    </van-cell-group>
    <div class="px-4 mt-2"><van-button round block :loading="busy" :disabled="!webhookUrl" @click="run(add)">保存到 Worker</van-button></div>
    <p class="note">Bark 填 https://api.day.app/设备密钥，ntfy 填主题地址。自定义通道以 POST 发送 JSON，可在字符串中用 &#123;&#123;title&#125;&#125;、&#123;&#123;body&#125;&#125;、&#123;&#123;url&#125;&#125;、&#123;&#123;id&#125;&#125;。地址与密钥加密存放在自己的 Worker。</p>
  </template>
  <p v-if="error" class="note text-danger" role="alert">{{ error }}</p>
</template>
