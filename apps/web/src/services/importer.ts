import {
  characterFromCard,
  detectStFile,
  looksLikePresetFile,
  looksLikeRegexFile,
  parseCardFile,
  parseLorebook,
  parsePreset,
  parsePresetFile,
  PRESET_CATEGORIES,
  PROMPT_MARKERS,
  type Lorebook,
  type ParsedCard,
  type ParsedLorebook,
  type ParsedPreset,
  type Preset,
  type PresetCategory,
  type PresetUseId,
} from '@app/shared';
import { useAppearanceStore } from '@/stores/appearance';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';
import { useLibraryStore } from '@/stores/library';
import { uid } from '@/utils/id';

/**
 * 导入 SillyTavern 文件：先读出来给你看识别结果，确认后再建记录。
 * - 角色卡（PNG / JSON）：建角色 + 拆出内嵌世界书并绑定 + 开一条聊天（第一条是开场白）；PNG 的图当头像
 * - 世界书 JSON：建世界书
 * - 预设 JSON：SillyTavern 的 Chat Completion 预设（用 ST 实际生效的那套顺序，补上 App 自己的块），
 *   或 App 自己的预设文件（自带的预设、从预设页导出的）；导入时选分类
 */

export type PendingImport =
  | { kind: 'card'; file: File; fileName: string; parsed: ParsedCard; lines: string[]; warnings: string[] }
  | {
      kind: 'preset';
      fileName: string;
      parsed: ParsedPreset & { id?: string; defaultFor?: PresetUseId[] };
      /** App 自己的预设文件（分类按文件里写的）；SillyTavern 预设是对话预设，可以改成功能或主动消息 */
      appFile: boolean;
      lines: string[];
      warnings: string[];
    }
  | { kind: 'lorebook'; fileName: string; parsed: ParsedLorebook; lines: string[]; warnings: string[] };

export interface ImportDone {
  message: string;
  links: { label: string; to: string }[];
}

const SOURCE: Record<ParsedCard['source'], string> = {
  json: 'JSON 文件',
  'png:ccv3': 'PNG 里的 ccv3 块',
  'png:chara': 'PNG 里的 chara 块',
};

function bookLine(b: ParsedLorebook): string {
  const constant = b.entries.filter((e) => e.constant).length;
  const depth = b.entries.filter((e) => e.position === 'at_depth').length;
  const off = b.entries.filter((e) => !e.enabled).length;
  return [`${b.entries.length} 条`, constant ? `常驻 ${constant}` : '', depth ? `按深度插入 ${depth}` : '', off ? `关闭 ${off}` : ''].filter(Boolean).join(' · ');
}

const len = (s: string) => [...s].length;

