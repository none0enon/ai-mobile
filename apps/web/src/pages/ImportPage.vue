<script setup lang="ts">
import { showToast } from 'vant';
import { ref } from 'vue';
import PageHeader from '@/layouts/PageHeader.vue';

/**
 * 导入 SillyTavern 文件。本轮只演示界面：选了文件后显示"识别结果"。
 * M1 实现：PNG 读 tEXt 块（优先 ccv3，其次 chara），JSON 按 spec 字段判断类型；导出时 PNG 同时写两种块。
 */
const KINDS = [
  { id: 'card', icon: 'i-lucide-contact-round', title: '角色卡', accept: '.png,.json', desc: 'V1 / V2 / V3（PNG 或 JSON）。内嵌的世界书会拆出来自动绑定，备选开场白、标签、作者备注都保留。' },
  { id: 'lore', icon: 'i-lucide-library-big', title: '世界书', accept: '.json', desc: 'World Info JSON：关键词、次关键词逻辑、常驻、插入位置 / 深度、顺序、概率、分组、粘性 / 冷却 / 延迟。' },
  { id: 'preset', icon: 'i-lucide-sliders-horizontal', title: '预设', accept: '.json', desc: 'Chat Completion 预设：提示词块与顺序、采样参数、正则。App 自己的记忆 / 环境 / 场景块会自动插进去。' },
  { id: 'chat', icon: 'i-lucide-messages-square', title: '聊天记录', accept: '.jsonl', desc: 'SillyTavern 的 .jsonl 聊天记录，含 swipe。' },
];
const result = ref<{ kind: string; lines: string[] } | null>(null);

/**
 * 导入角色卡时一并生成她的小世界（M1）：
 * 从角色卡的描述、场景和内嵌世界书里找出她住哪、在哪读书 / 工作、常去哪，套一个最接近的世界模板；
 * 世界书里提到的其他人（室友、同学、家人）也一起建出来，导入后都能改。
 */
const WORLD_DEMO = {
  template: '校园模板（住处 · 学校 · 城里）',
  places: ['宿舍', '图书馆', '画室', '食堂', '老街咖啡馆', '天台'],
  people: [
    { name: '林晓', role: '室友', from: '世界书「室友」条目' },
    { name: '周老师', role: '导师', from: '角色卡 scenario' },
  ],
};

function picked(kind: string) {
  const demo: Record<string, string[]> = {
    card: ['SillyTavern V3 角色卡（PNG 里的 ccv3 块）', '名字：林夕 · 3 条备选开场白 · 12 个标签', '内嵌世界书 8 条 → 新建"林夕的世界"并绑定', '头像已作为第一张立绘导入'],
    lore: ['World Info JSON · 24 条', '常驻 3 条 · 按深度插入 5 条 · 分组 2 个', '2 条用了"粘性"，已保留'],
    preset: ['Chat Completion 预设 · 18 个提示词块', '自定义块 9 个 · 破限 1 个 · 正则 3 条', '已在"聊天历史"前插入：记忆 / 当前环境 / 场景规则'],
    chat: ['聊天记录 · 312 条消息 · 41 条带 swipe', '将导入为新会话，可选择绑定的角色'],
  };
  result.value = { kind, lines: demo[kind] ?? [] };
}
</script>

<template>
  <div class="page" data-page="import">
    <PageHeader title="导入" subtitle="SillyTavern 的角色卡、世界书、预设、聊天记录" fallback="/me" />
    <div class="page-scroll px-4 py-3 grid gap-3 content-start">
      <label v-for="k in KINDS" :key="k.id" class="drop press">
        <span class="drop-icon"><span :class="k.icon" /></span>
        <div class="flex-1 min-w-0">
          <div class="text-[15.5px] font-600">{{ k.title }} <span class="text-[12px] text-ink-3 font-400">{{ k.accept }}</span></div>
          <div class="text-[12.5px] text-ink-2 leading-relaxed mt-0.5">{{ k.desc }}</div>
        </div>
        <input type="file" :accept="k.accept" class="sr-only" :aria-label="`选择${k.title}文件`" @change="picked(k.id)" />
        <button type="button" class="pick-btn" @click.prevent="picked(k.id)">选择</button>
      </label>

      <div v-if="result" class="result">
        <div class="flex items-center gap-2 text-[14px] font-600"><span class="i-lucide-scan-search text-accent-ink" />识别结果（演示）</div>
        <ul class="mt-2 mb-0 pl-5 text-[13.5px] text-ink-2 leading-relaxed">
          <li v-for="l in result.lines" :key="l">{{ l }}</li>
        </ul>
        <template v-if="result.kind === 'card'">
          <div class="flex items-center gap-2 text-[14px] font-600 mt-3.5"><span class="i-lucide-map text-accent-ink" />她的小世界（导入时一起生成，M1）</div>
          <div class="text-[13px] text-ink-2 mt-1.5">{{ WORLD_DEMO.template }} · {{ WORLD_DEMO.places.join('、') }}</div>
          <div class="text-[12.5px] text-ink-3 mt-2.5 mb-1">世界里的人</div>
          <div class="grid gap-1.5">
            <div v-for="p in WORLD_DEMO.people" :key="p.name" class="person-row">
              <span class="person-dot">{{ p.name.slice(-1) }}</span>
              <span class="text-[13.5px] font-600">{{ p.name }}</span>
              <span class="tag">{{ p.role }}</span>
              <span class="ml-auto text-[11.5px] text-ink-3 truncate">来自{{ p.from }}</span>
            </div>
          </div>
          <p class="text-[12px] text-ink-3 mt-2 mb-0">导入后可以改地点、增删人；这些人会出现在她的作息和聊天里（"室友今天又借我充电器"）。</p>
        </template>
        <van-button type="primary" round block class="!mt-3" @click="(result = null), showToast('M1 实现真正导入')">导入</van-button>
      </div>
      <p class="text-[12px] text-ink-3 leading-relaxed m-0">
        导出时同样生成 SillyTavern 能读的文件，随时可以带着角色和世界书离开。
      </p>
    </div>
  </div>
</template>

<style scoped>
.drop {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px;
  border-radius: 18px;
  background: var(--surface);
  border: 1.5px dashed var(--border);
  cursor: pointer;
}
.drop-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 42px;
  border-radius: 14px;
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: 20px;
  flex-shrink: 0;
}
.pick-btn {
  height: 32px;
  padding: 0 14px;
  border-radius: 99px;
  background: var(--panel);
  font-size: 13px;
  flex-shrink: 0;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}
.person-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 6px 8px;
  border-radius: 12px;
  background: var(--panel);
}
.person-dot {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: 12px;
  font-weight: 700;
  flex-shrink: 0;
}
.result {
  padding: 14px;
  border-radius: 18px;
  background: var(--surface);
  border: 1px solid var(--accent-line);
}
</style>
