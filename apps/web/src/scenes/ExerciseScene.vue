<script setup lang="ts">
import { showToast } from 'vant';
import { computed, onBeforeUnmount, ref } from 'vue';
import { useRouter } from 'vue-router';
import SceneShell from '@/components/scene/SceneShell.vue';
import { mockToday, week } from '@/mock/activity';
import { services } from '@/services';
import { useAppStore } from '@/stores/app';
import { useChatStore } from '@/stores/chat';
import { clock } from '@/utils/time';

/** 一起运动：计时、距离、配速；每公里她给一句；结束后生成运动卡片发进聊天 */
const router = useRouter();
const app = useAppStore();
const chat = useChatStore();
const today = mockToday();

type Phase = 'ready' | 'running' | 'paused' | 'done';
const phase = ref<Phase>('ready');
const sport = ref<'run' | 'walk' | 'ride'>('run');
const elapsed = ref(0);
const voiceOn = ref(true);
const SPEED: Record<string, number> = { run: 2.77, walk: 1.35, ride: 5.2 }; // 米 / 秒
const SPORT_LABEL: Record<string, string> = { run: '跑步', walk: '散步', ride: '骑行' };
/** 演示用：时间加速 30 倍，几秒就能看到"第 1 公里" */
const DEMO_SPEEDUP = 30;

const distanceKm = computed(() => (elapsed.value * (SPEED[sport.value] ?? 2.77)) / 1000);
const pace = computed(() => {
  if (distanceKm.value < 0.01) return `--'--"`;
  const secPerKm = elapsed.value / distanceKm.value;
  return `${Math.floor(secPerKm / 60)}'${String(Math.round(secPerKm % 60)).padStart(2, '0')}"`;
});
const steps = computed(() => today.steps + Math.round(distanceKm.value * 1300));

const KM_LINES = ['第 1 公里！呼吸放慢一点～', '第 2 公里，你比昨天快了！', '第 3 公里……我、我快跟不上了', '第 4 公里，最后坚持一下！', '五公里！！你太厉害了！'];
const line = ref('我也换好运动服啦～今天跑几公里？');
let lastKm = 0;
let timer: ReturnType<typeof setInterval> | undefined;

function tick() {
  elapsed.value += DEMO_SPEEDUP;
  const km = Math.floor(distanceKm.value);
  if (km > lastKm) {
    lastKm = km;
    line.value = KM_LINES[Math.min(km, KM_LINES.length) - 1] ?? '继续加油！';
    if (voiceOn.value) void services.tts.speak(line.value);
    services.native.vibrate(30);
  }
}

function start() {
  phase.value = 'running';
  line.value = '出发！我在你旁边哦。';
  void services.native.keepAwake(true);
  clearInterval(timer);
  timer = setInterval(tick, 1000);
}
function pause() {
  phase.value = 'paused';
  clearInterval(timer);
  line.value = '累了就走一会儿，我陪你。';
}
function finish() {
  phase.value = 'done';
  clearInterval(timer);
  void services.native.keepAwake(false);
  line.value = distanceKm.value >= 1 ? '辛苦啦！这次我记下来了，回去要拉伸哦。' : '才这么一点点？……算了，今天放过你。';
}
function share() {
  const chatId = chat.chatOfCharacter(app.activeCharacterId)?.id;
  if (!chatId) return;
  chat.postCard(chatId, 'user', {
    type: 'workout',
    logId: `w-${Date.now()}`,
    sport: SPORT_LABEL[sport.value] ?? '跑步',
    distanceKm: Number(distanceKm.value.toFixed(2)),
    durationSec: elapsed.value,
    pace: pace.value,
  });
  chat.leaveScene(app.activeCharacterId, `一起${SPORT_LABEL[sport.value] ?? '跑步'} ${distanceKm.value.toFixed(2)} km`);
  void chat.generate(chatId);
  void router.push(`/chat/${chatId}`);
}
onBeforeUnmount(() => {
  clearInterval(timer);
  void services.native.keepAwake(false);
});

const sourcesOpen = ref(false);
const SOURCES = [
  { icon: 'i-lucide-timer', title: 'App 内记录', desc: '就是这个页面：计时 + GPS。安卓壳里用前台服务，锁屏也不断。' },
  { icon: 'i-lucide-smartphone', title: '安卓计步 / Health Connect', desc: '原生桥读取计步传感器和 Health Connect 的运动、睡眠记录。' },
  { icon: 'i-lucide-workflow', title: 'iPhone 快捷指令', desc: '快捷指令定时（或运动结束时）把健康数据推给你的 Worker。' },
  { icon: 'i-lucide-scan-text', title: '运动截图识别', desc: 'Keep、华为、小米运动的截图交给视觉模型，读出距离和时长。' },
];
const maxSteps = Math.max(...week.steps);
</script>

