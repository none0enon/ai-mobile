<script setup lang="ts">
import { EXPRESSION_LABELS, EXPRESSIONS, OUTFITS, type PokeHotspot } from '@app/shared';
import { showToast } from 'vant';
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import Avatar from '@/components/common/Avatar.vue';
import ImagePick from '@/components/common/ImagePick.vue';
import Segmented from '@/components/common/Segmented.vue';
import CharacterFigure from '@/components/figure/CharacterFigure.vue';
import PresetPicker from '@/components/settings/PresetPicker.vue';
import StageView from '@/components/stage/StageView.vue';
import PageHeader from '@/layouts/PageHeader.vue';
import { FIGURE } from '@/mock/characters';
import { pokeHotspots } from '@/mock/library';
import { presetFor } from '@/services/prompt';
import { useLibraryStore } from '@/stores/library';
import { useAppearanceStore } from '@/stores/appearance';
import { useCharacterStore } from '@/stores/characters';

const route = useRoute();
const chars = useCharacterStore();
const lib = useLibraryStore();
const looks = useAppearanceStore();
async function pickAvatar(file: File) {
  try {
    showToast((await looks.pickAvatar('character', character.value.id, file)) ? '头像换好了' : '换好了，但本机存储不够，下次打开会恢复原样');
  } catch {
    showToast('这张图读不出来，换一张试试');
  }
}
const character = computed(() => chars.byId(route.params.id as string) ?? chars.list[0]!);
const figure = computed(() => FIGURE[character.value.id] ?? { hairStyle: 'long' as const, eye: '#3b2531' });
/** 和她聊天时实际用的预设（同拼提示词） */
const presetId = computed(() => presetFor(character.value).id);
function pickPreset(id: string) {
  if (id === presetId.value) return;
  chars.setPreset(character.value.id, id);
  showToast(`换成「${lib.presetById(id)?.name ?? ''}」了`);
}
const TABS = ['basic', 'persona', 'greeting', 'example', 'lore', 'preset', 'sprite', 'voice', 'proactive', 'look'] as const;
const tab = ref<string>(TABS.includes(route.query.tab as (typeof TABS)[number]) ? (route.query.tab as string) : 'basic');
const ACCENTS = ['#f5b8a6', '#f39cc0', '#b7a6f5', '#8ec5e8', '#7fd1b1', '#f2c66d'];
const outfit = ref('daily');
const selectedZone = ref<PokeHotspot | null>(pokeHotspots[0] ?? null);
const PERSONALITY = { clingy: '粘人', balanced: '适中', independent: '独立' } as const;
</script>

