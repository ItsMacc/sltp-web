// completions.ts — the editor's instant completion source.
//
// Monaco asks this first and gets a list with no round trip: the names this
// file actually declares, its parameters and members, Python keywords and
// builtins, and the engine's own surface read from the installed package.
// Jedi then adds what only inference knows, and can never hold the popup shut.
//
// Two rules keep the list something a reader would keep open:
//
//   * only declarations are candidates — never every word in the file, so a
//     ticker in a list or a keyword in a docstring is not "in this file";
//   * where an IDE stays silent (naming a def or class, a comment, the inside
//     of a string) this source says nothing either, rather than filling the
//     popup with `any`, `bool` and `from`.

import type * as MonacoNs from 'monaco-editor';

export type Monaco = typeof MonacoNs;
type Model = MonacoNs.editor.ITextModel;
type CompletionItem = MonacoNs.languages.CompletionItem;
type CompletionKind = MonacoNs.languages.CompletionItemKind;

/** Public name to its members, as symbol_index() reports them. */
export interface SymbolIndex {
  [name: string]: string[];
}

let index: SymbolIndex = {};

export function setSymbolIndex(next: SymbolIndex | null): void {
  index = next ?? {};
}

export function hasSymbolIndex(): boolean {
  return Object.keys(index).length > 0;
}

/** Modules offered after `import` and `from ... import`. */
const MODULES = [
  'sltp',
  'sltp.market',
  'sltp.graphs',
  'sltp.utils',
  'sltp.web',
  'collections',
  'dataclasses',
  'datetime',
  'functools',
  'itertools',
  'json',
  'math',
  'numpy',
  'os',
  'pathlib',
  'random',
  're',
  'statistics',
  'sys',
  'time',
  'typing',
];

const KEYWORDS = [
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break',
  'case', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except',
  'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda',
  'match', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while',
  'with', 'yield',
];

const BUILTINS = [
  'ArithmeticError', 'AssertionError', 'AttributeError', 'BaseException',
  'Exception', 'FileNotFoundError', 'ImportError', 'IndexError', 'KeyError',
  'NotImplementedError', 'OSError', 'PermissionError', 'RuntimeError',
  'StopIteration', 'TypeError', 'ValueError', 'ZeroDivisionError', 'abs', 'all',
  'any', 'bool', 'bytes', 'callable', 'dict', 'dir', 'divmod', 'enumerate',
  'filter', 'float', 'format', 'frozenset', 'getattr', 'hasattr', 'hash',
  'help', 'hex', 'id', 'input', 'int', 'isinstance', 'issubclass', 'iter',
  'len', 'list', 'map', 'max', 'min', 'next', 'object', 'oct', 'open', 'ord',
  'print', 'range', 'repr', 'reversed', 'round', 'set', 'setattr', 'slice',
  'sorted', 'str', 'sum', 'super', 'tuple', 'type', 'zip',
];

/** The handful of shapes a reader retypes most often. */
const SNIPPETS: { label: string; body: string; detail: string }[] = [
  { label: 'def', body: 'def ${1:name}(${2:self}) -> ${3:None}:\n    ${0:pass}', detail: 'method' },
  { label: 'class', body: 'class ${1:Name}(${2:Strategy}):\n    ${0:pass}', detail: 'class' },
  { label: 'for', body: 'for ${1:item} in ${2:items}:\n    ${0:pass}', detail: 'loop' },
  { label: 'if', body: 'if ${1:condition}:\n    ${0:pass}', detail: 'branch' },
  { label: 'while', body: 'while ${1:condition}:\n    ${0:pass}', detail: 'loop' },
  { label: 'try', body: 'try:\n    ${1:pass}\nexcept ${2:Exception} as error:\n    ${0:raise}', detail: 'error handling' },
  { label: 'with', body: 'with ${1:expr} as ${2:value}:\n    ${0:pass}', detail: 'context manager' },
];

/** The dunders any class can define, offered while a method is named. */
const DUNDERS = [
  '__init__', '__repr__', '__str__', '__len__', '__eq__', '__hash__', '__iter__',
  '__next__', '__call__', '__bool__', '__contains__', '__getitem__', '__setitem__',
  '__enter__', '__exit__', '__del__',
];

