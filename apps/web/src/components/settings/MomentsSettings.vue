<script setup lang="ts">
import { SOCIAL_PER_DAY_MAX } from '@app/shared';
import { computed } from 'vue';
import Avatar from '@/components/common/Avatar.vue';
import { socialStatus } from '@/services/social';
import { useCharacterStore } from '@/stores/characters';
import { useHubStore } from '@/stores/hub';
import { useSocialStore } from '@/stores/social';

/**
 * 朋友圈设置（"我的 → 朋友圈"）：
 * - 朋友圈显示最近几条（超过的不显示，也不给她们看；0 = 全部）；
 * - 每个角色自己发不发、每天最多几条（云端每天在随机的时间发 1 到这么多条）；
 * - 她发的朋友圈要配图时自动画。
 */
const social = useSocialStore();
const chars = useCharacterStore();
const hub = useHubStore();

const QUICK = [0, 10, 30, 100];
const status = computed(() => socialStatus());
const cloud = computed(() => {
  if (!hub.connected) return { ok: false, text: '云端还没接通：App 关着时她们不会发。在"云端与同步"接通自己的 Worker 后，每天在随机的时间自动发。' };
  if (!hub.supportsSocial) return { ok: false, text: '云端的 Worker 是旧版：部署最新的 Worker 和数据库迁移（0004_social）后才会自动发。' };
  if (hub.status?.lastSocialError) return { ok: false, text: `云端上一轮：${hub.status.lastSocialError}` };
  if (hub.socialErrors.length) return { ok: false, text: `云端有 ${hub.socialErrors.length} 条没发出来：${hub.socialErrors[0]?.reason}` };
  return { ok: true, text: '云端已接通：App 关着她们也会发，打开 App 时收到。' };
});
</script>

<template>
  <div class="sheet" data-sheet="moments-settings">
    <div class="sheet-title">朋友圈</div>

    <div class="field-label">朋友圈显示最近几条</div>
    <div class="flex items-center gap-2 flex-wrap">
      <button v-for="n in QUICK" :key="n" type="button" class="quick press" :class="{ on: social.settings.visibleCount === n }" @click="social.settings.visibleCount = n">{{ n ? `${n} 条` : '全部' }}</button>
      <span class="flex-1" />
      <van-stepper v-model="social.settings.visibleCount" :min="0" :max="500" integer aria-label="朋友圈显示最近几条" />
    </div>
    <p class="note">{{ social.settings.visibleCount ? `只显示最近 ${social.settings.visibleCount} 条，更早的不显示（没有删，调大就回来了）。` : '全部显示。' }}现在一共 {{ social.moments.length }} 条。</p>

    <div class="field-label">她们自己发朋友圈</div>
    <RouterLink v-if="!status.ok" to="/me/api?feature=social" class="warn-line">{{ status.reason }} →</RouterLink>
    <div class="grid gap-2">
      <div v-for="c in chars.list" :key="c.id" class="row">
        <Avatar :character="c" :size="34" />
        <div class="flex-1 min-w-0">
          <div class="text-[14px] font-600 truncate">{{ c.name }}</div>
          <div v-if="social.characterSettings(c.id).enabled" class="flex items-center gap-1.5 mt-1">
            <span class="text-[12px] text-ink-3 shrink-0">每天最多</span>
            <button
              v-for="n in SOCIAL_PER_DAY_MAX"
              :key="n"
              type="button"
              class="per press"
              :class="{ on: social.characterSettings(c.id).perDay === n }"
              :aria-pressed="social.characterSettings(c.id).perDay === n"
              :aria-label="`${c.name}每天最多 ${n} 条`"
              @click="social.setCharacter(c.id, { perDay: n })"
            >
              {{ n }}
            </button>
            <span class="text-[12px] text-ink-3 shrink-0">条</span>
          </div>
          <div v-else class="text-[12px] text-ink-3 mt-0.5">不自动发；朋友圈页里还能点"让她发一条"</div>
        </div>
        <van-switch :model-value="social.characterSettings(c.id).enabled" size="22" :aria-label="`${c.name}自己发朋友圈`" @update:model-value="(v: boolean) => social.setCharacter(c.id, { enabled: v })" />
      </div>
    </div>
    <p class="note" :class="{ warn: !cloud.ok }">{{ cloud.text }}每天实际发 1 到"最多"条之间，时间在她醒着的时段里随机，内容按她今天的节律和最近的聊天写。</p>

    <div class="row mt-3">
      <div class="flex-1 min-w-0">
        <div class="text-[14px] font-600">配图自动画</div>
        <div class="text-[12px] text-ink-3 mt-0.5">她发的朋友圈要配图时，收到就用"生图"画出来；关了就先显示要画的画面，点一下再画。</div>
      </div>
      <van-switch v-model="social.settings.autoImage" size="22" aria-label="配图自动画" />
    </div>
  </div>
</template>

<style scoped>
.quick,
.per {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 30px;
  padding: 0 12px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 13px;
}
.per {
  width: 30px;
  padding: 0;
}
.quick.on,
.per.on {
  background: var(--accent-soft);
  color: var(--ink);
  font-weight: 600;
  box-shadow: inset 0 0 0 1.5px var(--accent-line);
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 16px;
  background: var(--panel);
}
.note {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--ink-3);
}
.note.warn {
  color: var(--warn);
}
.warn-line {
  display: block;
  margin-bottom: 8px;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--warn);
  text-decoration: none;
}
</style>
