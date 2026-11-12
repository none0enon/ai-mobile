/**
 * 文字里的数学公式（LaTeX）：切出来、安全地截短、念出来。
 * 认的写法同 math-reader 的讲义：$$…$$、\[…\]（单独成行的公式），$…$、\(…\)（行内公式）；
 * 另外认直接写出来的 \begin{equation}…\end{equation} 这类公式环境。
 * 一起看书时专业书的正文、她的批注、聊天气泡、朗读都用这里的切法，保证同一段文字各处认出来的公式一样。
 */

export type MathSeg =
  | { kind: 'text'; text: string }
  /** raw 是原文（带定界符），tex 是交给 KaTeX 的公式本身 */
  | { kind: 'math'; tex: string; display: boolean; raw: string };

/** 可以不套 $$ 直接写在正文里的公式环境 */
const DISPLAY_ENV = /^\\begin\{(equation|align|alignat|gather|multline|flalign|eqnarray|displaymath)(\*?)\}/;

/** 从 from 开始找 close（跳过前面是反斜杠的，例如公式里的 \$） */
function findClose(text: string, from: number, close: string): number {
  let i = text.indexOf(close, from);
  while (i >= 0 && close[0] === '$' && text[i - 1] === '\\') i = text.indexOf(close, i + 1);
  return i;
}

/**
 * 行内 $…$ 的右边界（参考 Pandoc 的规则，免得把"$5 和 $10"当成公式）：
 * 左边的 $ 后面紧跟的不是空白；右边的 $ 前面紧挨的不是空白、后面紧跟的不是数字，也不是 $$ 的开头；不跨行。
 * 遇到当不了右边界的 $ 就放弃（当成普通的美元符号），不往后接着找
 */
function findInlineClose(text: string, from: number): number {
  if (from >= text.length || /\s/.test(text[from]!)) return -1;
  for (let j = from; j < text.length; j += 1) {
    const c = text[j];
    if (c === '\n') return -1;
    if (c === '\\') {
      j += 1;
      continue;
    }
    if (c === '$') {
      if (j === from || /\s/.test(text[j - 1]!) || /\d/.test(text[j + 1] ?? '') || text[j + 1] === '$') return -1;
      return j;
    }
  }
  return -1;
}

/** 把文字切成普通文字和公式。认不出配对的定界符时原样当文字 */
export function splitMath(text: string): MathSeg[] {
  const out: MathSeg[] = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push({ kind: 'text', text: buf });
    buf = '';
  };
  const math = (raw: string, tex: string, display: boolean) => {
    flush();
    out.push({ kind: 'math', tex, display, raw });
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '\\') {
      const n = text[i + 1];
      if (n === '[' || n === '(') {
        const close = n === '[' ? '\\]' : '\\)';
        const end = findClose(text, i + 2, close);
        if (end >= 0 && text.slice(i + 2, end).trim()) {
          math(text.slice(i, end + 2), text.slice(i + 2, end), n === '[');
          i = end + 2;
          continue;
        }
      }
      const env = n === 'b' ? DISPLAY_ENV.exec(text.slice(i, i + 32)) : null;
      if (env) {
        const endTag = `\\end{${env[1]}${env[2]}}`;
        const end = text.indexOf(endTag, i);
        if (end >= 0) {
          const raw = text.slice(i, end + endTag.length);
          math(raw, raw, true);
          i = end + endTag.length;
          continue;
        }
      }
      // 其他反斜杠（\$、\%……）原样留在文字里
      buf += n === undefined ? c : c + n;
      i += 2;
      continue;
    }
    if (c === '$') {
      if (text[i + 1] === '$') {
        const end = findClose(text, i + 2, '$$');
        if (end >= 0 && text.slice(i + 2, end).trim()) {
          math(text.slice(i, end + 2), text.slice(i + 2, end), true);
          i = end + 2;
          continue;
        }
        buf += '$$';
        i += 2;
        continue;
      }
      const end = findInlineClose(text, i + 1);
      if (end >= 0) {
        math(text.slice(i, end + 1), text.slice(i + 1, end), false);
        i = end + 1;
        continue;
      }
    }
    buf += c;
    i += 1;
  }
  flush();
  return out;
}

