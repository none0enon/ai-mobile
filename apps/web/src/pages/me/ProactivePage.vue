<script setup lang="ts">
import { DEFAULT_PROACTIVE_RULES, WEBHOOK_PRESETS, type NotificationPreview } from '@app/shared';
import { showToast } from 'vant';
import { computed, ref } from 'vue';
import Segmented from '@/components/common/Segmented.vue';
import PageHeader from '@/layouts/PageHeader.vue';
import { pushChannels, todayTouchpoints } from '@/mock/settings';
import { services } from '@/services';
import { useCharacterStore } from '@/stores/characters';
import { hhmm } from '@/utils/time';

/**
 * 主动消息："先排期，再触发"。每天凌晨（或当天第一次打开 App）按规则排出今天的计划，
 * Worker 每 5 分钟检查到点的计划，用最新的上下文写消息，再按通道推送；打开 App 时补齐没收到的。
 */
const chars = useCharacterStore();
const c = computed(() => chars.byId('suwan')!);
const rules = ref(DEFAULT_PROACTIVE_RULES.map((r) => ({ ...r })));
const plan = todayTouchpoints();
const channels = ref(pushChannels.map((p) => ({ ...p })));
const preview = ref<NotificationPreview>('name-only');
const testing = ref<string | null>(null);

const STATUS: Record<string, { label: string; cls: string }> = {
  planned: { label: '已排期', cls: 'accent' },
  fired: { label: '已发送', cls: 'good' },
  delivered: { label: '已送达', cls: 'good' },
  opened: { label: '已读', cls: 'good' },
  skipped: { label: '跳过', cls: 'warn' },
};
const CHANNEL_ICON: Record<string, string> = { webpush: 'i-lucide-globe', android: 'i-lucide-smartphone', webhook: 'i-lucide-webhook' };

async function test(id: string) {
  testing.value = id;
  const ok = await services.push.test(id);
  testing.value = null;
  showToast(ok ? '测试推送已发出' : '发送失败');
}
</script>