export async function readImport(file: File): Promise<PendingImport> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const { kind, json } = detectStFile(bytes, file.name);

  if (kind === 'card') {
    const parsed = parseCardFile(bytes);
    const c = parsed.card;
    const examples = c.mesExample.trim() ? c.mesExample.split(/<START>/i).filter((x) => x.trim()).length : 0;
    const dp = c.extensions.depth_prompt as { prompt?: string; depth?: number } | undefined;
    const lines = [
      `SillyTavern ${parsed.spec.toUpperCase()} 角色卡（读的是${SOURCE[parsed.source]}）`,
      `名字：${parsed.name} · 开场白${c.firstMes.trim() ? ' 1 条' : '没有'}${c.alternateGreetings.length ? ` + 备选 ${c.alternateGreetings.length} 条` : ''} · 标签 ${c.tags.length} 个`,
      `描述 ${len(c.description)} 字 · 性格${c.personality.trim() ? ` ${len(c.personality)} 字` : '空'} · 场景${c.scenario.trim() ? ` ${len(c.scenario)} 字` : '空'} · 示例对话 ${examples} 段`,
      [
        c.systemPrompt.trim() ? '有 system_prompt（会覆盖预设主提示）' : '',
        c.postHistoryInstructions.trim() ? '有 post_history_instructions（会覆盖后置指令）' : '',
        dp?.prompt?.trim() ? `有 depth_prompt（深度 ${dp.depth ?? 4}）` : '',
      ]
        .filter(Boolean)
        .join(' · ') || '没有 system_prompt / post_history_instructions / depth_prompt',
      parsed.book ? `内嵌世界书「${parsed.book.name}」${bookLine(parsed.book)} → 新建并绑定` : '没有内嵌世界书',
      ...(file.type === 'image/png' || /\.png$/i.test(file.name) ? ['这张图会当头像'] : []),
    ];
    if (useCharacterStore().list.some((x) => x.name === parsed.name)) lines.push(`已经有叫"${parsed.name}"的角色了，这次会另存一个`);
    return { kind: 'card', file, fileName: file.name, parsed, lines, warnings: parsed.warnings };
  }

  if (kind === 'preset' && looksLikePresetFile(json)) {
    const parsed = parsePresetFile(json, file.name);
    const markers = parsed.blocks.filter((b) => b.marker).length;
    const off = parsed.blocks.filter((b) => !b.enabled).map((b) => b.name);
    const s = parsed.sampler;
    const lines = [
      `预设文件 · ${PRESET_CATEGORIES[parsed.category].label}预设「${parsed.name}」`,
      `${parsed.blocks.length} 块（程序填充 ${markers} 块）${off.length ? ` · 关着的：${off.join('、')}` : ''}`,
      `采样：温度 ${s.temperature} · 回复最长 ${s.maxTokens}${parsed.category === 'chat' || parsed.category === 'feature' || parsed.category === 'proactive' ? ` · 上下文 ${s.contextTokens.toLocaleString('zh-CN')}` : ''}`,
    ];
    if (parsed.id && useLibraryStore().presetById(parsed.id)) lines.push('预设库里已经有同一个预设了，这次另存一份');
    return { kind: 'preset', fileName: file.name, parsed, appFile: true, lines, warnings: parsed.warnings };
  }

  if (kind === 'preset') {
    const parsed = parsePreset(json, file.name);
    const own = parsed.blocks.filter((b) => b.origin !== 'app');
    const off = own.filter((b) => !b.enabled).map((b) => b.name);
    const s = parsed.sampler;
    const f = parsed.formats;
    const lines = [
      `Chat Completion 预设 · ${own.length} 块（开 ${own.length - off.length} 块）`,
      parsed.source?.orderId === 100001
        ? '用的是 ST 实际生效的那套顺序（prompt_order 100001）'
        : `用的是 prompt_order ${parsed.source?.orderId ?? '默认'}`,
      off.length ? `关着的：${off.join('、')}` : '所有块都开着',
      `采样：温度 ${s.temperature} · Top P ${s.topP} · 回复最长 ${s.maxTokens} · 上下文 ${s.contextTokens.toLocaleString('zh-CN')} · ${s.stream ? '流式' : '非流式'}`,
      `新聊天提示：${f.newChatPrompt || '（空）'} · 示例对话提示：${f.newExampleChatPrompt || '（空）'}`,
      `已在"聊天记录"前后补上 App 自己的：${parsed.blocks.filter((b) => b.origin === 'app').map((b) => PROMPT_MARKERS[b.identifier as keyof typeof PROMPT_MARKERS] ?? b.name).join(' / ')}（在预设里可以关掉）`,
    ];
    if (parsed.regex.length) lines.push(`正则脚本 ${parsed.regex.length} 条`);
    return { kind: 'preset', fileName: file.name, parsed, appFile: false, lines, warnings: parsed.warnings };
  }

  if (kind === 'lorebook') {
    const parsed = parseLorebook(json, file.name.replace(/\.json$/i, ''));
    return { kind: 'lorebook', fileName: file.name, parsed, lines: [`世界书「${parsed.name}」· ${bookLine(parsed)}`], warnings: [] };
  }

  if (kind === 'chat') throw new Error('聊天记录（.jsonl）的导入还没做，下一步加');
  // 正则脚本属于预设：在预设编辑页导入
  if (looksLikeRegexFile(json)) throw new Error('这是 SillyTavern 正则脚本，请在「我的 → 预设 → 正则」中导入');
  throw new Error('认不出这个文件：不是角色卡、世界书或 Chat Completion 预设');
}

