<script setup lang="ts">
import { showToast } from 'vant';
import { computed, ref } from 'vue';
import Avatar from '@/components/common/Avatar.vue';
import HScroll from '@/components/common/HScroll.vue';
import ImagePick from '@/components/common/ImagePick.vue';
import PersonaAvatar from '@/components/common/PersonaAvatar.vue';
import Segmented from '@/components/common/Segmented.vue';
import Wallpaper from '@/components/common/Wallpaper.vue';
import BackgroundEditor from '@/components/settings/BackgroundEditor.vue';
import PageHeader from '@/layouts/PageHeader.vue';
import { usePersonaStore } from '@/stores/personas';
import { useAppStore, type ThemeSetting } from '@/stores/app';
import { useAppearanceStore, type AvatarOwner } from '@/stores/appearance';
import { useCharacterStore } from '@/stores/characters';
import { PALETTES, type Palette, type PaletteId } from '@/theme/palettes';

/**
 * 外观（参考 math-reader 的主题设置）：日 / 夜 / 跟随系统 + 6 套配色，每套都有白天、夜里两版；
 * 也可以白天、夜里分开选。另有点缀色来源、聊天背景图、自己上传的头像。
 */
const app = useAppStore();
const chars = useCharacterStore();
const looks = useAppearanceStore();
const theme = computed<ThemeSetting>({ get: () => app.themeSetting, set: (v) => app.setTheme(v) });
const accentFrom = computed({ get: () => looks.settings.accentFrom, set: (v) => looks.setAccentFrom(v) });
const split = computed({ get: () => looks.settings.splitPalettes, set: (v: boolean) => looks.setSplit(v) });
const personaStore = usePersonaStore();
const me = computed(() => personaStore.defaultPersona);
const her = computed(() => chars.byId(app.activeCharacterId) ?? chars.list[0]!);

type Which = 'both' | 'day' | 'night';
function isOn(p: Palette, which: Which) {
  if (which === 'night') return looks.settings.nightPalette === p.id;
  if (which === 'day') return looks.settings.dayPalette === p.id;
  return looks.settings.dayPalette === p.id && looks.settings.nightPalette === p.id;
}
function choose(id: PaletteId, which: Which) {
  looks.setPalette(id, which);
}
const ROWS = computed<{ which: Which; label?: string }[]>(() =>
  split.value ? [{ which: 'day', label: '白天' }, { which: 'night', label: '夜里' }] : [{ which: 'both' }],
);

/** 配色一行放不下时横着滑（手指、鼠标滚轮、拖动、箭头都行）；这一行选中的变了就把它滑到看得见的地方 */
function activeOf(which: Which): string {
  if (which === 'night') return looks.settings.nightPalette;
  if (which === 'day') return looks.settings.dayPalette;
  return `${looks.settings.dayPalette}|${looks.settings.nightPalette}`;
}

function hasAvatar(owner: AvatarOwner, id: string) {
  return !!looks.imageUrl(looks.avatarKey(owner, id));
}
async function pickAvatar(owner: AvatarOwner, id: string, file: File) {
  try {
    const saved = await looks.pickAvatar(owner, id, file);
    showToast(saved ? '头像换好了' : '换好了，但本机存储不够，下次打开会恢复原样');
  } catch {
    showToast('这张图读不出来，换一张试试');
  }
}

const fontScale = ref(100);
const defaultMode = ref<'im' | 'stage'>('im');
const reduceMotion = ref(false);
</script>

