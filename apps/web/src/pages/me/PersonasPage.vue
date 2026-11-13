<script setup lang="ts">
import { bmiOf, type Persona } from '@app/shared';
import { showConfirmDialog, showToast } from 'vant';
import { ref } from 'vue';
import ImagePick from '@/components/common/ImagePick.vue';
import PersonaAvatar from '@/components/common/PersonaAvatar.vue';
import PageHeader from '@/layouts/PageHeader.vue';
import { useAppearanceStore } from '@/stores/appearance';
import { usePersonaStore } from '@/stores/personas';

/**
 * 我的人设（ST 的 Persona）：角色眼中的"你"。可以有多个身份，聊天里用默认的那个。
 * 名字、描述存在本机；每个身份可以分别打开两套系统：
 * - 家务：每天、每周要做的家务（"共同的家"按它列今天的清单，做没做会影响她怎么跟你说话）；
 * - 健康：身高体重、目标、能练的方式和时间、食材、做饭时间、厨具（「健康计划」按它排健身和饮食计划）。
 */
const store = usePersonaStore();
const selected = ref(store.defaultPersona.id);

const looks = useAppearanceStore();
async function pickAvatar(id: string, file: File) {
  try {
    showToast((await looks.pickAvatar('persona', id, file)) ? '头像换好了' : '换好了，但本机存储不够，下次打开会恢复原样');
  } catch {
    showToast('这张图读不出来，换一张试试');
  }
}

function houseworkValue(p: Persona): string {
  const h = p.housework;
  if (!h?.enabled) return '没开';
  const daily = h.chores.filter((c) => c.freq === 'daily').length;
  const weekly = h.chores.length - daily;
  return h.chores.length ? `开 · 每天 ${daily} 件、每周 ${weekly} 件` : '开 · 还没加家务';
}
function healthValue(p: Persona): string {
  const h = p.health;
  if (!h?.enabled) return '没开';
  const bmi = bmiOf(h);
  return ['开', h.goal.trim().split(/[，,、\n]/)[0] || '', bmi ? `BMI ${bmi}` : ''].filter(Boolean).join(' · ');
}

function addPersona() {
  const p = store.add();
  selected.value = p.id;
}
async function removePersona(p: Persona) {
  const ok = await showConfirmDialog({ title: `删掉"${p.name}"？`, message: '这个身份的家务、健康设置一起删掉；聊天记录不动。', confirmButtonText: '删掉', confirmButtonColor: 'var(--bad)' }).then(
    () => true,
    () => false,
  );
  if (!ok) return;
  if (!store.remove(p.id)) showToast('至少要留一个身份');
  else selected.value = store.defaultPersona.id;
}
</script>

<template>
  <div class="page" data-page="personas">
    <PageHeader title="我的人设" subtitle="她眼中的你；家务、健康两套系统可以分别打开" fallback="/me" />
    <div class="page-scroll px-4 py-3 grid gap-3 content-start">
      <div v-for="p in store.list" :key="p.id" class="persona" :class="{ on: selected === p.id }" :data-persona="p.id" @click="selected = p.id">
        <div class="flex items-center gap-3">
          <PersonaAvatar :persona="p" :size="44" />
          <div class="flex-1 min-w-0">
            <div class="text-[16px] font-600 truncate">{{ p.name }}</div>
            <div class="text-[12px] text-ink-3">{{ p.isDefault ? '默认身份' : '备用身份' }}</div>
          </div>
          <button v-if="!p.isDefault" class="text-accent-ink text-[13px]" @click.stop="store.setDefault(p.id)">设为默认</button>
          <span v-else class="tag accent">默认</span>
        </div>
        <template v-if="selected === p.id">
          <div class="flex items-center gap-2 mt-3">
            <span class="text-[13px] text-ink-2 flex-1">头像（她在聊天里看到的你）</span>
            <button v-if="looks.avatarKey('persona', p.id)" class="text-[13px] text-ink-3" @click.stop="looks.resetAvatar('persona', p.id)">恢复</button>
            <ImagePick class="text-[13px] text-accent-ink" @click.stop @pick="(f) => pickAvatar(p.id, f)">上传头像</ImagePick>
          </div>
          <label class="field-label" :for="`pn-${p.id}`">名字（{{ '{' }}{{ '{' }}user{{ '}' }}{{ '}' }} 会替换成它）</label>
          <input :id="`pn-${p.id}`" v-model="p.name" class="input" @change="store.touch(p)" />
          <label class="field-label" :for="`pd-${p.id}`">描述</label>
          <textarea :id="`pd-${p.id}`" v-model="p.description" class="textarea" @change="store.touch(p)" />

          <div class="field-label">生活（可以不开）</div>
          <div class="systems">
            <RouterLink :to="`/me/personas/${p.id}/housework`" class="sys-row press" data-system="housework" @click.stop>
              <span class="sys-icon"><span class="i-lucide-house-heart" /></span>
              <span class="flex-1 min-w-0">
                <span class="block text-[14.5px] font-600">家务系统</span>
                <span class="block text-[12px] text-ink-3 truncate">每天、每周要做的家务；"共同的家"里做完打勾，她会夸你，拖着不做她也有反应</span>
              </span>
              <span class="sys-val" :class="{ on: p.housework?.enabled }">{{ houseworkValue(p) }}</span>
              <span class="i-lucide-chevron-right text-ink-3 shrink-0" />
            </RouterLink>
            <RouterLink :to="`/me/personas/${p.id}/health`" class="sys-row press" data-system="health" @click.stop>
              <span class="sys-icon"><span class="i-lucide-heart-pulse" /></span>
              <span class="flex-1 min-w-0">
                <span class="block text-[14.5px] font-600">健康系统</span>
                <span class="block text-[12px] text-ink-3 truncate">身高体重、目标、能练的时间、食材和厨具；按它排这周和今天的健身、饮食计划</span>
              </span>
              <span class="sys-val" :class="{ on: p.health?.enabled }">{{ healthValue(p) }}</span>
              <span class="i-lucide-chevron-right text-ink-3 shrink-0" />
            </RouterLink>
          </div>
          <button v-if="store.list.length > 1" class="text-[13px] text-bad mt-3" @click.stop="removePersona(p)">删掉这个身份</button>
        </template>
      </div>
      <button class="add" @click="addPersona"><span class="i-lucide-plus" />新建身份</button>
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
.systems {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 8px;
}
.sys-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 14px;
  background: var(--panel);
  color: inherit;
  text-decoration: none;
}
.sys-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 12px;
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: 18px;
  flex-shrink: 0;
}
.sys-val {
  max-width: 34%;
  font-size: 12px;
  color: var(--ink-3);
  text-align: right;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sys-val.on {
  color: var(--accent-ink);
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
