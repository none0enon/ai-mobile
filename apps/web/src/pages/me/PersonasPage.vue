<script setup lang="ts">
import { showToast } from 'vant';
import { ref } from 'vue';
import ImagePick from '@/components/common/ImagePick.vue';
import PersonaAvatar from '@/components/common/PersonaAvatar.vue';
import PageHeader from '@/layouts/PageHeader.vue';
import { personas } from '@/mock/characters';
import { useAppearanceStore } from '@/stores/appearance';

/** 我的人设（ST 的 Persona）：角色眼中的"你"。可以有多个身份，聊天里切换 */
const list = ref(personas.map((p) => ({ ...p })));
const selected = ref(list.value.find((p) => p.isDefault)?.id ?? list.value[0]?.id);
function setDefault(id: string) {
  for (const p of list.value) p.isDefault = p.id === id;
}

const looks = useAppearanceStore();
async function pickAvatar(id: string, file: File) {
  try {
    showToast((await looks.pickAvatar('persona', id, file)) ? '头像换好了' : '换好了，但本机存储不够，下次打开会恢复原样');
  } catch {
    showToast('这张图读不出来，换一张试试');
  }
}
</script>

<template>
  <div class="page" data-page="personas">
    <PageHeader title="我的人设" subtitle="她眼中的你；每个聊天可以用不同的身份" fallback="/me" />
    <div class="page-scroll px-4 py-3 grid gap-3 content-start">
      <div v-for="p in list" :key="p.id" class="persona" :class="{ on: selected === p.id }" @click="selected = p.id">
        <div class="flex items-center gap-3">
          <PersonaAvatar :persona="p" :size="44" />
          <div class="flex-1 min-w-0">
            <div class="text-[16px] font-600">{{ p.name }}</div>
            <div class="text-[12px] text-ink-3">{{ p.isDefault ? '默认身份' : '备用身份' }}</div>
          </div>
          <button v-if="!p.isDefault" class="text-accent-ink text-[13px]" @click.stop="setDefault(p.id)">设为默认</button>
          <span v-else class="tag accent">默认</span>
        </div>
        <template v-if="selected === p.id">
          <div class="flex items-center gap-2 mt-3">
            <span class="text-[13px] text-ink-2 flex-1">头像（她在聊天里看到的你）</span>
            <button v-if="looks.avatarKey('persona', p.id)" class="text-[13px] text-ink-3" @click.stop="looks.resetAvatar('persona', p.id)">恢复</button>
            <ImagePick class="text-[13px] text-accent-ink" @click.stop @pick="(f) => pickAvatar(p.id, f)">上传头像</ImagePick>
          </div>
          <label class="field-label" :for="`pn-${p.id}`">名字（{{ '{' }}{{ '{' }}user{{ '}' }}{{ '}' }} 会替换成它）</label>
          <input :id="`pn-${p.id}`" v-model="p.name" class="input" />
          <label class="field-label" :for="`pd-${p.id}`">描述</label>
          <textarea :id="`pd-${p.id}`" v-model="p.description" class="textarea" />
        </template>
      </div>
      <button class="add"><span class="i-lucide-plus" />新建身份</button>
    </div>
  </div>
</template>

<style scoped>
.persona {
  padding: 14px;
  border-radius: 18px;
  background: var(--surface);
  border: 1px solid var(--border);
}
.persona.on {
  border-color: var(--accent-line);
}
.avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: linear-gradient(135deg, #8db8ff, #6f5b9e);
  color: #fff;
  font-weight: 700;
}
.add {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 48px;
  border-radius: 16px;
  border: 1.5px dashed var(--border);
  color: var(--ink-2);
}
</style>