/** 有没有公式（先用正则粗筛，大多数聊天消息不用逐字扫） */
export function hasMath(text: string): boolean {
  if (!/[$\\]/.test(text)) return false;
  return splitMath(text).some((s) => s.kind === 'math');
}

/** 文字部分里的 \$ 显示成 $ */
export function unescapeDollar(text: string): string {
  return text.replace(/\\\$/g, '$');
}

/**
 * 截到 max 个字以内，不把公式切成两半（切开的公式渲染不出来）：
 * 会切到公式中间时停在公式前面；第一个就是比上限还长的公式时整个留下。截掉了才加 ellipsis
 */
export function clipRich(text: string, max: number, ellipsis = '…'): string {
  if (text.length <= max) return text;
  let out = '';
  for (const s of splitMath(text)) {
    const piece = s.kind === 'text' ? s.text : s.raw;
    if (out.length + piece.length <= max) {
      out += piece;
      continue;
    }
    if (s.kind === 'text') out += piece.slice(0, max - out.length);
    else if (!out.trim()) out = piece;
    break;
  }
  return out.trimEnd() + ellipsis;
}

// —— 念公式：LaTeX → 中文读法（语音合成用）——

const GREEK: Record<string, string> = {
  alpha: '阿尔法', beta: '贝塔', gamma: '伽马', delta: '德尔塔', epsilon: '艾普西隆', varepsilon: '艾普西隆',
  zeta: '泽塔', eta: '伊塔', theta: '西塔', vartheta: '西塔', iota: '约塔', kappa: '卡帕', lambda: '兰姆达',
  mu: '缪', nu: '纽', xi: '克西', pi: '派', varpi: '派', rho: '柔', varrho: '柔', sigma: '西格玛',
  varsigma: '西格玛', tau: '套', upsilon: '宇普西隆', phi: '斐', varphi: '斐', chi: '卡', psi: '普西',
  omega: '欧米伽', Gamma: '大伽马', Delta: '大德尔塔', Theta: '大西塔', Lambda: '大兰姆达', Xi: '大克西',
  Pi: '大派', Sigma: '大西格玛', Upsilon: '大宇普西隆', Phi: '大斐', Psi: '大普西', Omega: '大欧米伽',
};
const GREEK_CHARS: Record<string, string> = {
  α: 'alpha', β: 'beta', γ: 'gamma', δ: 'delta', ε: 'epsilon', ϵ: 'epsilon', ζ: 'zeta', η: 'eta', θ: 'theta',
  ϑ: 'theta', ι: 'iota', κ: 'kappa', λ: 'lambda', μ: 'mu', ν: 'nu', ξ: 'xi', π: 'pi', ρ: 'rho', σ: 'sigma',
  ς: 'sigma', τ: 'tau', υ: 'upsilon', φ: 'phi', ϕ: 'phi', χ: 'chi', ψ: 'psi', ω: 'omega', Γ: 'Gamma',
  Δ: 'Delta', Θ: 'Theta', Λ: 'Lambda', Ξ: 'Xi', Π: 'Pi', Σ: 'Sigma', Φ: 'Phi', Ψ: 'Psi', Ω: 'Omega',
};
/** 符号命令 → 读法（关系、运算、常用记号）；函数名照读 */
const WORDS: Record<string, string> = {
  le: '小于等于', leq: '小于等于', leqslant: '小于等于', ge: '大于等于', geq: '大于等于', geqslant: '大于等于',
  ne: '不等于', neq: '不等于', approx: '约等于', equiv: '恒等于', sim: '等价于', simeq: '近似于', cong: '同构于',
  propto: '正比于', ll: '远小于', gg: '远大于', in: '属于', notin: '不属于', ni: '包含', subset: '包含于',
  subseteq: '包含于', subsetneq: '真包含于', supset: '包含', supseteq: '包含', to: '到', rightarrow: '到',
  longrightarrow: '到', mapsto: '映射到', Rightarrow: '推出', implies: '推出', Longrightarrow: '推出',
  Leftarrow: '由右边推出', iff: '当且仅当', Leftrightarrow: '当且仅当', Longleftrightarrow: '当且仅当',
  leftrightarrow: '对应', uparrow: '递增趋于', downarrow: '递减趋于', pm: '正负', mp: '负正', times: '乘',
  cdot: '乘', div: '除以', ast: '星', star: '星', circ: '复合', cup: '并', cap: '交', setminus: '减去',
  oplus: '直和', otimes: '张量积', wedge: '且', vee: '或', land: '且', lor: '或', neg: '非', lnot: '非',
  infty: '无穷', partial: '偏', nabla: '纳布拉', forall: '对任意', exists: '存在', nexists: '不存在',
  emptyset: '空集', varnothing: '空集', angle: '角', perp: '垂直于', parallel: '平行于', mid: '满足',
  ldots: '点点点', cdots: '点点点', dots: '点点点', vdots: '点点点', ddots: '点点点', prime: '撇',
  ell: 'l', hbar: 'h 拔', imath: 'i', jmath: 'j', aleph: '阿列夫', top: '转置', degree: '度',
  Re: '实部', Im: '虚部', arg: '辐角', sup: '上确界', inf: '下确界', limsup: '上极限', liminf: '下极限',
  sin: 'sin', cos: 'cos', tan: 'tan', cot: 'cot', sec: 'sec', csc: 'csc', arcsin: 'arcsin', arccos: 'arccos',
  arctan: 'arctan', sinh: 'sinh', cosh: 'cosh', tanh: 'tanh', log: 'log', ln: 'ln', lg: 'lg', exp: 'exp',
  det: 'det', dim: 'dim', ker: 'ker', deg: 'deg', gcd: 'gcd', max: '最大值', min: '最小值', Pr: '概率',
};
/** 不发声的排版命令 */
const SILENT = new Set([
  'left', 'right', 'big', 'Big', 'bigg', 'Bigg', 'bigl', 'bigr', 'Bigl', 'Bigr', 'biggl', 'biggr', 'Biggl', 'Biggr',
  'displaystyle', 'textstyle', 'scriptstyle', 'limits', 'nolimits', 'quad', 'qquad', 'nonumber', 'notag',
  'mathstrut', 'strut', 'middle', 'centerdot', 'allowbreak', 'hfill',
]);
/** 字体命令：只读参数 */
const STYLE = new Set(['mathbb', 'mathbf', 'mathit', 'mathcal', 'mathscr', 'mathfrak', 'mathsf', 'mathtt', 'boldsymbol', 'bm', 'mathop', 'mathnormal']);
/** 读完参数后面跟的词：x 拔、x 帽 */
const ACCENT: Record<string, string> = {
  bar: '拔', overline: '拔', hat: '帽', widehat: '帽', tilde: '波浪', widetilde: '波浪', dot: '点', ddot: '两点',
  check: '倒帽', breve: '弯', underline: '',
};
const BIG_OPS: Record<string, string> = {
  int: '积分', iint: '二重积分', iiint: '三重积分', oint: '环路积分', sum: '求和', prod: '求积',
  bigcup: '并', bigcap: '交', coprod: '余积', bigoplus: '直和',
};
const SYMBOL_CHARS: Record<string, string> = {
  '+': '加', '=': '等于', '<': '小于', '>': '大于', '/': '除以', '!': '的阶乘', ',': '，', ';': '；', ':': '，',
  '≤': '小于等于', '≥': '大于等于', '≠': '不等于', '≈': '约等于', '≡': '恒等于', '∈': '属于', '∉': '不属于',
  '⊂': '包含于', '⊆': '包含于', '⊃': '包含', '∞': '无穷', '→': '到', '⇒': '推出', '⇔': '当且仅当', '↦': '映射到',
  '±': '正负', '×': '乘', '·': '乘', '÷': '除以', '∂': '偏', '∇': '纳布拉', '∀': '对任意', '∃': '存在',
  '∅': '空集', '∪': '并', '∩': '交', '∫': '积分', '∮': '环路积分', '∑': '求和', '∏': '求积', '√': '根号',
  '′': '撇', '°': '度', '…': '点点点', '⋯': '点点点',
};

