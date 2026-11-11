<script setup lang="ts">
import { substituteMacros, TIMED_TRIGGERS, touchpointClock, WEBHOOK_PRESETS, type NotificationPreview, type ProactiveTriggerId } from '@app/shared';
import { showToast } from 'vant';
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import PersonTabs from '@/components/common/PersonTabs.vue';
import Segmented from '@/components/common/Segmented.vue';
import PageHeader from '@/layouts/PageHeader.vue';
import { personas } from '@/mock/characters';
import { pushChannels } from '@/mock/settings';
import { services } from '@/services';
import { useAiStore } from '@/stores/ai';
import { useAppStore } from '@/stores/app';
import { useCharacterStore } from '@/stores/characters';
import { useProactiveStore, type PlannedTouchpoint } from '@/stores/proactive';
import { hhmm } from '@/utils/time';

/**
 * 主动消息："先排期，再触发"。每个角色按自己的设置（开没开、性格、每天最多几条、勿扰、允许哪些时候来找你）排今天的计划，
 * App 开着时到点就发（stores/proactive.ts）；Worker 接上以后 App 关着也能准点发。
 * 上面一排头像切换看谁的（?char=），导入的角色也在里面。
 */
const route = useRoute();
const router = useRouter();
const chars = useCharacterStore();
const app = useAppStore();
const ai = useAiStore();
const proactive = useProactiveStore();
const me = personas.find((p) => p.isDefault) ?? personas[0];

const pickedId = ref((route.query.char as string | undefined) ?? app.activeCharacterId);
const c = computed(() => chars.byId(pickedId.value) ?? chars.list[0]);
// 点头像换人时写进地址；地址里的 ?char= 变了（同一页换参数，页面不会重建）也跟着换
watch(pickedId, (id) => {
  if (route.query.char !== id) void router.replace({ query: { ...route.query, char: id } });
});
watch(
  () => route.query.char,
  (id) => {
    if (typeof id === 'string' && id !== pickedId.value) pickedId.value = id;
  },
);

const plan = computed(() => (c.value ? proactive.planFor(c.value.id) : []));
const live = computed(() => ai.isLive('proactive'));
const isDemo = computed(() => !!c.value && chars.isDemo(c.value.id));
const left = computed(() => (c.value ? proactive.upcoming(c.value.id) : 0));

const channels = ref(pushChannels.map((p) => ({ ...p })));
const preview = ref<NotificationPreview>('name-only');
const testing = ref<string | null>(null);

const RULE_LABEL = Object.fromEntries(proactive.rules.map((r) => [r.id, r.label])) as Record<ProactiveTriggerId, string>;
const CHANNEL_ICON: Record<string, string> = { webpush: 'i-lucide-globe', android: 'i-lucide-smartphone', webhook: 'i-lucide-webhook' };

/** 一条计划现在的状态：发了 / 没发（为什么）/ 等着 */
function stateOf(t: PlannedTouchpoint): { label: string; cls: string; note: string } {
  const hint = substituteMacros(t.hint, { char: c.value?.name ?? '', user: me?.name ?? '你' });
  if (t.log?.status === 'fired') return { label: t.action === 'call' ? '打过来了' : '已发送', cls: 'good', note: t.log.reason ? `${hint}（${t.log.reason}）` : hint };
  if (t.log?.status === 'skipped') return { label: '没发', cls: 'warn', note: t.log.reason ?? '' };
  if (t.status === 'skipped') return { label: '不发', cls: 'warn', note: t.skipReason ?? '' };
  if (t.dueAt <= proactive.clock) return { label: '到点了', cls: 'accent', note: hint };
  return { label: '已排期', cls: 'accent', note: hint };
}

/** 她会在哪些时候来找你：按时间排的在前；天气、运动、学习、纪念日这类要等事件，暂时还不会触发 */
const ruleRows = computed(() =>
  proactive.rules.map((r) => ({
    ...r,
    timed: TIMED_TRIGGERS.includes(r.id),
    on: !!c.value?.proactive.triggers.includes(r.id),
  })),
);
function toggleRule(id: ProactiveTriggerId, on: boolean) {
  const p = c.value?.proactive;
  if (!p) return;
  p.triggers = on ? [...new Set([...p.triggers, id])] : p.triggers.filter((x) => x !== id);
}

async function test(id: string) {
  testing.value = id;
  const ok = await services.push.test(id);
  testing.value = null;
  showToast(ok ? '测试推送已发出' : '发送失败');
}
</script>

