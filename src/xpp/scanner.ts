/**
 * Minimal X++ source scanner: masks comments and string literals (preserving offsets and
 * newlines so line numbers stay valid), extracts method sources from AOT XML and finds
 * loop and select statements. Heuristic by design — there is no public X++ grammar to reuse.
 */

export interface XppComment {
  text: string;
  line: number;
}

export interface MaskedSource {
  /** Source with comment and string contents replaced by spaces (same length, same newlines). */
  code: string;
  comments: XppComment[];
}

export interface XppMethodSource {
  /** Method name, or "classDeclaration" for the declaration block. */
  name: string;
  source: string;
}

export interface XppBlock {
  kind: 'whileSelect' | 'while' | 'for' | 'do';
  /** Offset of the loop keyword. */
  start: number;
  /** Body range in the masked code (exclusive end). */
  bodyStart: number;
  bodyEnd: number;
  /** Header text (masked), e.g. "while select forupdate t where t.Qty > 0". */
  header: string;
}

const blank = (s: string) => s.replace(/[^\n]/g, ' ');

export function maskXpp(source: string): MaskedSource {
  const comments: XppComment[] = [];
  let out = '';
  let line = 1;
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const n = source[i + 1];
    if (c === '/' && n === '/') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      comments.push({ text: source.slice(i, stop), line });
      out += blank(source.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === '/' && n === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      const text = source.slice(i, stop);
      comments.push({ text, line });
      out += blank(text);
      line += (text.match(/\n/g) ?? []).length;
      i = stop;
      continue;
    }
    if (c === '"' || c === "'" || (c === '@' && (n === '"' || n === "'"))) {
      const verbatim = c === '@';
      const quote = verbatim ? n : c;
      let j = i + (verbatim ? 2 : 1);
      while (j < source.length) {
        if (!verbatim && source[j] === '\\') { j += 2; continue; }
        if (source[j] === quote) {
          if (verbatim && source[j + 1] === quote) { j += 2; continue; }
          break;
        }
        j++;
      }
      const stop = Math.min(j + 1, source.length);
      const text = source.slice(i, stop);
      const inner = text.slice(verbatim ? 2 : 1, text.length - 1);
      out += (verbatim ? ' ' : '') + quote + blank(inner) + quote;
      line += (text.match(/\n/g) ?? []).length;
      i = stop;
      continue;
    }
    if (c === '\n') line++;
    out += c;
    i++;
  }
  return { code: out.slice(0, source.length), comments };
}

/** Newline offsets of the last text `lineAt` saw; checks call it many times on one method. */
let lineIndex: { code: string; newlines: number[] } | undefined;

/** 1-based line of `offset`, by binary search over a cached newline index (linear scans made checks quadratic). */
export function lineAt(code: string, offset: number): number {
  if (lineIndex?.code !== code) {
    const newlines: number[] = [];
    for (let i = code.indexOf('\n'); i >= 0; i = code.indexOf('\n', i + 1)) newlines.push(i);
    lineIndex = { code, newlines };
  }
  const { newlines } = lineIndex;
  let low = 0;
  let high = newlines.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (newlines[mid] < offset) low = mid + 1;
    else high = mid;
  }
  return low + 1;
}

/** Index just past the bracket matching the one at `open`, or code.length when unbalanced. */
export function matchBrace(code: string, open: number, openCh = '{', closeCh = '}'): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === openCh) depth++;
    else if (code[i] === closeCh) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return code.length;
}

function skipSpace(code: string, i: number): number {
  while (i < code.length && /\s/.test(code[i])) i++;
  return i;
}

/** Body of a statement starting at `i`: a braced block or a single statement up to `;`. */
function statementBody(code: string, i: number): [number, number] {
  const s = skipSpace(code, i);
  if (code[s] === '{') return [s, matchBrace(code, s)];
  const semi = code.indexOf(';', s);
  return [s, semi === -1 ? code.length : semi + 1];
}