type Tok = { t: 'cmd'; v: string } | { t: 'ch'; v: string } | { t: 'open' } | { t: 'close' };

function tokenize(tex: string): Tok[] {
  const out: Tok[] = [];
  for (let i = 0; i < tex.length; ) {
    const c = tex[i]!;
    if (c === '\\') {
      const m = /^[a-zA-Z]+/.exec(tex.slice(i + 1));
      if (m) {
        out.push({ t: 'cmd', v: m[0] });
        i += 1 + m[0].length;
      } else {
        out.push({ t: 'cmd', v: tex[i + 1] ?? '' });
        i += 2;
      }
    } else if (c === '{') {
      out.push({ t: 'open' });
      i += 1;
    } else if (c === '}') {
      out.push({ t: 'close' });
      i += 1;
    } else if (c === '%') {
      // 注释到行尾
      while (i < tex.length && tex[i] !== '\n') i += 1;
    } else {
      const cp = String.fromCodePoint(tex.codePointAt(i)!);
      out.push({ t: 'ch', v: cp });
      i += cp.length;
    }
  }
  return out;
}

/** 绝对值、范数的竖线 */
function barOf(tok: Tok): 'abs' | 'norm' | null {
  if (tok.t === 'ch') return tok.v === '|' ? 'abs' : tok.v === '‖' ? 'norm' : null;
  if (tok.t === 'cmd') return ['vert', 'lvert', 'rvert'].includes(tok.v) ? 'abs' : ['|', 'Vert', 'lVert', 'rVert'].includes(tok.v) ? 'norm' : null;
  return null;
}

