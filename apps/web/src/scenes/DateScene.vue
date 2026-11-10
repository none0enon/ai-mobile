<script setup lang="ts">
import { showToast } from 'vant';
import { computed, ref } from 'vue';
import CgArt from '@/components/figure/CgArt.vue';
import DialogBox from '@/components/stage/DialogBox.vue';
import SceneShell from '@/components/scene/SceneShell.vue';
import { datePlaces, weather, type DatePlace } from '@/mock/activity';
import { useAppStore } from '@/stores/app';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';

/**
 * 约会：先选地点（她会按天气推荐），然后像视觉小说一样推进：旁白 + 台词 + 选项，
 * 关键时刻请求一张 CG（正式版：生图提示词智能体 + NovelAI），最后生成"约会回忆"。
 */
const app = useAppStore();
const chars = useCharacterStore();
const chat = useChatStore();
const character = computed(() => chars.byId(app.activeCharacterId) ?? chars.list[0]!);

const phase = ref<'pick' | 'date' | 'end'>('pick');
const raining = weather.text.includes('雨');
const recommended = datePlaces.find((p) => p.id === (raining ? 'aquarium' : 'amusement'))!;
const place = ref<DatePlace>(recommended);

interface Node {
  narration: string;
  line: string;
  expression: string;
  choices: string[];
  cg?: boolean;
}
const step = ref(0);
const chosen = ref<string[]>([]);
const cgReady = ref(false);

const nodes = computed<Node[]>(() => [
  {
    narration: `（周六下午，${place.value.name}。${raining ? '外面的雨还没停，' : ''}你们并肩走了进来。）`,
    line: '哇……比我想象的还要好看！',
    expression: 'laugh',
    choices: ['牵起她的手', '给她拍张照', '去买两杯热饮'],
  },
  {
    narration: chosen.value[0] === '牵起她的手' ? '（她愣了一下，手指慢慢扣紧了你的。）' : chosen.value[0] === '给她拍张照' ? '（你举起手机，她下意识地理了理刘海。）' : '（你买回两杯热可可，她捧着杯子小口小口地喝。）',
    line: '……干嘛一直看着我。',
    expression: 'blush',
    choices: ['问她最喜欢哪里', '偷偷看她', '拍照留念'],
  },
  {
    narration: '（你们找了个安静的角落，她靠在你肩上。）',
    line: '今天……谢谢你陪我。这张照片，要存起来。',
    expression: 'shy',
    choices: ['结束约会'],
    cg: true,
  },
]);
const node = computed(() => nodes.value[step.value] ?? nodes.value[0]!);

function start(p: DatePlace) {
  place.value = p;
  phase.value = 'date';
  step.value = 0;
  chosen.value = [];
  cgReady.value = false;
}

function choose(c: string) {
  chosen.value.push(c);
  if (c === '结束约会') {
    phase.value = 'end';
    return;
  }
  step.value = Math.min(step.value + 1, nodes.value.length - 1);
  if (nodes.value[step.value]?.cg) setTimeout(() => (cgReady.value = true), 1800);
}

function saveMemory() {
  const chatId = chat.chatOfCharacter(character.value.id)?.id;
  if (chatId) chat.postCard(chatId, 'assistant', { type: 'date', place: place.value.name, when: '今天', status: 'memory' }, '今天的约会，我存进回忆里啦。');
  showToast('已存进回忆');
}
</script>