<template>
  <div class="page" data-page="character-edit">
    <PageHeader :title="`编辑 · ${character.name}`" subtitle="字段与 SillyTavern 角色卡一一对应" fallback="/me/characters">
      <template #right>
        <button class="icon-btn" aria-label="导出角色卡" @click="showToast('M1：导出 PNG（同时写入 chara 与 ccv3）')"><span class="i-lucide-share text-[19px]" /></button>
      </template>
    </PageHeader>
    <div class="page-scroll pb-10">
      <div class="hero mx-4 mt-3" :style="{ '--tone': character.accent }">
        <ImagePick class="ava-pick" :aria-label="`给${character.name}换头像`" @pick="pickAvatar">
          <Avatar :character="character" :size="64" live />
          <span class="ava-badge"><span class="i-lucide-camera" /></span>
        </ImagePick>
        <div class="flex-1 min-w-0">
          <div class="text-[20px] font-700">{{ character.name }}</div>
          <div class="text-[12.5px] text-ink-3">v{{ character.card.characterVersion }} · {{ character.card.creator }}</div>
          <div class="flex gap-1.5 mt-2">
            <button v-for="a in ACCENTS" :key="a" class="swatch" :class="{ on: character.accent === a }" :style="{ background: a }" :aria-label="`主题色 ${a}`" @click="character.accent = a" />
          </div>
        </div>
      </div>

      <van-tabs v-model:active="tab" class="mt-2" shrink swipeable :line-width="20">
        <van-tab title="基本" name="basic">
          <div class="px-4">
            <label class="field-label" for="ce-name">名字</label>
            <input id="ce-name" v-model="character.name" class="input" />
            <label class="field-label">界面里怎么称呼（导入的角色卡没有这一项，要自己选）</label>
            <Segmented
              v-model="character.pronoun"
              :options="[
                { value: '她', label: '她' },
                { value: '他', label: '他' },
                { value: 'TA', label: 'TA' },
              ]"
            />
            <label class="field-label" for="ce-status">状态行（{{ character.pronoun }}此刻在做什么，模拟作息会自动更新）</label>
            <input id="ce-status" v-model="character.status" class="input" />
            <label class="field-label">标签</label>
            <div class="flex flex-wrap gap-1.5"><span v-for="t in character.card.tags" :key="t" class="tag">{{ t }}</span></div>
            <label class="field-label" for="ce-notes">作者备注（creator_notes，不发给模型）</label>
            <textarea id="ce-notes" v-model="character.card.creatorNotes" class="textarea" />
          </div>
        </van-tab>
        <van-tab title="人设" name="persona">
          <div class="px-4">
            <label class="field-label" for="ce-desc">描述 description</label>
            <textarea id="ce-desc" v-model="character.card.description" class="textarea" rows="5" />
            <label class="field-label" for="ce-pers">性格 personality</label>
            <textarea id="ce-pers" v-model="character.card.personality" class="textarea" />
            <label class="field-label" for="ce-scen">场景 scenario</label>
            <textarea id="ce-scen" v-model="character.card.scenario" class="textarea" />
          </div>
        </van-tab>
        <van-tab title="开场白" name="greeting">
          <div class="px-4">
            <label class="field-label" for="ce-first">开场白 first_mes</label>
            <textarea id="ce-first" v-model="character.card.firstMes" class="textarea" />
            <label class="field-label">备选开场白 alternate_greetings（新开聊天时可以左右切换）</label>
            <div v-for="(g, i) in character.card.alternateGreetings" :key="i" class="alt">{{ g }}</div>
            <button class="text-accent-ink text-[13px] mt-2"><span class="i-lucide-plus" /> 添加一条</button>
          </div>
        </van-tab>
        <van-tab title="示例" name="example">
          <div class="px-4">
            <label class="field-label" for="ce-ex">示例对话 mes_example（用 &lt;START&gt; 分段）</label>
            <textarea id="ce-ex" v-model="character.card.mesExample" class="textarea mono" rows="8" />
          </div>
        </van-tab>
        <van-tab title="世界书" name="lore">
          <div class="px-4 pt-3 grid gap-2">
            <label v-for="b in lib.lorebooks" :key="b.id" class="pick">
              <van-checkbox :model-value="character.lorebookIds.includes(b.id)" icon-size="18px" @update:model-value="(v: boolean) => (character.lorebookIds = v ? [...character.lorebookIds, b.id] : character.lorebookIds.filter((x) => x !== b.id))" />
              <div class="flex-1 min-w-0">
                <div class="text-[14.5px]">{{ b.name }}</div>
                <div class="text-[12px] text-ink-3">{{ b.entries.length }} 条 · {{ b.description }}</div>
              </div>
              <RouterLink :to="`/me/lorebooks/${b.id}`" class="text-accent-ink text-[13px]">编辑</RouterLink>
            </label>
            <p class="text-[12px] text-ink-3 m-0">导入角色卡时，卡里内嵌的 character_book 会拆成一本独立的世界书并自动绑定。</p>
          </div>
        </van-tab>
        <van-tab title="预设" name="preset">
          <div class="px-4 pt-3">
            <PresetPicker :model-value="presetId" @update:model-value="pickPreset" />
            <p class="text-[12px] text-ink-3 mt-2.5 mb-0 leading-relaxed">和{{ character.pronoun }}聊天时按这套预设拼提示词（提示词顺序、采样参数、正则），下一条回复起生效。在聊天右上角 ⋯ → 预设 里也能换。</p>
          </div>
        </van-tab>
        <van-tab title="立绘" name="sprite">
          <div class="px-4">
            <div class="flex gap-1.5 mt-3 overflow-x-auto hide-scrollbar">
              <button v-for="(label, key) in OUTFITS" :key="key" class="opt" :class="{ on: outfit === key }" @click="outfit = key">{{ label }}</button>
            </div>
            <div class="grid grid-cols-4 gap-2 mt-3">
              <div v-for="e in EXPRESSIONS" :key="e" class="expr">
                <div class="expr-img">
                  <CharacterFigure :accent="character.accent" :hair="character.hairColor" :eye="figure.eye" :hair-style="figure.hairStyle" :expression="e" :outfit="outfit" crop="head" />
                </div>
                <span class="text-[11.5px] text-ink-2">{{ EXPRESSION_LABELS[e] }}</span>
              </div>
            </div>
            <van-button round block class="!mt-3" icon="photo-o" @click="showToast('M1：按文件名自动归类')">批量导入（{服装}_{姿势}_{表情}.webp）</van-button>
            <p class="text-[12px] text-ink-3">也兼容 SillyTavern 的表情立绘文件夹（joy / sadness … 28 种标签自动映射）。只有有图的表情会写进给模型的提示。</p>

            <div class="text-[14px] font-600 mt-4 mb-2">戳戳乐热区</div>
            <div class="zone-preview">
              <StageView :character="character" expression="smile" :outfit="outfit" backdrop="room" pokeable show-hotspots :layout="{ left: 50, bottom: 0, height: 100 }" @poke="(h) => (selectedZone = h)" />
            </div>
            <div v-if="selectedZone" class="zone-info">
              <div class="flex items-center gap-2">
                <span class="tag accent">{{ selectedZone.label }}</span>
                <span class="text-[12px] text-ink-3">单击 → {{ EXPRESSION_LABELS[selectedZone.tap.expression as 'smile'] ?? selectedZone.tap.expression }}<template v-if="selectedZone.longPress"> · 长按 → {{ EXPRESSION_LABELS[selectedZone.longPress.expression as 'smile'] ?? '' }}</template></span>
              </div>
              <div class="flex flex-wrap gap-1.5 mt-2">
                <span v-for="l in selectedZone.tap.lines" :key="l" class="tag">{{ l }}</span>
              </div>
            </div>
            <p class="text-[12px] text-ink-3">点虚线框选中热区；M1 起可以在立绘上直接拖动画多边形。坐标相对立绘，换图分辨率也不用重画。</p>
          </div>
        </van-tab>
        <van-tab title="语音" name="voice">
          <div class="px-4">
            <label class="field-label">音色</label>
            <div class="pick"><span class="i-lucide-audio-lines text-accent-ink" /><span class="flex-1">{{ character.voice.voiceLabel }}</span><span class="text-[12px] text-ink-3">硅基流动 CosyVoice</span></div>
            <label class="field-label">语速 {{ character.voice.speed.toFixed(2) }}×</label>
            <van-slider v-model="character.voice.speed" :min="0.5" :max="2" :step="0.05" bar-height="4px" button-size="18px" />
            <label class="field-label">表情 → 语气（合成时带上情绪参数）</label>
            <div class="flex flex-wrap gap-1.5">
              <span v-for="(v, k) in character.voice.emotionMap" :key="k" class="tag">{{ EXPRESSION_LABELS[k as 'smile'] ?? k }} → {{ v }}</span>
            </div>
            <van-button round block class="!mt-4" @click="showToast('M4 接入 TTS')">试听</van-button>
          </div>
        </van-tab>
        <van-tab title="主动" name="proactive">
          <van-cell-group inset class="!mt-3">
            <van-cell title="会主动找你" center><template #right-icon><van-switch v-model="character.proactive.enabled" size="22px" /></template></van-cell>
            <van-cell title="性格" :value="PERSONALITY[character.proactive.personality]" label="决定频率，以及没回复时会不会追发" />
            <van-cell title="每天最多" center>
              <template #right-icon><van-stepper v-model="character.proactive.dailyCap" min="1" max="12" /></template>
            </van-cell>
            <van-cell title="勿扰时段" :value="`${character.proactive.quietHours.start} - ${character.proactive.quietHours.end}`" />
            <van-cell title="允许主动来电" center><template #right-icon><van-switch v-model="character.proactive.allowCalls" size="22px" /></template></van-cell>
            <van-cell title="允许主动发自拍" label="用 NovelAI 生成" center><template #right-icon><van-switch v-model="character.proactive.allowSelfies" size="22px" /></template></van-cell>
            <van-cell title="触发规则和推送通道" is-link to="/me/proactive" />
          </van-cell-group>
        </van-tab>
        <van-tab title="外观 tags" name="look">
          <div class="px-4">
            <label class="field-label" for="ce-tags">NovelAI 外观基础 tags（生图提示词智能体会在此基础上补动作、服装、场景）</label>
            <textarea id="ce-tags" v-model="character.appearanceTags" class="textarea mono" rows="4" />
            <label class="field-label" for="ce-neg">负面 tags</label>
            <textarea id="ce-neg" v-model="character.negativeTags" class="textarea mono" rows="2" />
            <van-button round block class="!mt-4" @click="showToast('M5 接入 NovelAI')">用这些 tags 试画一张</van-button>
          </div>
        </van-tab>
      </van-tabs>
    </div>
  </div>
