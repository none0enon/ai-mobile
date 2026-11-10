<script setup lang="ts">
import { worldOf } from '@app/shared';
import { showToast } from 'vant';
import { computed, inject, ref } from 'vue';
import ImagePick from '@/components/common/ImagePick.vue';
import HerSide from '@/components/scene/HerSide.vue';
import { SCENE_LOCATION } from '@/components/scene/location';
import SceneShell from '@/components/scene/SceneShell.vue';
import { mockToday } from '@/mock/activity';
import { envSettings } from '@/mock/settings';
import { services } from '@/services';
import { useAppStore } from '@/stores/app';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';
import { hhmm } from '@/utils/time';
import { compressImage } from '@/utils/image';

/**
 * 一起吃饭（默认"饭搭子"）：各吃各的，但同时开饭。
 * 饭点前她先暗示、超时再邀约；开饭后你拍你的饭（识图认出是什么），她也"拍"她那边的（正式版用生图画）；可以碰个杯。
 * 带她去真实的餐厅时她坐你对面；去她那时她给你做饭。吃完记一顿，她记住你的口味。
 */
const app = useAppStore();
const chars = useCharacterStore();
const chat = useChatStore();
const location = inject(SCENE_LOCATION, ref(null));
const today = mockToday();
type Slot = 'breakfast' | 'lunch' | 'dinner';
const meals = ref({ ...today.meals });
const LABEL: Record<Slot, string> = { breakfast: '早饭', lunch: '午饭', dinner: '晚饭' };

const her = computed(() => chars.byId(app.activeCharacterId) ?? chars.list[0]!);
const mode = computed(() => chat.chatOfCharacter(her.value.id)?.togetherMode ?? 'remote');
/** 下一顿还没吃的饭 */
const next = computed<Slot>(() => (['breakfast', 'lunch', 'dinner'] as Slot[]).find((s) => !meals.value[s]) ?? 'dinner');
/** 她这一顿吃什么：去她那时是她做给你的，带她出门时和你吃一样的 */
const herMeal = computed(() => (mode.value === 'bring' ? `和你吃一样的（${location.value?.name ?? '这家店'}）` : worldOf(her.value.id).life.meals[next.value]));

const phase = ref<'hint' | 'eating' | 'done'>('hint');
const line = ref(
  mode.value === 'bring'
    ? `这家店看起来不错！你点了什么？`
    : mode.value === 'visit'
      ? `我给你煮了${worldOf(her.value.id).life.meals[next.value]}，趁热尝尝？`
      : `我准备去吃${LABEL[next.value]}了……你${LABEL[next.value]}吃了吗？`,
);
const food = ref('');
const photo = ref<string | null>(null);
const guessed = ref('');
const cheers = ref(0);

function eatTogether() {
  phase.value = 'eating';
  line.value = mode.value === 'remote' ? `那我们一起开饭！我这边是${herMeal.value}，你那边吃的什么？拍给我看看～` : '开动！你那边拍一张给我看看～';
}
async function onPhoto(file: File) {
  try {
    photo.value = await compressImage(file, { max: 720 });
    // 正式版：交给识图智能体认出是什么菜，她据此点评、记住口味
    guessed.value = '豚骨拉面';
    food.value = guessed.value;
    line.value = '看起来好香！不过……怎么又是面？下次我带你去吃砂锅粥。';
  } catch {
    showToast('这张图读不出来，换一张试试');
  }
}
function demoPhoto() {
  guessed.value = '豚骨拉面';
  food.value = guessed.value;
  line.value = '看起来好香！不过……怎么又是面？下次我带你去吃砂锅粥。';
}
function clink() {
  cheers.value += 1;
  services.native.vibrate(20);
  line.value = cheers.value === 1 ? '干杯～慢慢吃，别吃太快。' : '又碰？你是不是想我了（笑）';
}
function record() {
  const f = food.value.trim() || '番茄炒蛋盖饭';
  meals.value[next.value] = { food: f, at: hhmm(Date.now()) };
  phase.value = 'done';
  line.value = '吃饱啦～我也吃完了。记住了，你喜欢吃这个。';
  const chatId = chat.chatOfCharacter(her.value.id)?.id;
  if (chatId) chat.postCard(chatId, 'user', { type: 'meal', logId: `meal-${Date.now()}`, meal: next.value, food: f, photo: null });
  food.value = '';
}
</script>

<template>
  <SceneShell scene-id="meal" :line="line" :pose="phase === 'eating' ? 'eat' : 'sit'" :expression="phase === 'hint' ? 'shy' : 'laugh'" :layout="{ left: 50, bottom: 44, height: 46 }">
    <HerSide :label="phase === 'hint' ? '准备吃：' : '在吃：'" :content="herMeal" :extra="phase === 'eating' && mode === 'remote' ? `${her.pronoun}拍了一张给你（正式版用生图画出来）` : ''" />

    <div class="grid grid-cols-3 gap-2 mt-3">
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
      <van-button round block @click="phase = 'eating'">吃过了，记一下</van-button>
    </div>
    <template v-else-if="phase === 'eating'">
      <div class="flex gap-2.5 mt-3.5">
        <ImagePick class="photo press" data-upload="meal-photo" @pick="onPhoto">
          <img v-if="photo" :src="photo" alt="你的饭" class="photo-img" />
          <template v-else-if="guessed"><span class="i-lucide-soup text-[28px]" /><span>已发给{{ her.pronoun }}</span></template>
          <template v-else><span class="i-lucide-camera text-[22px]" /><span>拍你的饭给{{ her.pronoun }}看</span></template>
        </ImagePick>
        <button class="clink press" aria-label="碰杯" @click="clink">
          <span class="i-lucide-cup-soda text-[24px]" /><span>碰个杯{{ cheers ? ` ×${cheers}` : '' }}</span>
        </button>
      </div>
      <div class="text-[12px] text-ink-3 mt-1.5">
        <template v-if="guessed">识图：看起来是{{ guessed }} · {{ her.pronoun }}会记住你的口味</template>
        <button v-else class="text-accent-ink" @click="demoPhoto">手边没有饭？用演示照片</button>
      </div>
      <div class="flex gap-2 mt-2.5">
        <input v-model="food" class="field" placeholder="这顿吃了什么？（例如：番茄炒蛋盖饭）" aria-label="这顿吃了什么" />
        <van-button type="primary" round @click="record">吃完了</van-button>
      </div>
    </template>
    <div v-else class="text-center text-[13.5px] text-ink-2 mt-3">已记录 · {{ her.pronoun }}会记住你的口味，下次推荐给你</div>

    <p class="text-[12px] text-ink-3 mt-3.5 leading-relaxed">
      饭点前后{{ her.pronoun }}会先暗示、超时再正式邀约。三餐时间在
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
  position: relative;
  flex: 1;
  height: 92px;
  overflow: hidden;
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
.photo-img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.clink {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 96px;
  height: 92px;
  border-radius: 18px;
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: 13px;
  flex-shrink: 0;
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