/** 不发声、也不打断"前面是一个量"的：空白、\left \right、细空格 */
function isQuiet(tok: Tok): boolean {
  if (tok.t === 'ch') return /\s/.test(tok.v) || tok.v === '~';
  return tok.t === 'cmd' && (SILENT.has(tok.v) || tok.v === ',' || tok.v === ';' || tok.v === ':' || tok.v === '!' || tok.v === ' ');
}

/** 只读里面文字的命令（\text{当}、\mathrm{Re}、\operatorname{Res}） */
const TEXTY = new Set(['text', 'textrm', 'textbf', 'textit', 'textsf', 'texttt', 'mbox', 'operatorname', 'mathrm', 'emph']);

/** 把 token 读成一串词。atom 读一个"原子"，上标、下标由 seq 接在能带上下标的原子后面 */
class Reader {
  private i = 0;
  private readonly toks: Tok[];
  /** 在 lim 下面：\to 读成"趋于" */
  private readonly inLimit: boolean;

  constructor(toks: Tok[], inLimit = false) {
    this.toks = toks;
    this.inLimit = inLimit;
  }

  private peek(): Tok | undefined {
    return this.toks[this.i];
  }

  private peekCh(v: string): boolean {
    const t = this.peek();
    return t?.t === 'ch' && t.v === v;
  }

  /** 全部读完（多出来的 } 跳过） */
  all(): string[] {
    const words: string[] = [];
    while (this.i < this.toks.length) {
      words.push(...this.seq());
      if (this.peek()?.t === 'close') this.i += 1;
    }
    return words;
  }