/** 导入角色时默认用哪个对话预设：你最近导入的对话预设，没有就用预设库里的第一个对话预设 */
export function defaultPresetId(): string | null {
  const lib = useLibraryStore();
  const chats = lib.presetsOf('chat');
  const imported = chats.filter((p) => !p.seedFile).sort((a, b) => b.createdAt - a.createdAt)[0];
  return imported?.id ?? chats[0]?.id ?? null;
}

export async function commitImport(p: PendingImport, opts: { presetId?: string | null; category?: PresetCategory } = {}): Promise<ImportDone> {
  const lib = useLibraryStore();
  const now = Date.now();

  if (p.kind === 'preset') {
    const { warnings: _w, id: fileId, defaultFor: _d, ...data } = p.parsed;
    // 预设文件里的 id 没被占用就沿用（演示角色、用途按它找），占用了另起一个
    const id = fileId && !lib.presetById(fileId) ? fileId : uid('preset');
    const category = p.appFile ? data.category : (opts.category ?? data.category);
    const preset: Preset = { ...data, category, id, createdAt: now, updatedAt: now };
    lib.addPreset(preset);
    return {
      message: `${PRESET_CATEGORIES[category].label}预设「${preset.name}」导入好了`,
      links: [
        { label: '看预设', to: `/me/presets/${preset.id}` },
        { label: '给哪些功能用', to: `/me/presets?cat=${category}` },
      ],
    };
  }

  if (p.kind === 'lorebook') {
    const book: Lorebook = { ...p.parsed, id: uid('lb'), createdAt: now, updatedAt: now };
    lib.addLorebook(book);
    return { message: `世界书「${book.name}」导入好了，在角色页里绑定后生效`, links: [{ label: '看世界书', to: `/me/lorebooks/${book.id}` }] };
  }

  const chars = useCharacterStore();
  const chat = useChatStore();
  const lorebookIds: string[] = [];
  if (p.parsed.book) {
    const book = lib.addLorebook({ ...p.parsed.book, id: uid('lb'), createdAt: now, updatedAt: now });
    lorebookIds.push(book.id);
  }
  const presetId = opts.presetId === undefined ? defaultPresetId() : opts.presetId;
  const character = chars.add(characterFromCard(p.parsed, { id: uid('char'), now, lorebookIds, presetId }));
  if (/\.png$/i.test(p.fileName) || p.file.type === 'image/png') {
    try {
      await useAppearanceStore().pickAvatar('character', character.id, p.file);
    } catch {
      // 头像做不出来不影响导入
    }
  }
  const c = chat.startChat(character);
  const preset = lib.presetById(presetId);
  return {
    message: `「${character.name}」导入好了${preset ? `，用预设「${preset.name}」` : ''}`,
    links: [
      { label: '去聊天', to: `/chat/${c.id}` },
      { label: '查看提示词', to: `/chat/${c.id}/inspect` },
      { label: '编辑角色', to: `/me/characters/${character.id}` },
      // 生图：出自已有作品的角色打上"同人"、填角色 tag，先试画一张看 NovelAI 认不认得（设计文档 §10.4）
      { label: '生图：同人 / 原创', to: `/me/characters/${character.id}?tab=look` },
      // 节律：从角色卡和世界书里建她的小世界（地点、作息、衣柜），之后每天排她的作息和穿着
      { label: '建她的小世界', to: `/me/rhythm?char=${character.id}` },
      // 立绘：卡里没带立绘时，让 AI 写外观 tags、用 NovelAI 画透明底的立绘和各个表情（设计文档 §10.4）
      { label: 'AI 画立绘', to: `/me/characters/${character.id}?tab=sprite` },
    ],
  };
}