<template>
  <div class="page" data-page="appearance">
    <PageHeader title="外观" fallback="/me" />
    <div class="page-scroll pb-10">
      <!-- 预览：当前配色 + 通用背景 + 头像 -->
      <div class="preview mx-4 mt-2">
        <Wallpaper :background="looks.backgroundOf(null)" />
        <div class="relative grid gap-2.5 p-3.5">
          <div class="flex items-end gap-2">
            <Avatar :character="her" :size="30" />
            <span class="bubble ai">今天也辛苦了。</span>
          </div>
          <div class="flex items-end justify-end gap-2">
            <span class="bubble me">嗯，想你了</span>
            <PersonaAvatar v-if="hasAvatar('persona', me.id)" :persona="me" :size="30" />
          </div>
        </div>
      </div>

      <div class="group-title">模式</div>
      <div class="px-4">
        <Segmented
          v-model="theme"
          :options="[
            { value: 'system', label: '跟随系统', icon: 'i-lucide-sun-moon' },
            { value: 'dark', label: '夜', icon: 'i-lucide-moon' },
            { value: 'light', label: '日', icon: 'i-lucide-sun' },
          ]"
        />
      </div>

      <div class="group-title">配色</div>
      <template v-for="row in ROWS" :key="row.which">
        <div v-if="row.label" class="pal-label">{{ row.label }}</div>
        <HScroll :active="activeOf(row.which)" class="gap-2.5 px-4 pt-1 pb-1" :aria-label="`${row.label ?? ''}配色`">
          <button
            v-for="p in PALETTES"
            :key="p.id"
            class="pal press"
            :class="{ on: isOn(p, row.which) }"
            :aria-label="`${row.label ?? ''}配色 ${p.name}`"
            :aria-pressed="isOn(p, row.which)"
            :data-palette="p.id"
            @click="choose(p.id, row.which)"
          >
            <span class="pal-swatch">
              <span v-for="m in row.which === 'both' ? (['day', 'night'] as const) : [row.which]" :key="m" class="half" :style="{ background: p[m].bg }">
                <i class="bub-l" :style="{ background: p[m].surface, borderColor: p[m].border }" />
                <i class="bub-r" :style="{ background: p[m].accent }" />
              </span>
              <span v-if="isOn(p, row.which)" class="check"><span class="i-lucide-check" /></span>
            </span>
            <span class="pal-name">{{ p.name }}</span>
          </button>
        </HScroll>
      </template>
      <van-cell-group inset class="!mt-2">
        <van-cell title="白天和夜里用不同配色" center>
          <template #right-icon><van-switch v-model="split" size="22px" /></template>
        </van-cell>
      </van-cell-group>
      <p class="note">每套配色都有白天、夜里两版，跟着上面的"模式"切换。</p>

      <div class="group-title">点缀色</div>
      <div class="px-4">
        <Segmented
          v-model="accentFrom"
          :options="[
            { value: 'character', label: '跟随角色' },
            { value: 'palette', label: '跟随配色' },
          ]"
        />
      </div>
      <template v-if="accentFrom === 'character'">
        <div class="px-4 grid gap-2 mt-2.5">
          <RouterLink v-for="c in chars.list" :key="c.id" :to="`/me/characters/${c.id}`" class="opt-row">
            <Avatar :character="c" :size="34" />
            <span class="flex-1">{{ c.name }}</span>
            <span class="swatch" :style="{ background: c.accent }" />
            <span class="i-lucide-chevron-right text-ink-3" />
          </RouterLink>
        </div>
        <p class="note">和谁聊天，按钮、你的气泡就是谁的颜色。</p>
      </template>
      <p v-else class="note">按钮、你的气泡都用配色自带的颜色，不随聊天对象变。</p>

      <div class="group-title">聊天背景</div>
      <div class="px-4">
        <BackgroundEditor scope="global" />
      </div>
      <p class="note">单个聊天可以另设：聊天页右上角 ⋯ → 聊天背景。</p>

      <div class="group-title">头像</div>
      <div class="px-4 grid gap-2">
        <div class="opt-row">
          <PersonaAvatar :persona="me" :size="40" />
          <div class="flex-1 min-w-0">
            <div class="text-[15px] font-600 truncate">我 · {{ me.name }}</div>
            <div class="text-[12px] text-ink-3 truncate">上传后，聊天里你的消息旁也会显示</div>
          </div>
          <button v-if="hasAvatar('persona', me.id)" class="mini-btn" @click="looks.resetAvatar('persona', me.id)">恢复</button>
          <ImagePick class="mini-btn primary" :data-upload="`persona-${me.id}`" @pick="(f) => pickAvatar('persona', me.id, f)">上传</ImagePick>
        </div>
        <div v-for="c in chars.list" :key="c.id" class="opt-row">
          <Avatar :character="c" :size="40" />
          <div class="flex-1 min-w-0">
            <div class="text-[15px] font-600 truncate">{{ c.name }}</div>
            <div class="text-[12px] text-ink-3 truncate">{{ hasAvatar('character', c.id) ? '用的是你上传的图' : c.portraits?.portraits.length ? '用的是立绘（按头像框裁，跟着表情换）' : '用的是占位立绘的头像' }}</div>
          </div>
          <button v-if="hasAvatar('character', c.id)" class="mini-btn" @click="looks.resetAvatar('character', c.id)">恢复</button>
          <ImagePick class="mini-btn primary" :data-upload="`character-${c.id}`" @pick="(f) => pickAvatar('character', c.id, f)">上传</ImagePick>
        </div>
      </div>
      <p class="note">上传的头像会居中裁成正方形。没上传时用立绘按头像框裁（在角色卡 → 立绘里导入、拖头像框）。</p>

      <div class="group-title">阅读</div>
      <van-cell-group inset>
        <van-cell :title="`字号 ${fontScale}%`">
          <template #label><van-slider v-model="fontScale" :min="85" :max="130" :step="5" class="!mt-3" bar-height="4px" button-size="16px" /></template>
        </van-cell>
        <van-cell title="聊天默认模式">
          <template #label>
            <Segmented
              v-model="defaultMode"
              class="mt-2"
              :options="[
                { value: 'im', label: '聊天气泡' },
                { value: 'stage', label: '剧场立绘' },
              ]"
            />
          </template>
        </van-cell>
        <van-cell title="减少动效" label="关掉呼吸、淡入淡出等动画" center>
          <template #right-icon><van-switch v-model="reduceMotion" size="22px" /></template>
        </van-cell>
      </van-cell-group>
    </div>
  </div>
