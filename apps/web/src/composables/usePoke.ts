import type { PokeHotspot, PokeReaction } from '@app/shared';
import { ref, toValue, type MaybeRefOrGetter } from 'vue';
import { services } from '@/services';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';
import { pick } from '@/utils/id';

const ANGRY: PokeReaction = { expression: 'angry', lines: ['再戳我真的要生气了！', '……哼，不理你了。', '你是不是很闲？'] };

/**
 * 戳戳乐的逻辑（剧场模式和戳戳乐场景共用）：
 * - 点一下立刻换表情 + 震动 + 本地台词（零延迟）
 * - 每戳 4 下或长按一次，往聊天里记一条"拍一拍"，让 AI 给出更丰富的反应
 * - 1.2 秒内连击 6 下她会生气
 */
export function usePoke(characterId: MaybeRefOrGetter<string>, chatId?: MaybeRefOrGetter<string | undefined>) {
  const chars = useCharacterStore();
  const chat = useChatStore();
  const bubble = ref<{ id: number; text: string } | null>(null);
  const combo = ref(0);
  const total = ref(0);
  const annoyed = ref(false);
  let lastAt = 0;
  let bubbleTimer: ReturnType<typeof setTimeout> | undefined;
  let relaxTimer: ReturnType<typeof setTimeout> | undefined;

  function say(text: string) {
    bubble.value = { id: Date.now(), text };
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => (bubble.value = null), 2600);
  }

  function onPoke(h: PokeHotspot, kind: 'tap' | 'long') {
    const id = toValue(characterId);
    const now = Date.now();
    combo.value = now - lastAt < 1200 ? combo.value + 1 : 1;
    lastAt = now;
    total.value += 1;
    services.native.vibrate(kind === 'long' ? [12, 40, 12] : 14);

    let reaction = kind === 'long' && h.longPress ? h.longPress : h.tap;
    annoyed.value = combo.value >= 6;
    if (annoyed.value) reaction = ANGRY;

    chars.setExpression(id, reaction.expression);
    say(pick(reaction.lines));
    chars.bumpAffection(id, annoyed.value ? -1 : kind === 'long' ? 2 : 1);

    const cid = toValue(chatId);
    if (cid && !annoyed.value && (total.value % 4 === 0 || kind === 'long')) {
      void chat.poke(cid, h.label);
    }

    clearTimeout(relaxTimer);
    relaxTimer = setTimeout(() => {
      if (!chat.streams[toValue(chatId) ?? '']) chars.setExpression(id, 'smile');
      annoyed.value = false;
    }, 3200);
  }

  return { bubble, combo, total, annoyed, onPoke };
}
