/**
 * 约会（设计文档 §9.6）：她每段结尾给四个选项，每个选项是一种回法。
 * 名字是协议（写进"约会"功能预设：[choice:顺着:…|逆着:…|皮一下:…|暧昧:…]），中文就是界面上的标签。
 */
export const DATE_CHOICE_KINDS = ['顺着', '逆着', '皮一下', '暧昧'] as const;
export type DateChoiceKind = (typeof DATE_CHOICE_KINDS)[number];

export interface DateChoice {
  /** 哪种回法；模型没标、又数不上时为空 */
  kind: DateChoiceKind | null;
  text: string;
}

const KINDS_ALT = DATE_CHOICE_KINDS.join('|');
/** "顺着：…"、"【暧昧】…"、"(皮一下) …"：前缀要带冒号或括号，免得把"暧昧地看着她"认成暧昧 */
const KIND_RE = new RegExp(`^\\s*(?:[（(【\\[]\\s*(${KINDS_ALT})\\s*[）)】\\]]\\s*[:：]?|(${KINDS_ALT})\\s*[:：])\\s*`);

/**
 * 读 [choice:] 里的选项：写了"顺着："这类前缀的按前缀认；一个都没写、正好四个时按顺序认（顺着、逆着、皮一下、暧昧）。
 * 去掉前缀和空选项，同一种只留第一个
 */
export function parseDateChoices(options: readonly string[]): DateChoice[] {
  const raw = options.map((o) => {
    const m = KIND_RE.exec(o);
    return m ? { kind: (m[1] ?? m[2]) as DateChoiceKind, text: o.slice(m[0].length).trim() } : { kind: null, text: o.trim() };
  });
  const labeled = raw.some((c) => c.kind);
  const list = raw.filter((c) => c.text).map((c, i) => (labeled || raw.length !== DATE_CHOICE_KINDS.length ? c : { ...c, kind: DATE_CHOICE_KINDS[i]! }));
  const seen = new Set<DateChoiceKind>();
  return list.filter((c) => {
    if (!c.kind) return true;
    if (seen.has(c.kind)) return false;
    seen.add(c.kind);
    return true;
  });
}
