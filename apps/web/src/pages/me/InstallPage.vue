<script setup lang="ts">
import { showConfirmDialog, showToast } from 'vant';
import { onMounted, ref } from 'vue';
import PageHeader from '@/layouts/PageHeader.vue';
import { installInfo, platform, promptInstall, pwa, resetInstallData } from '@/pwa';
import { showErrorDialog } from '@/utils/errors';

/**
 * 装成 App：安装按钮（浏览器给了安装机会时）、各平台怎么装、卸载后装不回去怎么修、排查信息。
 */
const os = platform();
const info = ref<{ workers: string[]; caches: string[]; manifestId: string } | null>(null);
const resetting = ref(false);

onMounted(async () => {
  info.value = await installInfo().catch(() => null);
});

async function install() {
  try {
    const r = await promptInstall();
    if (r === 'accepted') showToast('正在安装，装好后在主屏幕上找"AI 陪伴"');
    else if (r === 'unavailable') showToast('浏览器现在没给安装机会，用下面的方法装');
  } catch (e) {
    showErrorDialog('安装没成功', e);
  }
}

async function reset() {
  const ok = await showConfirmDialog({
    title: '清理安装数据？',
    message: '注销这个 App 的后台服务、删掉缓存的网页文件，然后刷新。聊天、角色、Key 都不受影响。',
    confirmButtonText: '清理并刷新',
  }).then(
    () => true,
    () => false,
  );
  if (!ok) return;
  resetting.value = true;
  try {
    const r = await resetInstallData();
    showToast(`已清理：${r.workers} 个后台服务、${r.caches} 份缓存，正在刷新`);
    setTimeout(() => location.reload(), 900);
  } catch (e) {
    resetting.value = false;
    showErrorDialog('清理没成功', e);
  }
}
</script>

<template>
  <div class="page" data-page="install">
    <PageHeader title="装成 App" subtitle="添加到主屏幕，全屏打开，断网也能进" fallback="/me" />
    <div class="page-scroll pb-10">
      <div class="card mx-4 mt-3">
        <div class="flex items-center gap-3">
          <span class="big-icon"><span :class="pwa.standalone ? 'i-lucide-circle-check' : 'i-lucide-smartphone'" /></span>
          <div class="flex-1 min-w-0">
            <div class="text-[15px] font-600">{{ pwa.standalone ? '已经装成 App 了' : pwa.justInstalled ? '装好了' : '现在是在浏览器里打开' }}</div>
            <div class="text-[12.5px] text-ink-3">
              {{ pwa.standalone ? '现在就是从主屏幕打开的' : pwa.justInstalled ? '回到主屏幕，从"AI 陪伴"图标打开' : pwa.canPrompt ? '浏览器说可以安装' : '按下面的方法添加到主屏幕' }}
            </div>
          </div>
        </div>
        <van-button v-if="pwa.canPrompt && !pwa.standalone" type="primary" round block class="!mt-3" @click="install">安装到主屏幕</van-button>
      </div>

      <template v-if="!pwa.standalone">
        <div class="group-title">怎么装</div>
        <div class="card mx-4">
          <ol class="steps">
            <template v-if="os === 'ios'">
              <li>用 Safari 打开这个网页（别的浏览器在 iPhone 上不能装）</li>
              <li>点底部的"分享"按钮 → "添加到主屏幕"</li>
              <li>回到主屏幕，从"AI 陪伴"图标打开</li>
            </template>
            <template v-else>
              <li v-if="pwa.canPrompt">点上面的"安装到主屏幕"</li>
              <li>{{ pwa.canPrompt ? '或者：' : '' }}浏览器右上角菜单 ⋮ → "安装应用"（有的浏览器叫"添加到主屏幕"）</li>
              <li>回到主屏幕，从"AI 陪伴"图标打开</li>
            </template>
          </ol>
        </div>
      </template>

      <div class="group-title">卸载后装不回去？</div>
      <div class="card mx-4">
        <p class="para">
          以前的版本把 App 的身份（manifest 的 id）写成了"./"，浏览器把它解析成网站根目录 none0enon.github.io/，和同一个网址下的其他网页 App 可能撞在一起：卸载后浏览器还以为装着，菜单里只有"打开"、没有"安装"。这一版换成了独立的身份（/ai-mobile/）。按顺序试：
        </p>
        <ol class="steps">
          <li>点下面的"清理安装数据并刷新"（只清后台服务和缓存，聊天、角色、Key 都还在）</li>
          <li v-if="os === 'ios'">确认主屏幕上旧的图标已经删掉，再用 Safari → 分享 → 添加到主屏幕</li>
          <template v-else>
            <li>在手机设置 → 应用里确认旧的"AI 陪伴"已经卸载</li>
            <li>把浏览器从最近任务里划掉，重新打开这个网页，再按"怎么装"安装</li>
          </template>
          <li>
            还不行：浏览器设置 → 网站设置 → none0enon.github.io → 清除数据。
            <b class="text-bad">这会删掉这台设备上的聊天和 Key，也会清掉同一个网址下其他网页 App 的数据，先在"同步与备份"里备份。</b>
          </li>
        </ol>
        <van-button round block plain type="danger" class="!mt-3" :loading="resetting" loading-text="清理中" @click="reset">清理安装数据并刷新</van-button>
      </div>

      <div class="group-title">排查信息</div>
      <van-cell-group inset>
        <van-cell title="App 身份（manifest id）" :label="info?.manifestId || '读取中…'" />
        <van-cell title="后台服务" :label="info ? info.workers.join('\n') || '没有注册' : '读取中…'" :value="pwa.swError ? '注册失败' : ''" />
        <van-cell v-if="pwa.swError" title="注册失败的原因" :label="pwa.swError" />
        <van-cell title="缓存" :label="info ? info.caches.join('、') || '没有' : '读取中…'" />
        <van-cell title="打开方式" :value="pwa.standalone ? '主屏幕（全屏）' : '浏览器'" />
      </van-cell-group>
    </div>
  </div>
</template>

<style scoped>
.card {
  padding: 14px 16px;
  border-radius: 16px;
  background: var(--surface);
  border: 1px solid var(--border);
}
.big-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 42px;
  border-radius: 14px;
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: 22px;
  flex-shrink: 0;
}
.para {
  margin: 0;
  font-size: 13px;
  line-height: 1.65;
  color: var(--ink-2);
}
.steps {
  margin: 8px 0 0;
  padding-left: 20px;
  list-style: decimal;
  font-size: 13.5px;
  line-height: 1.7;
  color: var(--ink);
}
.steps li + li {
  margin-top: 4px;
}
:deep(.van-cell__label) {
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
