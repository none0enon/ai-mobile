<script setup lang="ts">
import { EXPRESSION_LABELS, EXPRESSIONS, imageAppearance, isFandom, OUTFITS, WEATHER_PROVIDER_LABEL, type PokeHotspot, type WeatherProviderChoice } from '@app/shared';
import { showImagePreview, showToast } from 'vant';
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AssetImg from '@/components/common/AssetImg.vue';
import Avatar from '@/components/common/Avatar.vue';
import ErrorDetails from '@/components/common/ErrorDetails.vue';
import HScroll from '@/components/common/HScroll.vue';
import ImagePick from '@/components/common/ImagePick.vue';
import Segmented from '@/components/common/Segmented.vue';
import CharacterFigure from '@/components/figure/CharacterFigure.vue';
import PresetPicker from '@/components/settings/PresetPicker.vue';
import Live2DSettings from '@/components/settings/Live2DSettings.vue';
import StageView from '@/components/stage/StageView.vue';
import PageHeader from '@/layouts/PageHeader.vue';
import { FIGURE } from '@/mock/characters';
import { pokeHotspots } from '@/mock/library';
import { assetUrl, services, type IllustrateOutcome } from '@/services';
import { presetFor } from '@/services/prompt';
import { useAiStore } from '@/stores/ai';
import { useLibraryStore } from '@/stores/library';
import { useAppearanceStore } from '@/stores/appearance';
import { useCharacterStore } from '@/stores/characters';
import { useRhythmStore } from '@/stores/rhythm';
import { useServicesStore } from '@/stores/services';
import { useWeatherStore } from '@/stores/weather';
import { errorReport, errorText } from '@app/ai';

const route = useRoute();
const router = useRouter();
const ai = useAiStore();
const rhythm = useRhythmStore();
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
/** 和她平时聊天用的对话预设（同拼提示词）；一起做事时用各自的功能预设 */
const presetId = computed(() => presetFor(character.value)?.id ?? null);
function pickPreset(id: string | null) {
  if (!id || id === presetId.value) return;
  chars.setPreset(character.value.id, id);
  showToast(`换成「${lib.presetById(id)?.name ?? ''}」了`);
}
// —— 生图：同人还是原创（设计文档 §10.4）——
/** 同人标记：打开时第一次补上空的角色 tag、作品 tag */
const fandomOn = computed({
  get: () => !!character.value.fandom?.enabled,
  set: (v: boolean) => {
    const c = character.value;
    c.fandom = { characterTag: c.fandom?.characterTag ?? '', copyrightTag: c.fandom?.copyrightTag ?? '', enabled: v };
    c.updatedAt = Date.now();
  },
});
function setFandom(field: 'characterTag' | 'copyrightTag', v: string) {
  const c = character.value;
  c.fandom = { enabled: c.fandom?.enabled ?? true, characterTag: c.fandom?.characterTag ?? '', copyrightTag: c.fandom?.copyrightTag ?? '', [field]: v };
  c.updatedAt = Date.now();
}
/** 生图时实际加在最前面的长相 */
const appearanceLine = computed(() => imageAppearance(character.value));
const imageLive = computed(() => ai.status('image').live);
/** 今天穿的那套（节律）：试画时也穿它 */
const todayOutfit = computed(() => rhythm.outfitFor(character.value.id, null));

const trial = ref<{ out?: IllustrateOutcome; error?: string; detail?: string; busy: boolean } | null>(null);
/** 试画一张：白底全身像，看看 NovelAI 认不认得她（同人）/ 外观 tags 画出来像不像（原创） */
async function trialDraw() {
  if (trial.value?.busy) return;
  if (!imageLive.value) {
    void router.push('/me/api?feature=image');
    return;
  }
  const c = character.value;
  trial.value = { busy: true };
  try {
    const out = await services.image.illustrate({
      characterId: c.id,
      mode: 'portrait',
      caption: `${c.name}的全身像：白色背景，站着看向镜头，表情自然${isFandom(c) ? '；看看画出来是不是原作里的样子' : ''}`,
      lockOutfit: !!todayOutfit.value,
    });
    trial.value = { busy: false, out };
  } catch (e) {
    trial.value = { busy: false, error: errorText(e), detail: errorReport(e) };
  }
}
async function openTrial() {
  const out = trial.value?.out;
  const url = out?.assetKey ? await assetUrl(out.assetKey) : out?.url;
  if (url) showImagePreview({ images: [url], closeable: true });
}