<template>
  <div class="page" data-page="proactive">
    <PageHeader title="主动消息" subtitle="她什么时候、通过什么方式来找你" fallback="/me" />
    <div class="page-scroll pb-10">
      <van-cell-group inset class="!mt-3">
        <van-cell :title="`${c.name}会主动找你`" center>
          <template #right-icon><van-switch v-model="c.proactive.enabled" size="22px" /></template>
        </van-cell>
        <van-cell title="性格">
          <template #label>
            <Segmented
              v-model="c.proactive.personality"
              class="mt-2"
              :options="[
                { value: 'clingy', label: '粘人' },
                { value: 'balanced', label: '适中' },
                { value: 'independent', label: '独立' },
              ]"
            />
            <div class="mt-1.5">粘人：更常来找你，没回会追一句；独立：只在重要时刻出现</div>
          </template>
        </van-cell>
        <van-cell title="每天最多" center>
          <template #right-icon><van-stepper v-model="c.proactive.dailyCap" min="1" max="12" /></template>
        </van-cell>
        <van-cell title="勿扰时段" :value="`${c.proactive.quietHours.start} - ${c.proactive.quietHours.end}`" is-link />
      </van-cell-group>

      <div class="group-title">今天的计划</div>
      <div class="px-4">
        <div class="plan">
          <div v-for="t in plan" :key="t.id" class="tp" :class="t.status">
            <span class="time num">{{ hhmm(t.dueAt) }}</span>
            <span class="dot" />
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-1.5">
                <span class="text-[14px]">{{ DEFAULT_PROACTIVE_RULES.find((r) => r.id === t.ruleId)?.label }}</span>
                <span v-if="t.action === 'call'" class="tag"><span class="i-lucide-phone" />来电</span>
                <span class="tag ml-auto" :class="STATUS[t.status]?.cls">{{ STATUS[t.status]?.label }}</span>
              </div>
              <div class="text-[12px] text-ink-3 truncate">{{ t.skipReason ?? t.hint }}</div>
            </div>
          </div>
        </div>
      </div>
      <p class="note">Worker 每 5 分钟检查一次到点的计划，消息内容在那一刻才写（用最新的天气、你今天吃没吃饭）。安卓壳会把计划设成精确闹钟，不靠推送也能准时。</p>

      <div class="group-title">触发规则</div>
      <van-cell-group inset>
        <van-cell v-for="r in rules" :key="r.id" :title="r.label" :label="`${r.desc}${r.window ? ` · ${r.window.start}-${r.window.end}` : ''}${r.canCall ? ' · 可升级为来电' : ''}`" center>
          <template #right-icon><van-switch v-model="r.enabled" size="20px" /></template>
        </van-cell>
      </van-cell-group>

      <div class="group-title">推送通道<button class="action"><span class="i-lucide-plus" />添加</button></div>
      <div class="px-4 grid gap-2">
        <div v-for="ch in channels" :key="ch.id" class="channel">
          <span class="ch-icon"><span :class="CHANNEL_ICON[ch.kind]" /></span>
          <div class="flex-1 min-w-0">
            <div class="text-[14.5px] truncate">{{ ch.label }}</div>
            <div class="text-[12px] text-ink-3 truncate">
              {{ ch.kind === 'webhook' && ch.preset ? WEBHOOK_PRESETS[ch.preset].desc : ch.kind === 'webpush' ? 'APNs / 微软通道，国内可用' : '轮询 + 精确闹钟，不需要谷歌服务' }}
              <template v-if="ch.lastOkAt"> · 上次成功 {{ hhmm(ch.lastOkAt) }}</template>
            </div>
          </div>
          <van-button size="mini" round :loading="testing === ch.id" :disabled="!ch.enabled" @click="test(ch.id)">测试</van-button>
          <van-switch v-model="ch.enabled" size="20px" />
        </div>
      </div>
      <p class="note">Worker 会按顺序尝试已开启的通道，直到有一个成功；无论推送是否成功，打开 App 时都会补齐。</p>

      <div class="group-title">锁屏上显示</div>
      <div class="px-4">
        <Segmented
          v-model="preview"
          :options="[
            { value: 'full', label: '完整内容' },
            { value: 'name-only', label: '只显示名字' },
            { value: 'hidden', label: '隐藏' },
          ]"
        />
        <div class="lock">
          <span class="i-lucide-bell text-[18px]" />
          <div class="flex-1 min-w-0">
            <div class="text-[13px] font-600">{{ preview === 'hidden' ? 'AI 陪伴' : c.name }}</div>
            <div class="text-[12.5px] text-ink-2 truncate">
              {{ preview === 'full' ? '你吃晚饭了吗？我有点饿了……' : preview === 'name-only' ? '给你发来一条消息' : '你有一条新消息' }}
            </div>
          </div>
          <span class="text-[11px] text-ink-3">现在</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.plan {
  padding: 6px 12px;
  border-radius: 16px;
  background: var(--surface);
  border: 1px solid var(--border);
}
.tp {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 0;
}
.tp + .tp {
  border-top: 1px solid var(--border);
}
.tp.planned {
  opacity: 1;
}
.tp.skipped,
.tp.opened {
  opacity: 0.7;
}
.time {
  width: 42px;
  font-size: 13px;
  color: var(--ink-2);
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--ink-3);
  flex-shrink: 0;
}
.tp.planned .dot {
  background: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.tp.opened .dot {
  background: var(--good);
}
.tp.skipped .dot {
  background: var(--warn);
}
.channel {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 14px;
  background: var(--surface);
  border: 1px solid var(--border);
}
.ch-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 10px;
  background: var(--panel);
  color: var(--accent-ink);
  font-size: 17px;
  flex-shrink: 0;
}
.lock {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
  padding: 12px;
  border-radius: 18px;
  background: var(--glass-strong);
  border: 1px solid var(--glass-line);
}
</style>
