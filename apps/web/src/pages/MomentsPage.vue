<script setup lang="ts">
import { MOMENT_USER, type Character, type Moment } from '@app/shared';
import { showConfirmDialog, showToast } from 'vant';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Avatar from '@/components/common/Avatar.vue';
import MomentCard from '@/components/moments/MomentCard.vue';
import MomentComposer from '@/components/moments/MomentComposer.vue';
import { postMoment, socialStatus, userComment } from '@/services/social';
import { useCharacterStore } from '@/stores/characters';
import { useHubStore } from '@/stores/hub';
import { useSocialStore } from '@/stores/social';

/**
 * 朋友圈：她们按自己的节律和最近的聊天发的日常，和你发的。
 * - 右上角：发朋友圈（选谁可以看）、让她现在发一条；
 * - 云端接通后，App 关着她们也会每天在随机的时间发；
 * - 只显示最近 x 条（"我的 → 朋友圈"里改）。
 */
const social = useSocialStore();
const chars = useCharacterStore();
const hub = useHubStore();

const composing = ref(false);
const asking = ref(false);

// 看过了：进来、离开、停在这页时来了新的，都算看过
onMounted(() => social.markAllRead());
onBeforeUnmount(() => social.markAllRead());
watch(() => social.unread, (n) => n && social.markAllRead());

const cloudNote = computed(() => {
  if (!hub.connected) return '云端还没接通：她们只在你点"让她发一条"时发。在"我的 → 云端与同步"接通自己的 Worker 后，App 关着她们也会每天在随机的时间发。';
  if (!hub.supportsSocial) return '云端的 Worker 是旧版，还不会发朋友圈：部署最新的 Worker 和数据库迁移后，App 关着她们也会每天发。';
  const failed = hub.socialErrors[0];
  if (failed) return `云端有一条没发出来：${failed.reason}`;
  return '云端已接通：App 关着她们也会每天在随机的时间发（谁发、每天最多几条在"我的 → 朋友圈"里改）。';
});

// —— 让她发一条 ——
const status = computed(() => socialStatus());
async function ask(c: Character) {
  const r = await postMoment(c.id);
  if (r.ok) asking.value = false;
  else showToast({ message: r.reason.slice(0, 140), duration: 3000 });
}

// —— 评论 ——
const commenting = ref<{ moment: Moment; replyTo?: string } | null>(null);
const draft = ref('');
const input = ref<HTMLInputElement | null>(null);
const commentHint = computed(() => {
  const c = commenting.value;
  if (!c) return '';
  const target = c.replyTo ?? (c.moment.authorId === MOMENT_USER ? undefined : c.moment.authorId);
  return target ? `回复 ${chars.byId(target)?.name ?? ''}` : '评论';
});
function openComment(moment: Moment, replyTo?: string) {
  commenting.value = { moment, replyTo };
  draft.value = '';
  void nextTick(() => input.value?.focus());
}
function sendComment() {
  const c = commenting.value;
  if (!c || !draft.value.trim()) return;
  userComment(c.moment.id, draft.value, c.replyTo ?? (c.moment.authorId === MOMENT_USER ? undefined : c.moment.authorId));
  commenting.value = null;
}

// —— 删除 ——
async function more(m: Moment) {
  try {
    await showConfirmDialog({ title: '删掉这条朋友圈？', message: '连同下面的点赞和评论一起删掉。她们已经记住的不会跟着忘，要忘掉去"回忆 → 记忆本"里删。', confirmButtonText: '删掉' });
  } catch {
    return;
  }
  social.remove(m.id);
}
</script>