</template>

<style scoped>
.preview {
  position: relative;
  isolation: isolate;
  overflow: hidden;
  border-radius: 18px;
  background: var(--bg);
  border: 1px solid var(--border);
}
.bubble {
  max-width: 70%;
  padding: 8px 12px;
  border-radius: 16px;
  font-size: 14.5px;
}
.bubble.ai {
  border-bottom-left-radius: 6px;
  background: var(--bubble-ai);
  border: 1px solid var(--border);
}
.bubble.me {
  border-bottom-right-radius: 6px;
  background: var(--bubble-me);
  color: var(--on-bubble-me);
}
.pal-label {
  margin: 4px 16px 6px;
  font-size: 12.5px;
  color: var(--ink-3);
}
.pal {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
  width: 76px;
}
.pal-swatch {
  position: relative;
  display: flex;
  width: 76px;
  height: 56px;
  overflow: hidden;
  border-radius: 14px;
  border: 1px solid var(--border);
}
.pal.on .pal-swatch {
  border-color: transparent;
  box-shadow:
    0 0 0 2px var(--bg),
    0 0 0 4px var(--accent);
}
.half {
  position: relative;
  flex: 1;
}
.half i {
  position: absolute;
  height: 9px;
  border-radius: 5px;
}
.half .bub-l {
  top: 12px;
  left: 6px;
  width: 62%;
  border: 1px solid;
}
.half .bub-r {
  bottom: 12px;
  right: 6px;
  width: 46%;
}
.check {
  position: absolute;
  top: 4px;
  right: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 12px;
}
.pal-name {
  font-size: 13px;
  color: var(--ink-2);
}
.pal.on .pal-name {
  color: var(--ink);
  font-weight: 600;
}
.opt-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 14px;
  background: var(--surface);
  border: 1px solid var(--border);
  color: inherit;
  text-decoration: none;
}
.swatch {
  width: 22px;
  height: 22px;
  border-radius: 50%;
}
.mini-btn {
  display: inline-flex;
  align-items: center;
  height: 30px;
  padding: 0 12px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink);
  font-size: 13px;
  white-space: nowrap;
  flex-shrink: 0;
}
.mini-btn.primary {
  background: var(--accent);
  color: var(--on-accent);
  font-weight: 600;
}
</style>