/**
 * The one dunder a half-typed name is already the start of, if there is one:
 * `__ini` is `__init__`, while `__i` could be `__init__` or `__iter__` and so
 * answers nothing.
 */
export function uniqueDunder(word: string): string | null {
  if (!word.startsWith('__')) return null;
  const matches = DUNDERS.filter((name) => name.startsWith(word));
  return matches.length === 1 ? matches[0] : null;
}

/**
 * True when a method name being typed already matches an override or a
 * dunder, so accepting Enter has somewhere to land.
 *
 * `def __ini` matches `__init__`; `def AAPL` matches nothing, and offering
 * that empty list is the "No suggestions." box an IDE never shows.
 */
export function namingHasCandidates(word: string): boolean {
  const names = [...(index['Strategy.methods'] ?? []), ...DUNDERS];
  return names.some((name) => matchScore(name, word) >= 0);
}

type DeclKind = 'class' | 'function' | 'variable' | 'field' | 'parameter' | 'module';

interface Decl {
  name: string;
  kind: DeclKind;
  line: number;
}

/** A member offered after a dot, with the word shown beside it. */
interface Member {
  name: string;
  detail: string;
}

interface Facts {
  version: number;
  className: string | null;
  inheritsStrategy: boolean;
  /** The current class's bases, so a parent class here is not lost. */
  bases: string[];
  classMembers: Decl[];
  /** Variable to the class its value looks like, for `x = Strategy()`. */
  names: Map<string, string>;
  /** Local import alias to the module or class it points at. */
  aliases: Map<string, string>;
  declared: Decl[];
  /** Whether each line begins inside a triple-quoted string. */
  lineStart: ('code' | 'string')[];
}

const RESERVED = new Set([...KEYWORDS, 'self', 'cls']);