/** Finds `while select`, `while (…)`, `for (…)` and `do { … }` loops in masked code. */
export function findLoops(code: string): XppBlock[] {
  const loops: XppBlock[] = [];
  const re = /\b(while|for|do)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const kw = m[1].toLowerCase();
    const start = m.index;
    let after = skipSpace(code, start + m[0].length);
    if (kw === 'while' && /^select\b/i.test(code.slice(after, after + 7))) {
      // Header runs to the first `{` or `;`; a `{` opens the body, a `;` means a single-statement body.
      const brace = code.indexOf('{', after);
      const semi = code.indexOf(';', after);
      if (brace !== -1 && (semi === -1 || brace < semi)) {
        loops.push({ kind: 'whileSelect', start, bodyStart: brace, bodyEnd: matchBrace(code, brace), header: code.slice(start, brace).trim() });
      } else {
        const end = semi === -1 ? code.length : semi + 1;
        loops.push({ kind: 'whileSelect', start, bodyStart: start, bodyEnd: end, header: code.slice(start, end).trim() });
      }
      continue;
    }
    if (kw === 'do') {
      if (code[after] !== '{') continue;
      loops.push({ kind: 'do', start, bodyStart: after, bodyEnd: matchBrace(code, after), header: 'do' });
      continue;
    }
    if (code[after] !== '(') continue;
    const closeParen = matchBrace(code, after, '(', ')');
    // `} while (cond);` closes a do-loop rather than starting a new loop.
    after = skipSpace(code, closeParen);
    if (kw === 'while' && code[after] === ';') continue;
    const [bodyStart, bodyEnd] = statementBody(code, closeParen);
    loops.push({ kind: kw === 'for' ? 'for' : 'while', start, bodyStart, bodyEnd, header: code.slice(start, closeParen).trim() });
  }
  return loops;
}

const XML_METHOD_HEAD_RE = /^<Method>\s*<Name>([^<]+)<\/Name>/;
const XML_SOURCE_RE = /<Source>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/Source>/;
const XML_DECL_RE = /<Declaration>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/Declaration>/;

/**
 * Method sources of any AOT element with X++ code (class, table, form, data entity, map…).
 * Each `<Method>` is cut at the next one before its source is matched, so a method
 * without a source cannot make the search rescan the rest of the document.
 */
export function extractMethodSources(xml: string): XppMethodSource[] {
  const out: XppMethodSource[] = [];
  const declEnd = xml.indexOf('</Declaration>');
  const declStart = declEnd < 0 ? -1 : xml.lastIndexOf('<Declaration>', declEnd);
  const decl = declStart < 0 ? null : XML_DECL_RE.exec(xml.slice(declStart, declEnd + '</Declaration>'.length));
  if (decl && decl[1].trim()) out.push({ name: 'classDeclaration', source: decl[1] });
  for (let start = xml.indexOf('<Method>'); start >= 0; ) {
    const next = xml.indexOf('<Method>', start + 1);
    const segment = xml.slice(start, next < 0 ? xml.length : next);
    const head = XML_METHOD_HEAD_RE.exec(segment);
    const source = head ? XML_SOURCE_RE.exec(segment) : null;
    if (head && source) out.push({ name: head[1].trim(), source: source[1] });
    start = next;
  }
  return out;
}

/** Select qualifiers that are not buffer names. */
export const SELECT_KEYWORDS = new Set([
  'select', 'while', 'firstonly', 'firstonly10', 'firstonly100', 'firstonly1000', 'firstfast', 'forupdate',
  'nofetch', 'reverse', 'crosscompany', 'forceplaceholders', 'forceliterals', 'forceselectorder',
  'forcenestedloop', 'pessimisticlock', 'optimisticlock', 'repeatableread', 'generateonly', 'validtimestate',
  'count', 'sum', 'avg', 'minof', 'maxof',
]);

export interface SelectInfo {
  offset: number;
  isWhile: boolean;
  keywords: Set<string>;
  hasFieldList: boolean;
  buffer: string;
}

const MAX_SELECT_HEAD_LENGTH = 2_048;

/** Parses each `select` statement head: qualifiers, field list presence and target buffer. */
export function findSelects(code: string): SelectInfo[] {
  const out: SelectInfo[] = [];
  const re = /\bselect\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const before = code.slice(Math.max(0, m.index - 20), m.index);
    // `update_recordset`/`delete_from` have no `select`; `join` targets are handled by the outer select.
    const isWhile = /\bwhile\s*$/i.test(before);
    const rest = code.slice(m.index + 6, m.index + 6 + MAX_SELECT_HEAD_LENGTH);
    const stop = rest.search(/\b(where|join|exists|notexists|outer|order|group|index)\b|[{;)]/i);
    const head = (stop === -1 ? rest : rest.slice(0, stop)).replace(/\([^)]*\)/g, ' ');
    const words = head.match(/[A-Za-z_]\w*/g) ?? [];
    const keywords = new Set(words.map((w) => w.toLowerCase()).filter((w) => SELECT_KEYWORDS.has(w)));
    const fromIdx = words.findIndex((w) => w.toLowerCase() === 'from');
    const hasFieldList = fromIdx !== -1;
    const candidates = (hasFieldList ? words.slice(fromIdx + 1) : words).filter((w) => !SELECT_KEYWORDS.has(w.toLowerCase()));
    const buffer = hasFieldList ? candidates[0] ?? '' : candidates[candidates.length - 1] ?? '';
    out.push({ offset: m.index, isWhile, keywords, hasFieldList, buffer });
  }
  return out;
}
