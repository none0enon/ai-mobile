<script setup lang="ts">
import { showToast } from 'vant';
import { ref } from 'vue';
import PageHeader from '@/layouts/PageHeader.vue';
import { services, type SyncStatus } from '@/services';
import { hhmm } from '@/utils/time';

/**
 * 同步：自己的 Cloudflare Worker + D1。按记录增量同步（服务器分配递增序号，不靠设备时钟），
 * 图片音频按内容哈希放 R2。Key 默认不同步。
 */
const status = ref<SyncStatus>(services.sync.status());
const syncing = ref(false);
const autoSync = ref(true);
const encryptKeys = ref(false);
const dailyBackup = ref(true);

async function syncNow() {
  syncing.value = true;
  status.value = await services.sync.syncNow();
  syncing.value = false;
  showToast('已同步');
}
function ago(ts: number | null) {
  if (!ts) return '从未';
  const m = Math.round((Date.now() - ts) / 60_000);
  return m < 1 ? '刚刚' : m < 60 ? `${m} 分钟前` : `今天 ${hhmm(ts)}`;
}
</script>

<template>
  <div class="page" data-page="sync">
    <PageHeader title="同步与备份" subtitle="多台设备看到同一段感情" fallback="/me" />
    <div class="page-scroll pb-10">
      <div class="hub mx-4 mt-3">
        <div class="flex items-center gap-2">
          <span class="i-lucide-server text-[20px] text-accent-ink" />
          <div class="flex-1 min-w-0">
            <div class="text-[15px] font-600">我的 Worker</div>
            <div class="text-[12px] text-ink-3 truncate">https://companion.example.com（Cloudflare Worker + D1 + R2）</div>
          </div>
          <span class="tag good"><span class="i-lucide-circle-check" />已连接</span>
        </div>
        <div class="grid grid-cols-3 gap-2 mt-3 text-center">
          <div><b class="num">{{ ago(status.lastSyncAt) }}</b><small>上次同步</small></div>
          <div><b class="num">{{ status.pending }}</b><small>待上传</small></div>
          <div><b class="num">{{ status.devices.length }}</b><small>台设备</small></div>
        </div>
        <van-button type="primary" round block class="!mt-3" :loading="syncing" loading-text="同步中" @click="syncNow">立即同步</van-button>
      </div>

      <div class="group-title">设备</div>
      <van-cell-group inset>
        <van-cell v-for="d in status.devices" :key="d.name" :title="d.name" :label="d.platform" :value="d.current ? '这台' : ago(d.lastSeen)">
          <template #icon><span :class="d.platform.includes('Android') ? 'i-lucide-smartphone' : d.platform.includes('iOS') ? 'i-lucide-tablet-smartphone' : 'i-lucide-monitor'" class="row-icon" /></template>
        </van-cell>
      </van-cell-group>

      <div class="group-title">同步方式</div>
      <van-cell-group inset>
        <van-cell title="自动同步" label="启动、回到前台、改动后、每 15 分钟" center>
          <template #right-icon><van-switch v-model="autoSync" size="22px" /></template>
        </van-cell>
        <van-cell title="在设备间同步 Key" label="用你自己设的同步密码加密，Worker 只存密文" center>
          <template #right-icon><van-switch v-model="encryptKeys" size="22px" /></template>
        </van-cell>
      </van-cell-group>

      <div class="group-title">交给 Worker 保管的 Key</div>
      <van-cell-group inset>
        <van-cell title="还没有" label="连上自己的 Worker 后，后台功能（主动消息、夜间总结）的 Key 可以交给它保管：只能写入、读不回来">
          <template #icon><span class="i-lucide-key-round row-icon" /></template>
        </van-cell>
      </van-cell-group>

      <div class="group-title">备份</div>
      <van-cell-group inset>
        <van-cell title="每天自动备份" label="本机 + R2 各留 7 天" center>
          <template #right-icon><van-switch v-model="dailyBackup" size="22px" /></template>
        </van-cell>
        <van-cell title="导出全部数据（ZIP）" is-link @click="showToast('M2 实现')" />
        <van-cell title="导出给 SillyTavern" label="角色卡 PNG、世界书 JSON、聊天 .jsonl" is-link @click="showToast('M1 实现')" />
        <van-cell title="从备份恢复" is-link @click="showToast('M2 实现')" />
      </van-cell-group>
      <p class="note">国内网络下 *.workers.dev 经常打不开，部署时给 Worker 绑一个自己的域名（设计文档里有步骤）。云端非空时，不会被本机的空数据覆盖。</p>
    </div>
  </div>
</template>

<style scoped>
.hub {
  padding: 14px;
  border-radius: 20px;
  background: var(--surface);
  border: 1px solid var(--border);
}
.hub b {
  display: block;
  font-size: 15px;
}
.hub small {
  font-size: 11.5px;
  color: var(--ink-3);
}
</style>