<template>
  <div class="page" data-page="proactive">
    <PageHeader title="主动消息" subtitle="谁、什么时候、通过什么方式来找你" fallback="/me" />
    <div class="page-scroll pb-10">
      <PersonTabs v-model="pickedId" :characters="chars.list" label="看谁的主动消息" :off="(x) => !x.proactive.enabled" class="px-4 pt-3" />

      <template v-if="c">
        <van-cell-group inset class="!mt-3">
          <van-cell :title="`${c.name}会主动找你`" :label="c.proactive.enabled ? `今天还会来找你 ${left} 次` : '关着：今天不会来找你'" center>
            <template #right-icon><van-switch v-model="c.proactive.enabled" size="22px" :aria-label="`${c.name}会主动找你`" /></template>
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
              <div class="mt-1.5">没有条数上限：粘人的每个时段几乎都来，独立的随缘，但每天至少来一次</div>
            </template>
          </van-cell>
          <van-cell title="允许主动来电" label="叫醒、催睡时直接打过来" center>
            <template #right-icon><van-switch v-model="c.proactive.allowCalls" size="22px" /></template>
          </van-cell>
          <van-cell title="勿扰时段" :value="`${c.proactive.quietHours.start} - ${c.proactive.quietHours.end}`" />
        </van-cell-group>

        <div class="source" :class="{ warn: !live && !isDemo }" data-testid="proactive-source">
          <span :class="live ? 'i-lucide-sparkles' : 'i-lucide-info'" class="shrink-0 mt-0.5" />
          <span v-if="live">到点时由「主动消息」的模型（{{ ai.chatModelOf('proactive') || '已接通' }}）按{{ c.name }}的预设、角色卡和你们的聊天，用{{ c.pronoun }}的口吻写。</span>
          <span v-else-if="isDemo">「主动消息」还没接通 API：{{ c.name }}到点发演示台词。<RouterLink to="/me/api" class="text-accent-ink">去 API 设置</RouterLink></span>
          <span v-else>「主动消息」还没接通 API：{{ c.name }}是导入的角色，没有能代替{{ c.pronoun }}说话的台词，到点会跳过。<RouterLink to="/me/api" class="text-accent-ink">去 API 设置</RouterLink></span>
        </div>

        <div class="group-title">{{ c.name }}今天的计划</div>
        <div class="px-4">
          <div v-if="!c.proactive.enabled" class="plan empty">没打开主动消息，今天不会来找你。打开上面的开关就按下面的规则排。</div>
          <div v-else-if="!plan.length" class="plan empty">今天没有按时间排的计划（下面的规则都关着，或者都要等事件触发）。</div>
          <div v-else class="plan" data-testid="proactive-plan">
            <div v-for="t in plan" :key="t.id" class="tp" :class="stateOf(t).cls" :data-rule="t.ruleId">
              <span class="time num">{{ touchpointClock(t) }}</span>
              <span class="dot" />
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-1.5">
                  <span class="text-[14px]">{{ RULE_LABEL[t.ruleId] ?? t.ruleId }}</span>
                  <span v-if="t.action === 'call'" class="tag"><span class="i-lucide-phone" />来电</span>
                  <span class="tag ml-auto" :class="stateOf(t).cls">{{ stateOf(t).label }}</span>
                </div>
                <div class="text-[12px] text-ink-3 line-clamp-2">{{ stateOf(t).note }}</div>
              </div>
            </div>
          </div>
        </div>
        <p class="note">App 开着时每分钟看一次，到点就发；你 20 分钟内刚和{{ c.pronoun }}聊过就不打扰。App 关着时到点的，3 小时内打开会补上最近的一条，更早的算错过；接上自己的 Worker 以后由它准点发、推送到手机。</p>

        <div class="group-title">{{ c.name }}会在这些时候来找你</div>
        <van-cell-group inset>
          <van-cell
            v-for="r in ruleRows"
            :key="r.id"
            :title="r.label"
            :label="`${r.desc}${r.window ? ` · ${r.window.start}-${r.window.end}` : ''}${r.canCall ? ' · 可以打电话' : ''}${r.timed ? '' : ' · 要等事件触发，还没接'}`"
            center
          >
            <template #right-icon><van-switch :model-value="r.on" size="20px" :aria-label="r.label" @update:model-value="(v: boolean) => toggleRule(r.id, v)" /></template>
          </van-cell>
        </van-cell-group>
      </template>
      <p v-else class="note">还没有角色。先在"我的 → 导入 ST 文件"里导入一张角色卡。</p>

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
      <p class="note">推送要等 Worker 接上（M3）：Worker 会按顺序尝试已开启的通道，直到有一个成功；无论推送是否成功，打开 App 时都会补齐。</p>

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
            <div class="text-[13px] font-600">{{ preview === 'hidden' ? 'AI 陪伴' : (c?.name ?? 'AI 陪伴') }}</div>
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
.source {
  display: flex;
  gap: 8px;
  margin: 10px 16px 0;
  padding: 10px 12px;
  border-radius: 14px;
  background: var(--accent-soft);
  color: var(--ink-2);
  font-size: 12.5px;
  line-height: 1.6;
}
.source.warn {
  background: color-mix(in srgb, var(--warn) 14%, transparent);
}
.plan {
  padding: 6px 12px;
  border-radius: 16px;
  background: var(--surface);
  border: 1px solid var(--border);
}
.plan.empty {
  padding: 14px;
  font-size: 13px;
  color: var(--ink-3);
  line-height: 1.6;
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
.tp.warn,
.tp.good {
  opacity: 0.75;
}
.time {
  width: 42px;
  flex-shrink: 0;
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
.tp.accent .dot {
  background: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.tp.good .dot {
  background: var(--good);
}
.tp.warn .dot {
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