// —— 她那边的天气：住在哪座城市（不写 = 和你一样）——
const weather = useWeatherStore();
const svc = useServicesStore();
const cityDraft = ref(character.value.weather?.city ?? '');
watch(
  () => character.value.id,
  () => (cityDraft.value = character.value.weather?.city ?? ''),
);
function saveCity() {
  const c = character.value;
  const city = cityDraft.value.trim();
  if (city === (c.weather?.city ?? '')) return;
  if (city) c.weather = { city, ...(c.weather?.provider ? { provider: c.weather.provider } : {}) };
  else delete c.weather;
  c.updatedAt = Date.now();
}
const herProvider = computed<WeatherProviderChoice>({
  get: () => character.value.weather?.provider ?? 'auto',
  set: (v) => {
    const c = character.value;
    if (!c.weather?.city) return;
    c.weather = { city: c.weather.city, ...(v === 'auto' ? {} : { provider: v }) };
    c.updatedAt = Date.now();
  },
});
const herWeather = computed(() => weather.forCharacter(character.value));
const herEntry = computed(() => weather.entryFor(character.value));
// 从"环境与作息 → 她们那边的天气"点进来时滚到这一块
onMounted(() => {
  if (route.hash === '#weather') setTimeout(() => document.getElementById('ce-weather')?.scrollIntoView({ block: 'center' }), 300);
});