  /** 读到这一组结束：遇到 }、末尾，或者 until 那个字符（吃掉它） */
  seq(until?: string): string[] {
    const words: string[] = [];
    const bars: { at: number; kind: 'abs' | 'norm' }[] = [];
    let prevOperand = false;
    while (this.i < this.toks.length) {
      const tok = this.peek()!;
      if (tok.t === 'close') break;
      if (until && tok.t === 'ch' && tok.v === until) {
        this.i += 1;
        break;
      }
      if (isQuiet(tok)) {
        this.i += 1;
        continue;
      }
      const bar = barOf(tok);
      if (bar) {
        this.i += 1;
        const open = bars.at(-1);
        if (open && open.kind === bar && prevOperand) {
          bars.pop();
          words.push(`${words.splice(open.at).join(' ')} ${bar === 'abs' ? '的绝对值' : '的范数'}`);
          words.push(...this.scripts());
          prevOperand = true;
        } else {
          bars.push({ at: words.length, kind: bar });
          prevOperand = false;
        }
        continue;
      }
      if (tok.t === 'ch' && (tok.v === '-' || tok.v === '−')) {
        this.i += 1;
        words.push(prevOperand ? '减' : '负');
        prevOperand = false;
        continue;
      }
      const a = this.atom();
      if (!a) continue;
      if (a.text) words.push(a.text);
      if (a.operand) words.push(...this.scripts());
      prevOperand = a.operand;
    }
    return words;
  }

  /** 一个参数：{…}，或者单个 token（\frac12 的 1 和 2 各是一个） */
  arg(): string {
    while (this.peek() && isQuiet(this.peek()!)) this.i += 1;
    const tok = this.peek();
    if (!tok || tok.t === 'close') return '';
    if (tok.t === 'open') {
      this.i += 1;
      const words = this.seq();
      if (this.peek()?.t === 'close') this.i += 1;
      return words.join(' ');
    }
    if (tok.t === 'ch' && /[0-9]/.test(tok.v)) {
      this.i += 1;
      return tok.v;
    }
    return this.atom()?.text ?? '';
  }

  /** 原样取出 {…} 里的文字 */
  rawArg(): string {
    while (this.peek() && isQuiet(this.peek()!) && this.peek()!.t === 'ch') this.i += 1;
    if (this.peek()?.t !== 'open') return '';
    this.i += 1;
    let depth = 1;
    let s = '';
    while (this.i < this.toks.length) {
      const tok = this.toks[this.i++]!;
      if (tok.t === 'open') depth += 1;
      else if (tok.t === 'close') {
        depth -= 1;
        if (!depth) break;
      } else if (tok.t === 'ch') s += tok.v;
      else s += ` ${GREEK[tok.v] ?? WORDS[tok.v] ?? ''} `;
    }
    return s.replace(/\s+/g, ' ').trim();
  }

  /** [ … ] 可选参数（\sqrt[3]{x}）的读法 */
  optArg(): string {
    if (!this.peekCh('[')) return '';
    this.i += 1;
    return this.seq(']').join(' ');
  }

  /** 接在一个量后面的上标、下标、撇（可以连着写好几个） */
  scripts(): string[] {
    const out: string[] = [];
    for (;;) {
      const tok = this.peek();
      if (tok?.t === 'ch' && (tok.v === "'" || tok.v === '′')) {
        this.i += 1;
        out.push('撇');
        continue;
      }
      if (!(tok?.t === 'ch' && (tok.v === '^' || tok.v === '_'))) break;
      this.i += 1;
      if (tok.v === '_') {
        const sub = this.arg();
        if (sub) out.push(sub.replace(/\s+/g, '').length <= 2 ? sub : `下标 ${sub}`);
        continue;
      }
      const sup = this.arg().trim();
      if (sup === '2') out.push('的平方');
      else if (sup === '3') out.push('的立方');
      else if (sup === '星' || sup === '撇') out.push(sup);
      else if (sup === '转置') out.push('的转置');
      else if (sup) out.push(`的 ${sup} 次方`);
    }
    return out;
  }

