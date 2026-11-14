<script setup lang="ts">
import { showToast } from 'vant';
import { computed, onBeforeUnmount, ref } from 'vue';
import Avatar from '@/components/common/Avatar.vue';
import { publishUserMoment, socialStatus } from '@/services/social';
import { useAiStore } from '@/stores/ai';
import { useCharacterStore } from '@/stores/characters';
import { compressPhoto } from '@/utils/image';

/**
 * 发朋友圈：写几句话、选几张照片（最多 9 张）、带不带位置，再选谁可以看。
 * 发出去以后，看得到的角色各自点赞、评论（用"社媒 · 朋友圈"的 API）；照片先交给识图看一遍，她们才知道照片里有什么。
 */
const emit = defineEmits<{ (e: 'close'): void; (e: 'sent'): void }>();

const chars = useCharacterStore();
const ai = useAiStore();

const MAX_PHOTOS = 9;
const text = ref('');
const location = ref('');
const photos = ref<{ bytes: Uint8Array<ArrayBuffer>; mime: string; url: string }[]>([]);
/** 谁可以看：默认所有角色 */
const audience = ref<string[]>(chars.list.map((c) => c.id));
const sending = ref(false);

const everyone = computed(() => audience.value.length === chars.list.length);
const canSend = computed(() => !sending.value && (!!text.value.trim() || photos.value.length > 0));
const status = computed(() => socialStatus());
const visionLive = computed(() => ai.isLive('vision'));

function toggle(id: string) {
  audience.value = audience.value.includes(id) ? audience.value.filter((x) => x !== id) : [...audience.value, id];
}
function toggleAll() {
  audience.value = everyone.value ? [] : chars.list.map((c) => c.id);
}

async function pick(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = [...(input.files ?? [])].slice(0, MAX_PHOTOS - photos.value.length);
  input.value = '';
  for (const file of files) {
    try {
      const p = await compressPhoto(file);
      photos.value.push({ bytes: p.bytes, mime: p.mime, url: URL.createObjectURL(new Blob([p.bytes], { type: p.mime })) });
    } catch {
      showToast('有一张照片读不出来');
    }
  }
}
function drop(i: number) {
  const [gone] = photos.value.splice(i, 1);
  if (gone) URL.revokeObjectURL(gone.url);
}
onBeforeUnmount(() => photos.value.forEach((p) => URL.revokeObjectURL(p.url)));

async function send() {
  if (!canSend.value) return;
  sending.value = true;
  try {
    await publishUserMoment({
      text: text.value,
      photos: photos.value.map(({ bytes, mime }) => ({ bytes, mime })),
      visibleTo: everyone.value ? null : [...audience.value],
      location: location.value,
    });
    emit('sent');
  } catch {
    showToast('没发出去：照片没能存进本机');
  } finally {
    sending.value = false;
  }
}
</script>

<template>
  <div class="sheet" data-sheet="moment-compose">
    <div class="flex items-center gap-2">
      <div class="sheet-title flex-1">发朋友圈</div>
      <van-button size="small" round @click="emit('close')">取消</van-button>
      <van-button size="small" round type="primary" :disabled="!canSend" :loading="sending" data-testid="moment-send" @click="send">发表</van-button>
    </div>

    <textarea v-model="text" class="textarea mt-3" rows="4" placeholder="这一刻的想法…" aria-label="朋友圈正文" />

    <div class="photos">
      <div v-for="(p, i) in photos" :key="p.url" class="photo">
        <img :src="p.url" alt="" />
        <button type="button" class="remove" aria-label="去掉这张" @click="drop(i)"><span class="i-lucide-x" /></button>
      </div>
      <label v-if="photos.length < MAX_PHOTOS" class="photo add press" aria-label="添加照片">
        <span class="i-lucide-image-plus text-[22px]" />
        <input type="file" accept="image/*" multiple class="sr-only" @change="pick" />
      </label>
    </div>
    <p v-if="photos.length && !visionLive" class="note">「识图」还没接通：她们只知道你发了照片，看不到照片里有什么。</p>

    <label class="field-label" for="moment-location">所在位置（可以不写）</label>
    <input id="moment-location" v-model="location" class="input" autocomplete="off" placeholder="例如：公司楼下的咖啡店" />

    <div class="field-label flex items-center">
      <span class="flex-1">谁可以看</span>
      <button type="button" class="text-accent-ink text-[13px]" @click="toggleAll">{{ everyone ? '都不给看' : '全部可见' }}</button>
    </div>
    <div class="audience" role="group" aria-label="谁可以看">
      <button v-for="c in chars.list" :key="c.id" type="button" class="who press" :class="{ on: audience.includes(c.id) }" :aria-pressed="audience.includes(c.id)" @click="toggle(c.id)">
        <Avatar :character="c" :size="26" />
        <span class="truncate">{{ c.name }}</span>
        <span :class="audience.includes(c.id) ? 'i-lucide-eye' : 'i-lucide-eye-off'" class="text-[14px] shrink-0" />
      </button>
    </div>
    <p class="note">
      {{ audience.length ? '看得到的角色会各自点赞、评论，也会记住这条朋友圈。' : '只有自己看得到：谁也不会回应，也不会记住。' }}
      <template v-if="audience.length && !status.ok">{{ status.reason }}，发出去以后她们暂时不会回应。</template>
    </p>
  </div>
</template>

<style scoped>
.photos {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 6px;
  margin-top: 10px;
}
.photo {
  position: relative;
  aspect-ratio: 1;
  border-radius: 10px;
  overflow: hidden;
  background: var(--panel);
}
.photo img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.photo.add {
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px dashed var(--border);
  color: var(--ink-3);
  cursor: pointer;
}
.remove {
  position: absolute;
  top: 3px;
  right: 3px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 13px;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
.audience {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.who {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  height: 38px;
  padding: 0 10px 0 6px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-3);
  font-size: 13.5px;
}
.who.on {
  background: var(--accent-soft);
  color: var(--ink);
  box-shadow: inset 0 0 0 1.5px var(--accent-line);
}
.note {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--ink-3);
}
</style>