const TABS = ['basic', 'persona', 'greeting', 'example', 'lore', 'preset', 'sprite', 'live2d', 'voice', 'proactive', 'look'] as const;
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
            <label class="field-label" for="ce-weather">住在哪座城市（{{ character.pronoun }}那边的天气）</label>
            <input
              id="ce-weather"
              v-model="cityDraft"
              class="input"
              placeholder="不写 = 和你在同一个地方；国内的角色写例如 上海"
              enterkeyhint="done"
              data-testid="char-city"
              @blur="saveCity"
              @keydown.enter="saveCity"
            />
            <template v-if="weather.hasOwnCity(character)">
              <Segmented
                v-model="herProvider"
                class="mt-2"
                :options="[
                  { value: 'auto', label: '自动' },
                  { value: 'qweather', label: '和风天气' },
                  { value: 'open-meteo', label: 'Open-Meteo' },
                ]"
              />
              <div class="text-[12.5px] mt-1.5" :class="herEntry.error && !herWeather ? 'text-bad' : 'text-ink-3'" data-testid="char-weather">
                <template v-if="herWeather">
                  <span :class="herWeather.icon" /> {{ herWeather.place }} {{ herWeather.text }} {{ weather.temp(herWeather.tempC) }} · {{ WEATHER_PROVIDER_LABEL[herWeather.provider] }}
                  <template v-if="herProvider !== 'open-meteo' && herWeather.provider === 'open-meteo' && !svc.qweatherReady"> · 没填和风天气，先用 Open-Meteo</template>
                </template>
                <template v-else-if="herEntry.loading">正在取{{ character.weather?.city }}的天气…</template>
                <template v-else>{{ herEntry.error || '保存后会取那里的天气' }}</template>
              </div>
            </template>
            <div v-else class="text-[12px] text-ink-3 mt-1">聊天里写进【当前环境】：{{ character.pronoun }}那边下不下雨、冷不冷。国内的城市用和风天气（在"我的 → 地图、天气、音乐"里填 Key），其他地方用 Open-Meteo。</div>
            <label class="field-label" for="ce-status">状态行（{{ character.pronoun }}此刻在做什么，按节律里的作息自动更新）</label>
            <input id="ce-status" v-model="character.status" class="input" />
            <RouterLink :to="`/me/rhythm?char=${character.id}`" class="link-row press" data-testid="to-rhythm">
              <span class="i-lucide-calendar-clock text-accent-ink" />
              <span class="flex-1 min-w-0">
                <span class="block text-[14px]">节律：作息、三餐、穿着</span>
                <span class="block text-[12px] text-ink-3 truncate">{{ rhythm.configOf(character.id).settings.mode === 'daily' ? '每天变化' : '固定' }}{{ rhythm.hasWorld(character.id) ? '' : ' · 还没有小世界，去建一个' }}</span>
              </span>
              <span class="i-lucide-chevron-right text-ink-3" />
            </RouterLink>
            <button type="button" class="link-row press w-full text-left" data-testid="to-look" @click="tab = 'look'">
              <span class="i-lucide-wand-sparkles text-accent-ink" />
              <span class="flex-1 min-w-0">
                <span class="block text-[14px]">生图：{{ isFandom(character) ? '同人角色' : '原创角色' }}</span>
                <span class="block text-[12px] text-ink-3 truncate">{{ isFandom(character) ? `角色 tag ${character.fandom?.characterTag}` : '按外观 tags 画；出自已有作品的角色在这里打上"同人"' }}</span>
              </span>
              <span class="i-lucide-chevron-right text-ink-3" />
            </button>
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
            <PresetPicker :model-value="presetId" category="chat" @update:model-value="pickPreset" />
            <p class="text-[12px] text-ink-3 mt-2.5 mb-0 leading-relaxed">
              和{{ character.pronoun }}平时聊天（聊天气泡、剧场模式）按这套对话预设拼提示词，下一条回复起生效；在聊天右上角 ⋯ → 预设 里也能换。一起吃饭、健身这些用各自的功能预设，主动消息、番外、总结、配图也各用各的，在
              <RouterLink to="/me/presets" class="text-accent-ink">我的 → 预设</RouterLink> 里选。
            </p>
          </div>
        </van-tab>
        <van-tab title="立绘" name="sprite">
          <div class="px-4">
            <HScroll :active="outfit" class="gap-1.5 mt-3" aria-label="服装">
              <button v-for="(label, key) in OUTFITS" :key="key" type="button" class="opt" :class="{ on: outfit === key }" :aria-pressed="outfit === key" @click="outfit = key">{{ label }}</button>
            </HScroll>
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
        <van-tab title="Live2D" name="live2d">
          <Live2DSettings v-if="tab === 'live2d'" :key="character.id" :character="character" />
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
            <van-cell title="性格" :value="PERSONALITY[character.proactive.personality]" label="决定频率（没有条数上限）" />
            <van-cell title="勿扰时段" :value="`${character.proactive.quietHours.start} - ${character.proactive.quietHours.end}`" />
            <van-cell title="允许主动来电" center><template #right-icon><van-switch v-model="character.proactive.allowCalls" size="22px" /></template></van-cell>
            <van-cell title="允许主动发自拍" label="用 NovelAI 生成" center><template #right-icon><van-switch v-model="character.proactive.allowSelfies" size="22px" /></template></van-cell>
            <van-cell title="什么时候来找你、今天的计划、推送通道" is-link :to="`/me/proactive?char=${character.id}`" />
          </van-cell-group>
        </van-tab>
        <van-tab title="生图" name="look">
          <div class="px-4">
            <div class="fandom" data-testid="fandom">
              <div class="flex items-center gap-3">
                <div class="flex-1 min-w-0">
                  <div class="text-[15px] font-600">同人角色</div>
                  <div class="text-[12px] text-ink-3 leading-relaxed mt-0.5">
                    {{ character.name }}出自已有的作品、NovelAI 认得{{ character.pronoun }}时打开：生图直接写角色 tag 和作品 tag，不用一条条描述长相。原创角色关着，按下面的外观 tags 画。
                  </div>
                </div>
                <van-switch v-model="fandomOn" size="22px" aria-label="同人角色" />
              </div>
              <template v-if="fandomOn">
                <label class="field-label" for="ce-char-tag">角色 tag（Danbooru 上的写法，重名时括号里写作品）</label>
                <input id="ce-char-tag" :value="character.fandom?.characterTag ?? ''" class="input mono" placeholder="例如 hatsune miku、rem (re:zero)" autocapitalize="off" spellcheck="false" @input="setFandom('characterTag', ($event.target as HTMLInputElement).value)" />
                <label class="field-label" for="ce-copy-tag">作品 tag</label>
                <input id="ce-copy-tag" :value="character.fandom?.copyrightTag ?? ''" class="input mono" placeholder="例如 vocaloid、re:zero kara hajimeru isekai seikatsu" autocapitalize="off" spellcheck="false" @input="setFandom('copyrightTag', ($event.target as HTMLInputElement).value)" />
                <p v-if="!character.fandom?.characterTag.trim()" class="text-[12px] text-warn mt-1.5 mb-0">还没填角色 tag：填好之前按原创画。</p>
              </template>
            </div>

            <label class="field-label" for="ce-tags">{{ fandomOn ? '补充外观 tags（可以不写；NovelAI 认不全的地方写在这里，衣服写进节律的衣柜）' : 'NovelAI 外观 tags（发色、瞳色、发型、体型……；生图提示词智能体在这上面补动作、场景）' }}</label>
            <textarea id="ce-tags" v-model="character.appearanceTags" class="textarea mono" rows="4" />
            <label class="field-label" for="ce-neg">负面 tags</label>
            <textarea id="ce-neg" v-model="character.negativeTags" class="textarea mono" rows="2" />

            <div class="look-line">
              <div class="text-[12px] text-ink-3">生图时加在最前面的长相</div>
              <div class="mono text-[13px] break-all mt-0.5">{{ appearanceLine || '（空）' }}</div>
              <div v-if="todayOutfit" class="text-[12px] text-ink-3 mt-1.5">
                今天穿：{{ todayOutfit.name }}<span class="mono"> · {{ todayOutfit.tags }}</span>（来自<RouterLink :to="`/me/rhythm?char=${character.id}`" class="text-accent-ink">节律</RouterLink>，一起做事时画的图都穿这身）
              </div>
            </div>

            <van-button round block class="!mt-4" :loading="trial?.busy" loading-text="在画…" data-testid="trial-draw" @click="trialDraw">
              {{ imageLive ? (fandomOn ? '试画一张，看 NovelAI 认不认得' : '用这些 tags 试画一张') : '生图 API 还没接通，去设置' }}
            </van-button>
            <div v-if="trial && !trial.busy" class="trial">
              <button v-if="trial.out" type="button" class="trial-img" aria-label="看大图" @click="openTrial">
                <AssetImg :asset-key="trial.out.assetKey" :url="trial.out.url" :alt="trial.out.caption" />
              </button>
              <div class="flex-1 min-w-0">
                <template v-if="trial.out">
                  <div class="text-[13.5px] font-600">{{ trial.out.caption || '试画' }}</div>
                  <div class="text-[12px] text-ink-3 mt-1 break-all mono">{{ trial.out.prompt }}</div>
                  <div class="text-[12px] text-ink-3 mt-1">{{ trial.out.model }}{{ trial.out.seed ? ` · 种子 ${trial.out.seed}` : '' }}</div>
                  <div v-if="fandomOn" class="text-[12px] text-ink-2 mt-1.5">不像原作：检查角色 tag 的写法（可以去 Danbooru 搜一下），或者在上面补几个外观 tags。</div>
                </template>
                <ErrorDetails v-else-if="trial.error" :title="trial.error" :detail="trial.detail ?? trial.error" max-height="30vh" />
              </div>
            </div>
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
.link-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
  padding: 10px 12px;
  border-radius: 14px;
  background: var(--panel);
  color: inherit;
  text-decoration: none;
}
.fandom {
  margin-top: 12px;
  padding: 12px;
  border-radius: 16px;
  background: var(--surface);
  border: 1px solid var(--border);
}
.look-line {
  margin-top: 12px;
  padding: 10px 12px;
  border-radius: 14px;
  background: var(--panel);
}
.trial {
  display: flex;
  gap: 12px;
  margin-top: 12px;
  padding: 10px;
  border-radius: 14px;
  background: var(--panel);
}
.trial-img {
  flex-shrink: 0;
  width: 96px;
  height: 140px;
  border-radius: 12px;
  overflow: hidden;
  background: var(--surface);
}
.zone-info {
  margin-top: 10px;
  padding: 10px 12px;
  border-radius: 14px;
  background: var(--panel);
}
</style>
