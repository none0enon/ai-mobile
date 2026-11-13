<script setup lang="ts">
import { substituteMacros, TIMED_TRIGGERS, touchpointClock, type ProactiveTriggerId } from '@app/shared';
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import PersonTabs from '@/components/common/PersonTabs.vue';
import Segmented from '@/components/common/Segmented.vue';
import PageHeader from '@/layouts/PageHeader.vue';
import { personas } from '@/mock/characters';
import { useAiStore } from '@/stores/ai';
import { useAppStore } from '@/stores/app';
import { useCharacterStore } from '@/stores/characters';
import { useProactiveStore, type PlannedTouchpoint } from '@/stores/proactive';
import { useHubStore } from '@/stores/hub';
import { useEnvironmentStore } from '@/stores/environment';
import CloudPushSettings from '@/components/settings/CloudPushSettings.vue';

/**
 * 主动消息："先排期，再触发"。每个角色按自己的设置（开没开、性格、每天最多几条、勿扰、允许哪些时候来找你）排今天的计划，
 * Cloudflare 每 5 分钟检测并生成；本机同步已生成的消息。
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
const left = computed(() => (c.value ? proactive.upcoming(c.value.id) : 0));

const hub = useHubStore();
const env = useEnvironmentStore();
const preview = computed({ get: () => hub.config.preview, set: (v) => { hub.config.preview = v; } });

const RULE_LABEL = Object.fromEntries(proactive.rules.map((r) => [r.id, r.label])) as Record<ProactiveTriggerId, string>;

/** 一条计划现在的状态：发了 / 没发（为什么）/ 等着 */
function stateOf(t: PlannedTouchpoint): { label: string; cls: string; note: string } {
  const hint = substituteMacros(t.hint, { char: c.value?.name ?? '', user: me?.name ?? '你' });
  if (t.log?.status === 'fired') return { label: t.action === 'call' ? '打过来了' : '已发送', cls: 'good', note: t.log.reason ? `${hint}（${t.log.reason}）` : hint };
  if (t.log?.status === 'skipped') return { label: '没发', cls: 'warn', note: t.log.reason ?? '' };
  if (t.status === 'skipped') return { label: '不发', cls: 'warn', note: t.skipReason ?? '' };
  if (t.dueAt <= proactive.clock) return { label: hub.config.active ? '待云端检测' : '云端未开启', cls: 'accent', note: ('lastError' in t && typeof t.lastError === 'string') ? t.lastError : hint };
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
              <div class="mt-1.5">按性格和时段安排；实际发送还会检查勿扰、最近聊天和未回复退避</div>
            </template>
          </van-cell>
          <van-cell title="允许主动来电" label="叫醒、催睡时直接打过来" center>
            <template #right-icon><van-switch v-model="c.proactive.allowCalls" size="22px" /></template>
          </van-cell>
          <van-cell title="勿扰时段" :value="`${c.proactive.quietHours.start} - ${c.proactive.quietHours.end}`" />
        </van-cell-group>

        <div class="source" :class="{ warn: !hub.config.active }" data-testid="proactive-source">
          <span class="i-lucide-cloud shrink-0 mt-0.5" />
          <span v-if="hub.config.active">云端每 5 分钟检测，App 关闭时照常生成和推送。消息使用同步到云端的角色卡、预设和聊天。<RouterLink to="/me/sync" class="text-accent-ink">查看云端状态</RouterLink></span>
          <span v-else>云端主动消息尚未开启。<RouterLink to="/me/sync" class="text-accent-ink">连接并启用 Cloudflare Worker →</RouterLink></span>
        </div>
        <p v-if="!live" class="note">本机「主动消息」API 尚未接通。启用云端前请先在 <RouterLink to="/me/api" class="text-accent-ink">API 设置</RouterLink> 中配置。</p>
        <p v-if="hub.error" class="note text-danger" role="alert">{{ hub.error }}</p>

        <div class="group-title">{{ c.name }}今天的计划</div>
        <div class="px-4">
          <div v-if="!c.proactive.enabled" class="plan empty">没打开主动消息，今天不会来找你。打开上面的开关就按下面的规则排。</div>
          <div v-else-if="!plan.length" class="plan empty">今天没有按时间排的计划（下面的规则都关着，或者都要等事件触发）。</div>
          <div v-else class="plan" data-testid="proactive-plan">
            <div v-for="t in plan" :key="t.id" class="tp" :class="stateOf(t).cls" :data-rule="t.ruleId">
              <span class="time num">{{ touchpointClock(t, env.settings.timezone) }}</span>
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
        <p class="note">计划和勿扰时段使用你在<RouterLink to="/me/environment" class="text-accent-ink">环境与作息</RouterLink>中选择的时区（{{ env.settings.timezone }}）。最近 20 分钟聊过、学习或哄睡、规则冷却、连续未回复退避和你设置的 token 预算都在云端检查。打开 App 只补齐已生成的消息，不会重复生成。</p>

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

      <CloudPushSettings />

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