<template>
  <div class="page" data-page="moments">
    <header class="gutter pt-[calc(var(--safe-top)+14px)] pb-1 flex items-end gap-2">
      <div class="flex-1 min-w-0">
        <h1 class="m-0 text-[28px] font-700 leading-tight">朋友圈</h1>
        <div class="text-[12.5px] text-ink-3 mt-0.5 truncate">她们的日常，和你的</div>
      </div>
      <div class="flex shrink-0">
        <button class="icon-btn" aria-label="让她发一条" data-testid="moment-ask" @click="asking = true"><span class="i-lucide-sparkles text-[20px]" /></button>
        <button class="icon-btn" aria-label="发朋友圈" data-testid="moment-compose" @click="composing = true"><span class="i-lucide-camera text-[20px]" /></button>
      </div>
    </header>

    <div class="page-scroll">
      <!-- 没接通时只在这里说一次：她们不会自己发、也不会回应（演示角色用占位台词） -->
      <RouterLink v-if="!status.ok" to="/me/api?feature=social" class="hint">
        <span class="i-lucide-plug-zap shrink-0" />
        <span class="flex-1 min-w-0">{{ status.reason }}。接通后她们才会自己发朋友圈、回应你发的。</span>
        <span class="i-lucide-chevron-right shrink-0" />
      </RouterLink>
      <MomentCard v-for="m in social.feed" :key="m.id" :moment="m" @comment="(replyTo) => openComment(m, replyTo)" @more="more(m)" />

      <div v-if="!social.feed.length" class="empty">
        <span class="i-lucide-aperture text-[40px] text-ink-3" />
        <div class="text-[15px] font-600 mt-3">还没有朋友圈</div>
        <p class="text-[13px] text-ink-3 leading-relaxed mt-1 mb-0">让她发一条看看她此刻在做什么，或者自己先发一条。</p>
        <div class="flex gap-2.5 mt-4">
          <van-button round size="small" @click="asking = true">让她发一条</van-button>
          <van-button round size="small" type="primary" @click="composing = true">发朋友圈</van-button>
        </div>
      </div>
      <p v-else-if="social.hidden > 0" class="foot">
        只显示最近 {{ social.settings.visibleCount }} 条，更早的 {{ social.hidden }} 条没有显示。
        <RouterLink to="/me?open=moments" class="text-accent-ink">去改</RouterLink>
      </p>
      <p v-else class="foot">没有更多了</p>
    </div>

    <!-- 让她发一条 -->
    <van-popup v-model:show="asking" position="bottom" round teleport="body" :style="{ maxHeight: '80%' }">
      <div class="sheet" data-sheet="moment-ask">
        <div class="sheet-title">让她发一条</div>
        <p class="note">按她今天的节律（此刻在哪、在做什么）、记得的事和最近跟你聊的写；要配图时交给生图画。</p>
        <RouterLink v-if="!status.ok" to="/me/api?feature=social" class="warn-line">{{ status.reason }} →</RouterLink>
        <div class="grid gap-2 mt-3">
          <div v-for="c in chars.list" :key="c.id" class="who">
            <Avatar :character="c" :size="38" />
            <div class="flex-1 min-w-0">
              <div class="text-[14.5px] font-600 truncate">{{ c.name }}</div>
              <div class="text-[12px] line-clamp-2" :class="social.failures[`post:${c.id}`] ? 'text-warn' : 'text-ink-3'">
                {{ social.failures[`post:${c.id}`] ?? (social.characterSettings(c.id).enabled ? `自己也会发 · 每天最多 ${social.characterSettings(c.id).perDay} 条` : '不自动发（只在你点的时候发）') }}
              </div>
            </div>
            <van-button size="small" round type="primary" :loading="!!social.busy[`post:${c.id}`]" :disabled="!status.ok" @click="ask(c)">发一条</van-button>
          </div>
        </div>
        <p class="note">{{ cloudNote }}</p>
      </div>
    </van-popup>

    <!-- 发朋友圈 -->
    <van-popup v-model:show="composing" position="bottom" round teleport="body" :style="{ maxHeight: '92%' }">
      <MomentComposer v-if="composing" @close="composing = false" @sent="composing = false" />
    </van-popup>

    <!-- 评论 -->
    <van-popup :show="!!commenting" position="bottom" round teleport="body" @update:show="(v: boolean) => !v && (commenting = null)">
      <form class="comment-bar" @submit.prevent="sendComment">
        <input ref="input" v-model="draft" class="input flex-1" autocomplete="off" enterkeyhint="send" :placeholder="commentHint" :aria-label="commentHint" data-testid="moment-comment-input" />
        <van-button round type="primary" size="small" native-type="submit" :disabled="!draft.trim()">发送</van-button>
      </form>
    </van-popup>
  </div>
</template>

<style scoped>
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 64px 32px;
  text-align: center;
}
.hint {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 16px 4px;
  padding: 9px 12px;
  border-radius: 12px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 12.5px;
  line-height: 1.5;
  text-decoration: none;
}
.foot {
  margin: 0;
  padding: 18px 16px 28px;
  text-align: center;
  font-size: 12px;
  color: var(--ink-3);
}
.note {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--ink-3);
}
.warn-line {
  display: block;
  margin-top: 8px;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--warn);
  text-decoration: none;
}
.who {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 16px;
  background: var(--panel);
}
.comment-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px calc(var(--safe-bottom) + 12px);
}
</style>
