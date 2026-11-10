<script setup lang="ts">
import { computed, ref } from 'vue';
import SceneShell from '@/components/scene/SceneShell.vue';
import { mockToday } from '@/mock/activity';
import { envSettings } from '@/mock/settings';
import { useAppStore } from '@/stores/app';
import { useChatStore } from '@/stores/chat';
import { hhmm } from '@/utils/time';

/**
 * 一起吃饭：饭点前后她先暗示、超时再邀约；进入后餐桌背景、她也在吃；可以拍饭照让她点评。
 */
const app = useAppStore();
const chat = useChatStore();
const today = mockToday();
type Slot = 'breakfast' | 'lunch' | 'dinner';
const meals = ref({ ...today.meals });
const LABEL: Record<Slot, string> = { breakfast: '早饭', lunch: '午饭', dinner: '晚饭' };

/** 下一顿还没吃的饭 */
const next = computed<Slot>(() => (['breakfast', 'lunch', 'dinner'] as Slot[]).find((s) => !meals.value[s]) ?? 'dinner');
const phase = ref<'hint' | 'eating' | 'done'>('hint');
const line = ref(`我有点饿了……你${LABEL[next.value]}吃了吗？`);
const food = ref('');
const photoShown = ref(false);

function eatTogether() {
  phase.value = 'eating';
  line.value = '那我们一起吃！你那边吃的什么？拍给我看看～';
}
function sendPhoto() {
  photoShown.value = true;
  line.value = '看起来好香！不过……怎么又是面？下次我带你去吃砂锅粥。';
}
function record() {
  const f = food.value.trim() || '番茄炒蛋盖饭';
  meals.value[next.value] = { food: f, at: hhmm(Date.now()) };
  phase.value = 'done';
  line.value = '吃饱啦～我也吃完了。记住了，你喜欢吃这个。';
  const chatId = chat.chatOfCharacter(app.activeCharacterId)?.id;
  if (chatId) chat.postCard(chatId, 'user', { type: 'meal', logId: `meal-${Date.now()}`, meal: next.value, food: f, photo: null });
  food.value = '';
}
</script>

<template>
  <SceneShell scene-id="meal" :line="line" :pose="phase === 'eating' ? 'eat' : 'sit'" :expression="phase === 'hint' ? 'shy' : 'laugh'" :layout="{ left: 50, bottom: 44, height: 46 }">
    <div class="grid grid-cols-3 gap-2">
      <div v-for="s in (['breakfast', 'lunch', 'dinner'] as Slot[])" :key="s" class="meal" :class="{ done: meals[s], next: !meals[s] && s === next }">
        <div class="flex items-center gap-1 text-[13px] font-600">
          <span :class="meals[s] ? 'i-lucide-circle-check' : 'i-lucide-circle-dashed'" />{{ LABEL[s] }}
        </div>
        <div class="text-[12px] text-ink-2 truncate mt-1">{{ meals[s]?.food ?? (s === next ? '还没吃' : '—') }}</div>
        <div class="text-[11px] text-ink-3 num">{{ meals[s]?.at ?? `${envSettings.meals[s].start}-${envSettings.meals[s].end}` }}</div>
      </div>
    </div>

    <div v-if="phase === 'hint'" class="flex gap-2.5 mt-3.5">
      <van-button type="primary" round block @click="eatTogether">一起吃{{ LABEL[next] }}</van-button>
      <van-button round block @click="phase = 'eating'">我吃过了，记一下</van-button>
    </div>
    <template v-else-if="phase === 'eating'">
      <button class="photo press" @click="sendPhoto">
        <template v-if="!photoShown"><span class="i-lucide-camera text-[22px]" /><span>拍饭照给她看</span></template>
        <template v-else><span class="i-lucide-soup text-[30px]" /><span>已发送 · 视觉模型看过了</span></template>
      </button>
      <div class="flex gap-2 mt-3">
        <input v-model="food" class="field" placeholder="这顿吃了什么？（例如：番茄炒蛋盖饭）" aria-label="这顿吃了什么" />
        <van-button type="primary" round @click="record">记下</van-button>
      </div>
    </template>
    <div v-else class="text-center text-[13.5px] text-ink-2 mt-3">已记录 · 她会记住你的口味，下次推荐给你</div>

    <p class="text-[12px] text-ink-3 mt-3.5 leading-relaxed">
      饭点前后她会先暗示、超时再正式邀约。三餐时间在
      <RouterLink to="/me/environment" class="text-accent-ink">环境与作息</RouterLink> 里改。
    </p>
  </SceneShell>
</template>

<style scoped>
.meal {
  padding: 10px;
  border-radius: 14px;
  background: var(--panel);
  color: var(--ink-3);
}
.meal.done {
  color: var(--good);
}
.meal.next {
  outline: 1.5px solid var(--accent-line);
  color: var(--accent-ink);
}
.photo {
  margin-top: 14px;
  width: 100%;
  height: 92px;
  border-radius: 18px;
  border: 1.5px dashed var(--border);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: var(--ink-2);
  font-size: 13.5px;
}
.field {
  flex: 1;
  min-width: 0;
  height: 40px;
  padding: 0 14px;
  border-radius: 20px;
  border: 1px solid var(--border);
  background: var(--panel);
  outline: none;
}
</style>