  /** 一个原子的读法；operand 表示它是一个量（后面可以带上标、下标，后面的 - 是"减"） */
  atom(): { text: string; operand: boolean } | null {
    const tok = this.toks[this.i++];
    if (!tok || tok.t === 'close') return null;
    if (tok.t === 'open') {
      const words = this.seq();
      if (this.peek()?.t === 'close') this.i += 1;
      return { text: words.join(' '), operand: true };
    }
    if (tok.t === 'ch') return this.charAtom(tok.v);
    const v = tok.v;
    if (GREEK[v]) return { text: GREEK[v]!, operand: true };
    if (v === '\\' || v === 'cr' || v === 'newline') return { text: '；', operand: false };
    if (v === '{' || v === 'lbrace' || v === 'langle') return { text: '', operand: false };
    if (v === '}' || v === 'rbrace' || v === 'rangle') return { text: '', operand: true };
    if (v === '$' || v === '%' || v === '#' || v === '&' || v === '_') return { text: v, operand: true };
    if (v === 'frac' || v === 'dfrac' || v === 'tfrac' || v === 'cfrac') {
      const num = this.arg();
      const den = this.arg();
      return { text: `${den} 分之 ${num}`, operand: true };
    }
    if (v === 'binom' || v === 'dbinom' || v === 'tbinom') {
      const n = this.arg();
      const k = this.arg();
      return { text: `${n} 选 ${k}`, operand: true };
    }
    if (v === 'sqrt') {
      const n = this.optArg();
      const x = this.arg();
      return { text: n ? `${n} 次根号下 ${x}` : `根号下 ${x}`, operand: true };
    }
    if (ACCENT[v] !== undefined) {
      const x = this.arg();
      return { text: ACCENT[v] ? `${x} ${ACCENT[v]}` : x, operand: true };
    }
    if (v === 'vec' || v === 'overrightarrow') return { text: `向量 ${this.arg()}`, operand: true };
    if (TEXTY.has(v)) {
      const raw = this.rawArg();
      return { text: WORDS[raw] && !/^[a-z]+$/.test(WORDS[raw]!) ? WORDS[raw]! : raw, operand: true };
    }
    if (STYLE.has(v)) return { text: this.arg(), operand: true };
    if (v === 'tag' || v === 'label' || v === 'eqref' || v === 'ref') {
      this.rawArg();
      return { text: '', operand: false };
    }
    if (v === 'begin') {
      const env = this.rawArg();
      if (env === 'array') this.rawArg();
      if (/matrix|array/.test(env)) return { text: '矩阵', operand: false };
      if (env === 'cases') return { text: '分情况：', operand: false };
      return { text: '', operand: false };
    }
    if (v === 'end') {
      this.rawArg();
      return { text: '', operand: true };
    }
    if (v === 'lim') {
      const sub = this.limitSub();
      return { text: sub ? `当 ${sub} 时的极限，` : '极限', operand: false };
    }
    if (BIG_OPS[v]) return this.bigOp(v, BIG_OPS[v]!);
    if (v === 'sup' || v === 'inf' || v === 'max' || v === 'min' || v === 'limsup' || v === 'liminf') {
      const sub = this.limitSub();
      return { text: sub ? `${sub} 时的${WORDS[v]}，` : WORDS[v]!, operand: false };
    }
    if (WORDS[v]) {
      const name = WORDS[v]!;
      const fn = /^[a-z]+$/.test(name) || v === 'arg' || v === 'Re' || v === 'Im' || v === 'Pr';
      return { text: v === 'to' && this.inLimit ? '趋于' : name, operand: fn || v === 'infty' || v === 'prime' || v === 'ast' || v === 'emptyset' || v === 'varnothing' };
    }
    // 不认识的命令：有参数就读参数
    if (this.peek()?.t === 'open') return { text: this.arg(), operand: true };
    return { text: '', operand: false };
  }

