<script setup lang="ts">
import type { PokeHotspot } from '@app/shared';
import { computed, ref } from 'vue';
import SceneShell from '@/components/scene/SceneShell.vue';
import { usePoke } from '@/composables/usePoke';
import { useAppStore } from '@/stores/app';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';

/** 戳戳乐：单击戳、长按摸头、连击；即时反应来自本地台词，每 4 下让 AI 说一句更丰富的 */
const app = useAppStore();
const chars = useCharacterStore();
const chat = useChatStore();
const character = computed(() => chars.byId(app.activeCharacterId) ?? chars.list[0]!);
const chatId = computed(() => chat.chatOfCharacter(character.value.id)?.id);
const { bubble, combo, total, annoyed, onPoke } = usePoke(() => character.value.id, chatId);
const showZones = ref(false);
const counts = ref<Record<string, number>>({});

function poke(h: PokeHotspot, kind: 'tap' | 'long') {
  counts.value[h.label] = (counts.value[h.label] ?? 0) + 1;
  onPoke(h, kind);
}

const aiLine = computed(() => {
  const id = chatId.value;
  if (!id) return '';
  const s = chat.streams[id];
  const last = [...chat.list(id)].reverse().find((m) => m.role === 'assistant');
  return s ? (last?.text ?? '') : '';
});
const line = computed(() => aiLine.value || bubble.value?.text || '戳戳看？……我才没有在期待。');
</script>

<template>
  <SceneShell
    scene-id="poke"
    backdrop="room"
    :line="line"
    :typing="!!(chatId && chat.streams[chatId]?.thinking)"
    pokeable
    :show-hotspots="showZones"
    :layout="{ left: 50, bottom: 30, height: 62 }"
    @poke="poke"
  >
    <template #actions>
      <button class="zones" :class="{ on: showZones }" @click="showZones = !showZones"><span class="i-lucide-scan" />热区</button>
    </template>
    <template #overlay>
      <div v-if="combo > 1" class="combo num" :class="{ angry: annoyed }">{{ annoyed ? '生气了！' : `连击 ×${combo}` }}</div>
    </template>

    <div class="flex items-center gap-3">
      <span class="i-lucide-heart text-accent text-[20px]" />
      <div class="flex-1">
        <div class="flex justify-between text-[12.5px] text-ink-3"><span>好感</span><span class="num">{{ character.relationship.affection }} / 100</span></div>
        <van-progress :percentage="character.relationship.affection" :show-pivot="false" stroke-width="6" />
      </div>
    </div>
    <div class="flex flex-wrap gap-2 mt-3">
      <span class="chip num">今天戳了 {{ total }} 下</span>
      <span v-for="(n, k) in counts" :key="k" class="chip num">{{ k }} ×{{ n }}</span>
    </div>
    <p class="text-[12.5px] text-ink-3 mt-3 leading-relaxed">
      单击戳 · 长按摸头 · 1.2 秒内连击 6 下她会生气。每戳 4 下，AI 会接一句更丰富的反应，聊天里也会留下"你拍了拍她的头"。
      热区在 <RouterLink to="/me/characters/suwan?tab=sprite" class="text-accent-ink">角色 → 立绘</RouterLink> 里画。
    </p>
  </SceneShell>
</template>

<style scoped>
.zones {
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
.zones.on {
  color: var(--accent-ink);
  border-color: var(--accent-line);
}
.combo {
  position: absolute;
  z-index: 9;
  top: 30%;
  right: 10%;
  font-size: 20px;
  font-weight: 800;
  color: var(--accent-ink);
  transform: rotate(-10deg);
  text-shadow: 0 2px 10px rgba(0, 0, 0, 0.4);
}
.combo.angry {
  color: var(--bad);
}
</style>