<template>
  <SceneShell scene-id="exercise" :line="line" :expression="phase === 'running' ? 'laugh' : 'smile'" :layout="{ left: 74, bottom: 47, height: 36 }">
    <template #actions>
      <button class="pill-btn" @click="sourcesOpen = true"><span class="i-lucide-database" />数据来源</button>
    </template>

    <div class="flex gap-2 mb-3">
      <button v-for="s in (['run', 'walk', 'ride'] as const)" :key="s" class="seg" :class="{ on: sport === s }" :disabled="phase === 'running'" @click="sport = s">
        {{ SPORT_LABEL[s] }}
      </button>
      <span class="ml-auto chip !bg-transparent">演示 ×{{ DEMO_SPEEDUP }} 倍速</span>
    </div>

    <div class="grid grid-cols-2 gap-2.5">
      <div class="stat"><div class="v num">{{ clock(elapsed) }}</div><div class="k">时长</div></div>
      <div class="stat"><div class="v num">{{ distanceKm.toFixed(2) }}</div><div class="k">公里</div></div>
      <div class="stat"><div class="v num">{{ pace }}</div><div class="k">配速 / 公里</div></div>
      <div class="stat"><div class="v num">{{ steps.toLocaleString('zh-CN') }}</div><div class="k">今日步数</div></div>
    </div>

    <div class="flex gap-2.5 mt-3.5">
      <van-button v-if="phase === 'ready'" type="primary" round block @click="start">开始一起{{ SPORT_LABEL[sport] }}</van-button>
      <template v-else-if="phase === 'running'">
        <van-button round block @click="pause">暂停</van-button>
        <van-button type="primary" round block @click="finish">结束</van-button>
      </template>
      <template v-else-if="phase === 'paused'">
        <van-button type="primary" round block @click="start">继续</van-button>
        <van-button round block @click="finish">结束</van-button>
      </template>
      <template v-else>
        <van-button round block @click="(phase = 'ready'), (elapsed = 0), (lastKm = 0)">再来一次</van-button>
        <van-button type="primary" round block @click="share">发给她看</van-button>
      </template>
    </div>

    <div class="flex items-center justify-between mt-3.5">
      <div>
        <div class="text-[14px]">她的语音陪跑</div>
        <div class="text-[12px] text-ink-3">每公里播报一次，结束时总结</div>
      </div>
      <van-switch v-model="voiceOn" size="22px" />
    </div>

    <div class="mt-4">
      <div class="flex justify-between text-[12.5px] text-ink-3 mb-1.5">
        <span>最近 7 天步数</span><span>目标 {{ today.stepGoal.toLocaleString('zh-CN') }}</span>
      </div>
      <div class="bars">
        <div v-for="(v, i) in week.steps" :key="i" class="bar-col">
          <div class="bar" :class="{ hit: v >= today.stepGoal }" :style="{ height: `${(v / maxSteps) * 100}%` }" />
          <span class="text-[11px] text-ink-3">{{ week.labels[i] }}</span>
        </div>
      </div>
    </div>

    <van-popup v-model:show="sourcesOpen" position="bottom" round>
      <div class="p-4 pb-6">
        <div class="text-[16px] font-600 mb-1">运动数据从哪来</div>
        <div class="text-[12.5px] text-ink-3 mb-3">发现新的运动记录，她会主动来夸你（或吐槽你）</div>
        <div v-for="s in SOURCES" :key="s.title" class="flex gap-3 py-2.5">
          <span class="src-icon"><span :class="s.icon" /></span>
          <div>
            <div class="text-[14.5px] font-600">{{ s.title }}</div>
            <div class="text-[13px] text-ink-2 leading-relaxed">{{ s.desc }}</div>
          </div>
        </div>
        <van-button block round class="!mt-2" @click="showToast('M6 接入')">上传运动截图</van-button>
      </div>
    </van-popup>
  </SceneShell>
</template>

<style scoped>
.pill-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 38px;
  padding: 0 12px;
  border-radius: 99px;
  background: var(--glass);
  border: 1px solid var(--glass-line);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  font-size: 13px;
}
.seg {
  height: 32px;
  padding: 0 14px;
  border-radius: 99px;
  background: var(--panel);
  font-size: 13.5px;
  color: var(--ink-2);
}
.seg.on {
  background: var(--accent);
  color: var(--on-accent);
  font-weight: 600;
}
.stat {
  padding: 10px 12px;
  border-radius: 16px;
  background: var(--panel);
}
.stat .v {
  font-size: 24px;
  font-weight: 700;
  line-height: 1.15;
}
.stat .k {
  font-size: 12px;
  color: var(--ink-3);
}
.bars {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 8px;
  height: 84px;
}
.bar-col {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
}
.bar {
  width: 100%;
  max-width: 22px;
  border-radius: 6px 6px 3px 3px;
  background: var(--panel-2);
}
.bar.hit {
  background: #7fd1b1;
}
.src-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border-radius: 12px;
  background: var(--panel);
  color: #7fd1b1;
  font-size: 19px;
  flex-shrink: 0;
}
</style>