function parseParams(signature: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const character of signature) {
    if ('([{'.includes(character)) depth += 1;
    else if (')]}'.includes(character)) depth -= 1;
    if (character === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts
    .map((part) => part.split('=')[0].split(':')[0].replace(/^\*+/, '').trim())
    .filter((name) => /^[A-Za-z_]\w*$/.test(name) && name !== 'self' && name !== 'cls');
}

/**
 * Advances triple-quote state across one line. A line that holds only `"""`
 * closes the docstring it is in; counting delimiters alone reads that as an
 * opening and swallows the rest of the file.
 */
function advanceTriple(text: string, open: string | null): string | null {
  let at = 0;
  let current = open;
  while (at < text.length) {
    if (current) {
      const close = text.indexOf(current, at);
      if (close < 0) return current;
      at = close + 3;
      current = null;
      continue;
    }
    const double = text.indexOf('"""', at);
    const single = text.indexOf("'''", at);
    const next = double < 0 ? single : single < 0 ? double : Math.min(double, single);
    if (next < 0) return null;
    current = text.startsWith('"""', next) ? '"""' : "'''";
    at = next + 3;
  }
  return current;
}

function parse(lines: string[], version: number): Facts {
  const facts: Facts = {
    version,
    className: null,
    inheritsStrategy: false,
    bases: [],
    classMembers: [],
    names: new Map(),
    aliases: new Map(),
    declared: [],
    lineStart: [],
  };

  let classIndent = -1;
  let triple: string | null = null;

  const declare = (name: string | undefined, kind: DeclKind, line: number) => {
    if (!name || RESERVED.has(name)) return;
    facts.declared.push({ name, kind, line });
  };

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const lineNo = i + 1;
    facts.lineStart.push(triple ? 'string' : 'code');
    if (triple) {
      // A line that starts inside a docstring holds no code to read.
      triple = advanceTriple(raw, triple);
      continue;
    }

    const stripped = raw.trim();
    if (!stripped || stripped.startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;

    const classMatch = /^class\s+([A-Za-z_]\w*)\s*(?:\(([^)]*)\))?/.exec(stripped);
    if (classMatch) {
      facts.className = classMatch[1];
      facts.inheritsStrategy = /\bStrategy\b/.test(classMatch[2] ?? '');
      facts.bases = (classMatch[2] ?? '')
        .split(',')
        .map((base) => base.trim().split(/[[(]/)[0].trim())
        .filter(Boolean);
      classIndent = indent;
      declare(classMatch[1], 'class', lineNo);
      continue;
    }
    if (classIndent >= 0 && indent <= classIndent && !stripped.startsWith('@')) {
      facts.className = null;
      classIndent = -1;
    }

    const method = /^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(([^)]*)/.exec(stripped);
    if (method) {
      declare(method[1], 'function', lineNo);
      if (facts.className) facts.classMembers.push({ name: method[1], kind: 'function', line: lineNo });
      for (const name of parseParams(method[2])) declare(name, 'parameter', lineNo);
      continue;
    }

    const field = /^self\.([A-Za-z_]\w*)\s*(?::[^=]+)?=/.exec(stripped);
    if (field) {
      facts.classMembers.push({ name: field[1], kind: 'field', line: lineNo });
      continue;
    }

    const loop = /^for\s+(.+?)\s+in\b/.exec(stripped);
    if (loop) {
      const targets = loop[1].replace(/[()]/g, '').split(',');
      for (const target of targets) declare(target.trim(), 'variable', lineNo);
    }
    const context = /^(?:with|except)\b.*\bas\s+([A-Za-z_]\w*)/.exec(stripped);
    if (context) declare(context[1], 'variable', lineNo);

    // Imports, so `s` resolves to `sltp` and `S` to `Strategy`.
    const fromImport = /^from\s+([\w.]+)\s+import\s+(.+)$/.exec(stripped);
    if (fromImport) {
      for (const part of fromImport[2].split(',')) {
        const piece = part.trim().split(/\s+as\s+/);
        const name = piece[0].replace(/[()]/g, '').trim();
        if (!name || name === '*') continue;
        const local = piece[1]?.trim() || name;
        facts.aliases.set(local, name);
        declare(local, 'module', lineNo);
      }
      continue;
    }
    const plainImport = /^import\s+(.+)$/.exec(stripped);
    if (plainImport) {
      for (const part of plainImport[1].split(',')) {
        const piece = part.trim().split(/\s+as\s+/);
        const module = piece[0].trim();
        if (!module) continue;
        const local = piece[1]?.trim() || module.split('.')[0];
        facts.aliases.set(local, module);
        declare(local, 'module', lineNo);
      }
      continue;
    }

    // `history: StockData = ...` or `data = StockData(...)`.
    const annotated = /^([A-Za-z_]\w*)\s*:\s*([A-Za-z_][\w.]*)/.exec(stripped);
    if (annotated) {
      if (/^[A-Z]/.test(annotated[2])) facts.names.set(annotated[1], annotated[2]);
      declare(annotated[1], 'variable', lineNo);
    }
    const assignment = /^([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*=(?!=)/.exec(stripped);
    if (assignment) {
      for (const name of assignment[1].split(',')) declare(name.trim(), 'variable', lineNo);
      const constructed = /^[A-Za-z_]\w*\s*=\s*([A-Z][\w.]*)\s*\(/.exec(stripped);
      if (constructed) facts.names.set(assignment[1].trim(), constructed[1]);
    }

    // A docstring opened on this line hides the lines that follow it.
    triple = advanceTriple(raw, null);
  }

  return facts;
}

const factCache = new WeakMap<Model, Facts>();

function factsFor(model: Model): Facts {
  const version = model.getVersionId();
  const cached = factCache.get(model);
  if (cached && cached.version === version) return cached;
  const facts = parse(model.getLinesContent(), version);
  factCache.set(model, facts);
  return facts;
}

/** Names declared in the project's other files, offered with their file. */
let external: { name: string; detail: string }[] = [];

export function setProjectSources(files: Record<string, string>): void {
  const seen = new Set<string>();
  const found: { name: string; detail: string }[] = [];
  for (const [file, content] of Object.entries(files)) {
    const facts = parse(content.split('\n'), 0);
    for (const decl of facts.declared) {
      if (decl.kind === 'parameter' || decl.kind === 'module' || seen.has(decl.name)) continue;
      seen.add(decl.name);
      found.push({ name: decl.name, detail: file });
    }
  }
  external = found.slice(0, 300);
}

/** Where the cursor sits, in the terms a completion source thinks in. */
interface Cursor {
  word: string;
  base: string | null;
  module: string | null;
  importing: boolean;
  /** Set while a def or class is being named, where only overrides apply. */
  naming: 'method' | 'class' | null;
}

function readCursor(lineBefore: string): Cursor {
  const method = /^\s*(?:async\s+)?def\s*([A-Za-z_]\w*)?\s*$/.exec(lineBefore);
  if (method) {
    return { word: method[1] ?? '', base: null, module: null, importing: false, naming: 'method' };
  }
  const klass = /^\s*class\s*([A-Za-z_]\w*)?\s*$/.exec(lineBefore);
  if (klass) {
    return { word: klass[1] ?? '', base: null, module: null, importing: false, naming: 'class' };
  }

  // `from sltp` on its own is still a module being named.
  const fromOnly = /^\s*from\s+([\w.]*)\s*$/.exec(lineBefore);
  if (fromOnly) return { word: fromOnly[1], base: null, module: '', importing: true, naming: null };

  const fromImport = /from\s+([\w.]*)\s+import\s+([\w,\s(]*)$/.exec(lineBefore);
  if (fromImport) {
    return {
      word: fromImport[2].match(/[\w]+$/)?.[0] ?? '',
      base: null,
      module: fromImport[1],
      importing: true,
      naming: null,
    };
  }
  if (/^\s*import\s+[\w.,\s]*$/.test(lineBefore)) {
    const typed = lineBefore.replace(/^\s*import\s+/, '').split(',').pop() ?? '';
    return { word: typed.trim(), base: null, module: '', importing: true, naming: null };
  }
  const member = /([A-Za-z_][\w.]*)\.([A-Za-z_]\w*)?$/.exec(lineBefore);
  if (member) return { word: member[2] ?? '', base: member[1], module: null, importing: false, naming: null };
  const word = /([A-Za-z_]\w*)$/.exec(lineBefore);
  return { word: word?.[1] ?? '', base: null, module: null, importing: false, naming: null };
}

/**
 * Whether the cursor is in code, a string or a comment. A docstring can open
 * lines earlier, so each line's starting state is part of the facts.
 */
function stateAt(facts: Facts, lines: string[], lineNumber: number, column: number): 'code' | 'string' | 'comment' {
  if (facts.lineStart[lineNumber - 1] === 'string') return 'string';
  const text = lines[lineNumber - 1].slice(0, column - 1);
  let quote: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const character = text[i];
    if (quote) {
      if (character === '\\') {
        i += 1;
        continue;
      }
      if (quote.length === 3) {
        if (text.startsWith(quote, i)) {
          quote = null;
          i += 2;
        }
        continue;
      }
      if (character === quote) quote = null;
      continue;
    }
    if (character === '#') return 'comment';
    if (character === '"' || character === "'") {
      const triple = character.repeat(3);
      if (text.startsWith(triple, i)) {
        quote = triple;
        i += 2;
      } else {
        quote = character;
      }
    }
  }
  return quote ? 'string' : 'code';
}

/** What a base identifier is known to hold, or null when only jedi can say. */
function membersOf(base: string, facts: Facts): Member[] | null {
  const resolve = (name: string) => facts.aliases.get(name) ?? name;
  const direct = resolve(base);
  if (direct === 'self' || direct === 'cls') {
    const members: Member[] = [];
    const seen = new Set<string>();
    for (const decl of facts.classMembers) {
      if (seen.has(decl.name)) continue;
      seen.add(decl.name);
      members.push({ name: decl.name, detail: decl.kind === 'field' ? 'field' : 'method' });
    }
    if (facts.inheritsStrategy) {
      for (const name of index.Strategy ?? []) {
        if (seen.has(name) || name.startsWith('__')) continue;
        seen.add(name);
        members.push({ name, detail: 'Strategy' });
      }
    }
    return members;
  }

  const dotted = direct.split('.').map(resolve).join('.');
  const table = index[dotted] ?? (dotted === 'sltp' ? index.sltp : undefined);
  if (table) return table.filter((name) => !name.startsWith('__')).map((name) => ({ name, detail: dotted }));

  const object = facts.names.get(base);
  if (object && index[object]) return index[object].map((name) => ({ name, detail: object }));

  // These names mean one thing in this engine, and the reader knows it.
  if (base === 'data' || base === 'history') {
    return index.StockData?.map((name) => ({ name, detail: 'StockData' })) ?? null;
  }
  if (base === 'trade' || base === 'lot') {
    return index.Trade?.map((name) => ({ name, detail: 'Trade' })) ?? null;
  }
  return null;
}

function kindOfName(monaco: Monaco, name: string): CompletionKind {
  const kinds = monaco.languages.CompletionItemKind;
  if (/^[A-Z][a-z]/.test(name)) return kinds.Class;
  if (name.startsWith('__')) return kinds.Method;
  if (/^[A-Z0-9_]+$/.test(name)) return kinds.Constant;
  if (/^[a-z]+$/.test(name) && BUILTINS.includes(name)) return kinds.Function;
  return kinds.Field;
}

function kindOfDecl(monaco: Monaco, kind: DeclKind): CompletionKind {
  const kinds = monaco.languages.CompletionItemKind;
  if (kind === 'class') return kinds.Class;
  if (kind === 'function') return kinds.Method;
  if (kind === 'module') return kinds.Module;
  if (kind === 'field') return kinds.Field;
  if (kind === 'parameter') return kinds.Variable;
  return kinds.Variable;
}

/**
 * The file's outline: the classes, methods and names it declares, in the order
 * they appear. This is what "Go to symbol in file" and the document outline
 * read, and it is the same parse the completion list is built from, so it
 * costs no round trip and cannot disagree with the editor.
 */
export function documentSymbols(
  monaco: Monaco,
  model: Model,
): MonacoNs.languages.DocumentSymbol[] {
  const facts = factsFor(model);
  const kinds = monaco.languages.SymbolKind;
  const seen = new Set<string>();
  const symbols: MonacoNs.languages.DocumentSymbol[] = [];
  const symbolKind = (kind: DeclKind): MonacoNs.languages.SymbolKind => {
    if (kind === 'class') return kinds.Class;
    if (kind === 'function') return kinds.Function;
    if (kind === 'module') return kinds.Module;
    if (kind === 'field') return kinds.Field;
    return kinds.Variable;
  };
  for (const decl of facts.declared) {
    // A parameter belongs to its function, not to the file's structure.
    if (decl.kind === 'parameter') continue;
    const key = `${decl.line}:${decl.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const line = Math.min(Math.max(decl.line, 1), Math.max(model.getLineCount(), 1));
    const text = model.getLineContent(line);
    const at = text.indexOf(decl.name);
    const column = at >= 0 ? at + 1 : 1;
    symbols.push({
      name: decl.name,
      detail: decl.kind === 'field' ? 'attribute' : decl.kind,
      kind: symbolKind(decl.kind),
      tags: [],
      range: {
        startLineNumber: line,
        startColumn: 1,
        endLineNumber: line,
        endColumn: model.getLineMaxColumn(line),
      },
      selectionRange: {
        startLineNumber: line,
        startColumn: column,
        endLineNumber: line,
        endColumn: column + decl.name.length,
      },
    });
  }
  return symbols.slice(0, 500);
}

/**
 * How well a name answers the typed word, or -1 when it does not.
 *
 * 0 the word starts the name, 1 it starts it ignoring case, 2 the word is the
 * initials of its underscore or camel-case parts (`iu` for
 * `initialize_universe`). Nothing else qualifies: a subsequence match is how
 * `slice` ended up under `sel`, and an IDE does not offer it.
 */
function matchScore(name: string, word: string): number {
  if (!word) return 0;
  if (name.startsWith(word)) return 0;
  const lower = word.toLowerCase();
  if (name.toLowerCase().startsWith(lower)) return 1;
  if (word.length >= 2) {
    const initials = name
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean)
      .map((part) => part[0] ?? '')
      .join('')
      .toLowerCase();
    if (initials.startsWith(lower)) return 2;
  }
  return -1;
}

/** One entry per name, preferring the declaration nearest above the cursor. */
function uniqueDecls(facts: Facts, line: number): Decl[] {
  const best = new Map<string, Decl>();
  for (const decl of facts.declared) {
    const current = best.get(decl.name);
    if (!current) {
      best.set(decl.name, decl);
      continue;
    }
    const score = (entry: Decl) => (entry.line <= line ? 0 : 1_000_000) + Math.abs(entry.line - line);
    if (score(decl) < score(current)) best.set(decl.name, decl);
  }
  return [...best.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export interface LocalReply {
  items: CompletionItem[];
  /** True when this source knows the whole answer, so jedi need not be asked. */
  certain: boolean;
}

/**
 * The completion list before any Python work.
 *
 * Declared names are the whole list for an empty prefix, which is what an IDE
 * shows when asked for completions on a blank line: locals, parameters, this
 * file's functions and classes — never the language's keywords.
 */
export function localSuggestions(
  monaco: Monaco,
  model: Model,
  position: MonacoNs.Position,
): LocalReply {
  const facts = factsFor(model);
  const lines = model.getLinesContent();
  // Monaco can ask with a position from a model it has already replaced;
  // reading that line would throw and take the whole list down with it.
  const lineNumber = Math.min(Math.max(position.lineNumber, 1), Math.max(model.getLineCount(), 1));
  const column = Math.min(
    Math.max(position.column, 1),
    model.getLineMaxColumn(lineNumber),
  );
  const lineBefore = model.getLineContent(lineNumber).slice(0, column - 1);
  const cursor = readCursor(lineBefore);

  // A comment or an open string has nothing to offer, and offering
  // `any`/`bool`/`from` there is what made this list untrustworthy.
  if (stateAt(facts, lines, lineNumber, column) !== 'code') {
    return { items: [], certain: true };
  }
  // A class is being named: no existing name applies to it.
  if (cursor.naming === 'class') return { items: [], certain: true };

  const word = cursor.word;
  const range = monaco.Range.fromPositions(
    new monaco.Position(lineNumber, column - word.length),
    new monaco.Position(lineNumber, column),
  );
  const items: CompletionItem[] = [];
  const seen = new Map<string, number>();
  // A function accepted from the list opens its call, the way an IDE does:
  // `pri` + Enter becomes `print()` with the cursor between the brackets,
  // unless the reader already typed the opening one.
  const callsWithParens = (kind: CompletionKind) =>
    (kind === monaco.languages.CompletionItemKind.Function ||
      kind === monaco.languages.CompletionItemKind.Method) &&
    model.getLineContent(lineNumber)[column - 1] !== '(';

  // `rank` groups a kind of answer; within a group the match score decides,
  // then the name, so a prefix match always outranks initials.
  const push = (
    label: string,
    kind: CompletionKind,
    rank: string,
    detail: string | undefined,
    extra?: Partial<CompletionItem>,
  ) => {
    if (label.startsWith('_') && !word.startsWith('_')) return;
    const score = matchScore(label, word);
    if (score < 0) return;
    const previous = seen.get(label);
    if (previous !== undefined && previous <= score) return;
    if (previous !== undefined) {
      const at = items.findIndex((item) => String(item.label) === label);
      if (at >= 0) items.splice(at, 1);
    }
    seen.set(label, score);
    const call = callsWithParens(kind) && extra?.insertText === undefined;
    items.push({
      label,
      kind,
      detail,
      insertText: call ? `${label}($0)` : label,
      insertTextRules: call
        ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
        : undefined,
      // The parameter list opens with the call, as it does in an IDE. The
      // brackets come from the snippet, so nothing types the `(` that would
      // normally ask jedi for the signature.
      command: call
        ? { id: 'editor.action.triggerParameterHints', title: 'Parameter info' }
        : undefined,
      filterText: label,
      sortText: `${score}${rank}${label}`,
      range,
      ...extra,
    });
  };

  // Naming a method: overriding the base class's methods is what an IDE
  // offers here, plus the dunders every class can define.
  if (cursor.naming === 'method') {
    for (const name of [...(index['Strategy.methods'] ?? []), ...DUNDERS]) {
      const dunder = name.startsWith('__');
      push(
        name,
        monaco.languages.CompletionItemKind.Method,
        '1',
        dunder ? 'dunder' : 'override',
        // A dunder is a whole signature, so accepting one writes the
        // parentheses and the body line: `def __ini` + Enter becomes
        // `def __init__(self):` with the cursor indented under it.
        dunder
          ? {
              insertText: `${name}(self):\n    $0`,
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            }
          : undefined,
      );
    }
    return { items, certain: true };
  }

  if (cursor.importing) {
    const module = cursor.module ?? '';
    const exported = index[module];
    if (exported) {
      for (const name of exported) push(name, kindOfName(monaco, name), '1', `from ${module}`);
      return { items, certain: false };
    }
    if (!module) {
      for (const name of MODULES) {
        if (!name.startsWith(word)) continue;
        push(name, monaco.languages.CompletionItemKind.Module, '1', 'module');
      }
    }
    return { items, certain: false };
  }

  if (cursor.base) {
    const members = membersOf(cursor.base, facts);
    if (members) {
      for (const member of members) {
        // A method this file declares is a method, not an attribute: the
        // popup's icon is how a reader tells the two apart at a glance.
        push(
          member.name,
          member.detail === 'method'
            ? monaco.languages.CompletionItemKind.Method
            : kindOfName(monaco, member.name),
          '1',
          member.detail,
        );
      }
      // `self.` is answered from this file's own class, which cannot see what a
      // parent class the reader wrote adds. Claiming certainty there kept jedi
      // from being asked, so an inherited method simply never appeared.
      const resolved = facts.aliases.get(cursor.base) ?? cursor.base;
      const isInstance = resolved === 'self' || resolved === 'cls';
      const inheritsUserCode = facts.bases.some(
        (base) => base !== 'Strategy' && base !== 'object' && base !== 'ABC',
      );
      return { items, certain: !(isInstance && inheritsUserCode) };
    }
  }

  // Inside a class, `self` is a name the reader types constantly.
  if (facts.className) {
    push('self', monaco.languages.CompletionItemKind.Variable, '0', 'instance');
    push('cls', monaco.languages.CompletionItemKind.Variable, '0', 'class');
  }

  // The file's own declarations, then the project's other files.
  for (const decl of uniqueDecls(facts, lineNumber)) {
    push(decl.name, kindOfDecl(monaco, decl.kind), '1', decl.kind);
  }
  // A `Strategy` subclass inherits the engine's hooks, so they are names in
  // scope here just as much as the reader's own methods.
  if (facts.inheritsStrategy) {
    for (const name of index['Strategy.methods'] ?? []) {
      push(name, monaco.languages.CompletionItemKind.Method, '2', 'Strategy');
    }
  }
  for (const other of external) {
    push(other.name, kindOfName(monaco, other.name), '3', other.detail);
  }

  // Language and engine names only once a prefix exists: an empty prefix is a
  // question about this file, not about Python.
  if (word.length > 0) {
    for (const snippet of SNIPPETS) {
      push(snippet.label, monaco.languages.CompletionItemKind.Snippet, '4', snippet.detail, {
        insertText: snippet.body,
        insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
      });
    }
    for (const keyword of KEYWORDS) {
      push(keyword, monaco.languages.CompletionItemKind.Keyword, '5', 'keyword');
    }
    for (const builtin of BUILTINS) {
      push(builtin, monaco.languages.CompletionItemKind.Function, '6', 'builtin');
    }
  }

  return { items: items.slice(0, 200), certain: false };
}