  private charAtom(c: string): { text: string; operand: boolean } {
    if (c === '&') return { text: '，', operand: false };
    if (/[0-9.]/.test(c)) {
      let num = c;
      while (this.peek()?.t === 'ch' && /[0-9.]/.test((this.peek() as { v: string }).v)) num += (this.toks[this.i++] as { v: string }).v;
      return { text: num, operand: true };
    }
    if (c === '(') return { text: this.seq(')').join(' '), operand: true };
    if (c === '[') return { text: this.seq(']').join(' '), operand: true };
    if (c === ')' || c === ']') return { text: '', operand: true };
    if (GREEK_CHARS[c]) return { text: GREEK[GREEK_CHARS[c]!]!, operand: true };
    if (SYMBOL_CHARS[c]) return { text: SYMBOL_CHARS[c]!, operand: c === '!' || c === '∞' || c === '′' };
    if (c === '*') return { text: '星', operand: true };
    if (c === "'") return { text: '撇', operand: true };
    return { text: c, operand: true };
  }

  /** 积分、求和这类：带上下限时读成"从 a 到 b 的积分""k 等于 1 到 n 求和" */
  private bigOp(v: string, name: string): { text: string; operand: boolean } {
    let lower = '';
    let upper = '';
    for (;;) {
      const t = this.peek();
      if (t && isQuiet(t)) {
        this.i += 1;
        continue;
      }
      if (t?.t === 'ch' && t.v === '_' && !lower) {
        this.i += 1;
        lower = this.arg();
      } else if (t?.t === 'ch' && t.v === '^' && !upper) {
        this.i += 1;
        upper = this.arg();
      } else break;
    }
    const integral = v.endsWith('int');
    if (lower && upper) return { text: integral ? `从 ${lower} 到 ${upper} 的${name}，` : `${lower} 到 ${upper} ${name}，`, operand: false };
    if (lower) return { text: integral ? `在 ${lower} 上的${name}，` : `对 ${lower} ${name}，`, operand: false };
    if (upper) return { text: `到 ${upper} 的${name}，`, operand: false };
    return { text: `${name}，`, operand: false };
  }

  /** lim、sup 下面的条件：里面的 \to 读成"趋于" */
  private limitSub(): string {
    while (this.peek() && isQuiet(this.peek()!)) this.i += 1;
    if (!this.peekCh('_')) return '';
    this.i += 1;
    if (this.peek()?.t !== 'open') return this.arg();
    this.i += 1;
    const start = this.i;
    let depth = 1;
    while (this.i < this.toks.length && depth) {
      const x = this.toks[this.i]!;
      if (x.t === 'open') depth += 1;
      else if (x.t === 'close') depth -= 1;
      this.i += 1;
    }
    return new Reader(this.toks.slice(start, depth ? this.i : this.i - 1), true).all().join(' ');
  }
}

/** 一个公式（不带定界符）的中文读法 */
export function mathToSpeech(tex: string): string {
  const words = new Reader(tokenize(tex)).all();
  return words
    .join(' ')
    .replace(/\s*([，；：])\s*/g, '$1')
    .replace(/([，；])(?:[，；])+/g, '$1')
    .replace(/^[，；\s]+|[，；\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 把一段文字里的公式换成读法（单独成行的公式前后停一下），其余原样 */
export function speakMath(text: string): string {
  if (!hasMath(text)) return text;
  return splitMath(text)
    .map((s) => {
      if (s.kind === 'text') return unescapeDollar(s.text);
      const said = mathToSpeech(s.tex);
      if (!said) return ' ';
      return s.display ? `，${said}。` : ` ${said} `;
    })
    .join('')
    .replace(/^[\s，。]+/, '');
}

const CONTROL_LETTER: Record<string, string> = { '\b': 'b', '\f': 'f', '\t': 't', '\r': 'r', '\n': 'n' };

/**
 * 模型在 JSON 里写 LaTeX 时常常不转义反斜杠：\frac \theta \nabla \rho \beta 会被 JSON 读成换页、制表、换行、回车、退格，
 * 解析不报错，公式却坏了（"\frac12" 变成 "␌rac12"）。在有公式的字符串里把它们改回来
 */
export function repairJsonLatex(s: string): string {
  if (!/[\b\f\t\r\n]/.test(s) || !s.includes('$')) return s;
  return s.replace(/[\b\f\t\r\n](?=[a-zA-Z]{2})/g, (c) => `\\${CONTROL_LETTER[c] ?? ''}`);
}