</template>

<style scoped>
.ava-pick {
  position: relative;
  flex-shrink: 0;
}
.ava-badge {
  position: absolute;
  right: -2px;
  bottom: -2px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 13px;
  box-shadow: 0 0 0 2px var(--surface);
}
.hero {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px;
  border-radius: 20px;
  background: var(--surface);
  border: 1px solid var(--border);
}
.swatch {
  width: 24px;
  height: 24px;
  border-radius: 50%;
}
.swatch.on {
  box-shadow:
    0 0 0 2px var(--bg),
    0 0 0 4px var(--ink-2);
}
.alt {
  padding: 10px 12px;
  margin-bottom: 6px;
  border-radius: 12px;
  background: var(--panel);
  font-size: 14px;
}
.mono {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 13.5px;
}
.pick {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 14px;
  background: var(--panel);
}
.opt {
  height: 30px;
  padding: 0 12px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 13px;
  white-space: nowrap;
}
.opt.on {
  background: var(--accent);
  color: var(--on-accent);
  font-weight: 600;
}
.expr {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}
.expr-img {
  width: 100%;
  aspect-ratio: 1;
  border-radius: 14px;
  overflow: hidden;
  background: var(--panel);
}
.zone-preview {
  position: relative;
  height: 330px;
  border-radius: 18px;
  overflow: hidden;
}
.zone-info {
  margin-top: 10px;
  padding: 10px 12px;
  border-radius: 14px;
  background: var(--panel);
}
</style>
