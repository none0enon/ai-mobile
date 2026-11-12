<script setup lang="ts">
import { isFandom } from '@app/shared';
import Avatar from '@/components/common/Avatar.vue';
import PageHeader from '@/layouts/PageHeader.vue';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';

const chars = useCharacterStore();
const chat = useChatStore();
/** 列表里把 {{user}} 换成"你"再显示 */
const describe = (text: string) => text.replaceAll('{{user}}', '你').replaceAll('{{char}}', '她');
</script>

<template>
  <div class="page" data-page="characters">
    <PageHeader title="角色卡" subtitle="兼容 SillyTavern V2 / V3 角色卡" fallback="/me">
      <template #right>
        <RouterLink to="/import" class="icon-btn" aria-label="导入角色卡"><span class="i-lucide-file-down text-[20px]" /></RouterLink>
      </template>
    </PageHeader>
    <div class="page-scroll px-4 py-3 grid gap-3 content-start">
      <div v-for="c in chars.list" :key="c.id" class="card-c" :style="{ '--tone': c.accent }">
        <div class="flex items-center gap-3">
          <Avatar :character="c" :size="54" />
          <div class="flex-1 min-w-0">
            <div class="text-[17px] font-700">{{ c.name }}</div>
            <div class="flex flex-wrap gap-1 mt-1">
              <span v-if="isFandom(c)" class="tag accent" :title="`${c.fandom?.characterTag} · ${c.fandom?.copyrightTag}`">同人</span>
              <span v-for="t in c.card.tags" :key="t" class="tag">{{ t }}</span>
            </div>
          </div>
        </div>
        <p class="text-[13px] text-ink-2 leading-relaxed mt-2.5 mb-0 line-clamp-2">{{ describe(c.card.description) }}</p>
        <div class="flex gap-2 mt-3">
          <RouterLink :to="`/chat/${chat.chatOfCharacter(c.id)?.id}`" class="btn">聊天</RouterLink>
          <RouterLink :to="`/me/characters/${c.id}`" class="btn primary">编辑</RouterLink>
        </div>
      </div>
      <RouterLink to="/import" class="add press">
        <span class="i-lucide-plus text-[20px]" />新建或导入角色（PNG / JSON 角色卡）
      </RouterLink>
    </div>
  </div>
</template>

<style scoped>
.card-c {
  padding: 14px;
  border-radius: 20px;
  background: linear-gradient(135deg, color-mix(in srgb, var(--tone) 12%, transparent), transparent 60%), var(--surface);
  border: 1px solid var(--border);
}
.btn {
  flex: 1;
  height: 36px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink);
  font-size: 14px;
  line-height: 36px;
  text-align: center;
  text-decoration: none;
}
.btn.primary {
  background: var(--tone);
  color: #2b1219;
  font-weight: 600;
}
.add {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 52px;
  border-radius: 18px;
  border: 1.5px dashed var(--border);
  color: var(--ink-2);
  font-size: 14px;
  text-decoration: none;
}
</style>