<template>
  <!-- 选地点 -->
  <SceneShell
    v-if="phase === 'pick'"
    scene-id="date"
    :backdrop="place.backdrop"
    :rain="raining && !place.indoor"
    outfit="date"
    expression="smile"
    :line="`${raining ? '下雨了…' : '天气真好！'}去${recommended.name}好不好？`"
    :layout="{ left: 78, bottom: 56, height: 32 }"
  >
    <div class="text-[15px] font-600 mb-2.5">今天去哪儿约会？</div>
    <div class="grid grid-cols-4 gap-2">
      <button v-for="p in datePlaces" :key="p.id" class="place press" :class="{ on: place.id === p.id }" :style="{ '--tone': p.tint }" @click="place = p">
        <span class="place-icon"><span :class="p.icon" /></span>
        <span class="text-[12.5px]">{{ p.name }}</span>
        <span v-if="p.id === recommended.id" class="rec">她想去</span>
      </button>
    </div>
    <p class="text-[12.5px] text-ink-3 mt-2.5">{{ place.blurb }} · {{ place.indoor ? '室内' : '室外' }}{{ raining && !place.indoor ? '（在下雨哦）' : '' }}</p>
    <van-button type="primary" round block class="!mt-3" @click="start(place)">出发去{{ place.name }}</van-button>
  </SceneShell>

  <!-- 约会中：视觉小说 -->
  <SceneShell
    v-else-if="phase === 'date'"
    scene-id="date"
    :title="`约会 · ${place.name}`"
    :backdrop="place.backdrop"
    tod="night"
    outfit="date"
    :expression="node.expression"
    :layout="{ left: 50, bottom: 24, height: 66 }"
    class="vn"
  >
    <template #overlay>
      <div class="narration">{{ node.narration }}</div>
      <div v-if="node.cg" class="cg-card">
        <CgArt :character="character" :scene="place.backdrop" expression="shy" outfit="date" ratio="4 / 3" :pending="!cgReady" class="rounded-[14px]" />
        <div class="text-[12px] text-ink-2 mt-1.5 flex items-center gap-1"><span class="i-lucide-wand-sparkles text-accent-ink" />拍照留念 · {{ cgReady ? 'NovelAI 已生成' : '生图提示词智能体正在写 tags…' }}</div>
      </div>
      <DialogBox :name="character.name" :text="node.line" :choices="node.choices" :show-tools="false" @choose="choose" />
    </template>
  </SceneShell>

  <!-- 约会回忆 -->
  <SceneShell v-else scene-id="date" :title="'约会回忆'" :backdrop="place.backdrop" tod="night" outfit="date" expression="smile" hide-figure>
    <div class="text-[17px] font-700">{{ place.name }}的约会</div>
    <div class="text-[12.5px] text-ink-3 mb-3">第 3 次约会 · 已写进记忆，她以后会提起</div>
    <CgArt :character="character" :scene="place.backdrop" expression="shy" outfit="date" ratio="4 / 3" class="rounded-[16px]" />
    <ul class="mt-3 grid gap-1.5 pl-0 list-none">
      <li v-for="(c, i) in chosen.filter((x) => x !== '结束约会')" :key="i" class="flex items-center gap-2 text-[13.5px] text-ink-2">
        <span class="i-lucide-heart text-accent" />{{ c }}
      </li>
    </ul>
    <div class="flex gap-2.5 mt-3.5">
      <van-button round block @click="phase = 'pick'">再约一次</van-button>
      <van-button type="primary" round block @click="saveMemory">存进回忆</van-button>
    </div>
  </SceneShell>
</template>

<style scoped>
.place {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 10px 0 8px;
  border-radius: 14px;
  background: var(--panel);
  color: var(--ink-2);
}
.place.on {
  outline: 1.5px solid var(--tone);
  color: var(--ink);
}
.place-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--tone) 22%, transparent);
  color: var(--tone);
  font-size: 18px;
}
.rec {
  position: absolute;
  top: -6px;
  right: -2px;
  padding: 0 5px;
  border-radius: 6px;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 10px;
  line-height: 16px;
}
.vn :deep(.panel) {
  display: none;
}
.narration {
  position: absolute;
  z-index: 9;
  top: calc(var(--safe-top) + 62px);
  left: 14px;
  right: 14px;
  padding: 8px 12px;
  border-radius: 14px;
  background: var(--glass);
  color: var(--ink-2);
  font-size: 13.5px;
  font-style: italic;
  text-align: center;
}
.cg-card {
  position: absolute;
  z-index: 9;
  top: calc(var(--safe-top) + 112px);
  left: 50%;
  width: 62%;
  transform: translateX(-50%) rotate(-2deg);
  padding: 8px;
  border-radius: 18px;
  background: var(--glass-strong);
  border: 1px solid var(--glass-line);
  box-shadow: var(--shadow);
}
</style>
