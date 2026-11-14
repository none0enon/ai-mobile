import type { PokeHotspot } from '@app/shared';
import { ref, toValue, type MaybeRefOrGetter } from 'vue';
import { services } from '@/services';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';
import { pick } from '@/utils/id';

/**
 * 聊天剧场模式里戳她（戳戳乐场景有自己的一套：用手 / 用嘴 / 蹭蹭，每一下都让她回应，见 PokeScene）：
 * - 点一下立刻换表情 + 震动 + 热区里的本地台词（零延迟）
 * - 每戳 4 下或长按一次，往聊天里记一条"拍一拍"，让 AI 给出更丰富的反应
 * - 连着戳只算连击，戳多少下她都不会烦
 */
export function usePoke(characterId: MaybeRefOrGetter<string>, chatId?: MaybeRefOrGetter<string | undefined>) {
  const chars = useCharacterStore();
  const chat = useChatStore();
  const bubble = ref<{ id: number; text: string } | null>(null);
  const combo = ref(0);
  const total = ref(0);
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

    const reaction = kind === 'long' && h.longPress ? h.longPress : h.tap;
    chars.setExpression(id, reaction.expression);
    say(pick(reaction.lines));
    chars.bumpAffection(id, kind === 'long' ? 2 : 1);

    const cid = toValue(chatId);
    if (cid && (total.value % 4 === 0 || kind === 'long')) void chat.poke(cid, h.label);

    clearTimeout(relaxTimer);
    relaxTimer = setTimeout(() => {
      if (!chat.streams[toValue(chatId) ?? '']) chars.setExpression(id, 'smile');
    }, 3200);
  }

  return { bubble, combo, total, onPoke };
}
