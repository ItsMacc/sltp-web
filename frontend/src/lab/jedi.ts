// jedi.ts — the editor's Python intelligence, answered by the interpreter that
// is already running the reader's code.
//
// Jedi is a Python package, so it needs no worker of its own, no typeshed and no
// stub files: `analyze()` in the Python worker hands it the project and asks.
// That is why completion here knows the real installed sltp and numpy rather
// than a generated description of them, and why the editor works the same in
// every browser.
//
// Pyflakes provides what jedi does not: name and syntax errors. Together they
// cover completion, hover, signatures, go-to-definition and error squiggles.
import type * as MonacoNs from 'monaco-editor';
import { analyze } from './pythonRunner';
import {
  documentSymbols,
  hasSymbolIndex,
  localSuggestions,
  setProjectSources,
  setSymbolIndex,
  type SymbolIndex,
} from './completions';

export type Monaco = typeof MonacoNs;
export type TextModel = MonacoNs.editor.ITextModel;

export interface JediTarget {
  monaco: Monaco;
  model: TextModel;
  /** Workspace-relative path, e.g. "workspace/macoon.py". */
  path: string;
}

interface CompletionItem {
  label: string;
  insertText?: string;
  kind?: string;
  detail?: string;
  documentation?: string;
}

interface HoverInfo {
  name: string;
  type: string;
  description?: string;
  doc?: string;
}

export interface DefinitionInfo {
  path: string | null;
  external: boolean;
  line: number;
  column: number;
  name: string;
}

interface ImportCandidate {
  label: string;
  kind?: string;
  detail?: string;
  statement: string;
}

interface SignatureInfo {
  label: string;
  params: string[];
  doc?: string;
}

interface DiagnosticItem {
  line: number;
  column: number;
  message: string;
  severity: number;
}

type Status = 'active' | 'failed';
let statusListener: ((status: Status, reason?: string) => void) | null = null;

/** Told when analysis starts working, and when it cannot. */
export function setJediStatusListener(listener: ((status: Status, reason?: string) => void) | null): void {
  statusListener = listener;
}

let target: JediTarget | null = null;
let projectFiles: Record<string, string> = {};
let registeredFor: Monaco | null = null;
let diagnosticTimer: number | null = null;
let changeListener: { dispose(): void } | null = null;

const SEVERITY = { error: 8, warning: 4, info: 2, hint: 1 };

function report(status: Status, reason?: string): void {
  statusListener?.(status, reason);
}

function currentPath(): string {
  if (!target) return 'workspace/untitled.py';
  const fromModel = target.model.uri.path.replace(/^\//, '');
  return target.path || fromModel || 'workspace/untitled.py';
}

function filesForAnalysis(): { name: string; content: string }[] {
  const names = new Set(Object.keys(projectFiles));
  if (target) names.add(currentPath());
  return [...names].map((name) => ({
    name,
    content: name === currentPath() && target ? target.model.getValue() : projectFiles[name] ?? '',
  }));
}

let busy = false;

/**
 * Silences analysis while a run owns the interpreter. Every request would
 * otherwise queue behind it and delay the run's first output.
 */
export function setJediBusy(next: boolean): void {
  busy = next;
}

function ask(
  method: 'complete' | 'hover' | 'signature' | 'define' | 'diagnostics' | 'imports',
  position: MonacoNs.Position,
) {
  // A timer can outlive the editor: the model it captured was disposed when
  // the page navigated or the file changed, and reading it throws.
  if (busy || !target || target.model.isDisposed()) return null;
  return analyze({
    method,
    code: target.model.getValue(),
    path: currentPath(),
    line: position.lineNumber,
    column: position.column - 1,
    files: filesForAnalysis(),
  }).then((reply) => {
    // A timeout means the interpreter was busy, usually with a run of your own.
    // Reporting that as a failure is what made the status bar announce broken
    // analysis in the middle of a perfectly normal long backtest.
    if (!reply.ok && !(reply.error ?? '').includes('timed out')) report('failed', reply.error);
    else report('active');
    return reply;
  });
}

/** How long inference may hold a keystroke before the local list stands alone. */
const JEDI_BUDGET = 900;

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => window.setTimeout(() => resolve(null), ms)),
  ]);
}

let symbolIndexAsked = false;

/**
 * Reads the installed engine's public surface once per session. That is what
 * makes member completion for `self`, `sltp`, `data` and `trade` exact and
 * instant rather than one jedi inference per keystroke, and it is why a
 * release that adds a knob appears in the editor without a frontend change.
 */
let symbolPending: Promise<void> = Promise.resolve();

export function ensureSymbolIndex(): Promise<void> {
  if (hasSymbolIndex()) return Promise.resolve();
  if (symbolIndexAsked) return symbolPending;
  symbolIndexAsked = true;
  symbolPending = analyze({
    method: 'symbols',
    code: target?.model.getValue() ?? '',
    path: currentPath(),
    line: 1,
    column: 0,
    files: filesForAnalysis(),
  })
    .then((reply) => {
      if (reply.ok && reply.data) {
        setSymbolIndex(reply.data as SymbolIndex);
        report('active');
      } else {
        // Python is still starting; the next keystroke asks again.
        symbolIndexAsked = false;
      }
    })
    .catch(() => {
      symbolIndexAsked = false;
    });
  return symbolPending;
}

/** The in-flight engine surface, so a first keystroke can wait rather than
 * offer a list that is missing it. */
export function whenSymbolsReady(): Promise<void> {
  return symbolPending;
}

let fileOpener: ((path: string, line: number, column: number) => void) | null = null;

/** Called when the definition lives in another project file. */
export function setJediFileOpener(
  opener: ((path: string, line: number, column: number) => void) | null,
): void {
  fileOpener = opener;
}

/**
 * The edit that adds an import. A matching `from x import a, b` line is
 * extended in place, the way an IDE does, so a file keeps one import per
 * module instead of growing a new line every time a name is used.
 */
function importEdit(
  monaco: Monaco,
  model: TextModel,
  statement: string,
): MonacoNs.languages.TextEdit | null {
  const parsed = /^from\s+([\w.]+)\s+import\s+(.+)$/.exec(statement);
  if (parsed) {
    const [, moduleName, names] = parsed;
    const wanted = names.split(',').map((name) => name.trim()).filter(Boolean);
    const escaped = moduleName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = new RegExp(`^from\\s+${escaped}\\s+import\\s+(.+)$`);
    const limit = Math.min(model.getLineCount(), 400);
    for (let index = 1; index <= limit; index += 1) {
      const line = model.getLineContent(index);
      const found = matches.exec(line);
      if (!found) continue;
      const imported = found[1].trim();
      // A parenthesised or continued import is not worth rewriting blind.
      if (imported.startsWith('(')) continue;
      const beforeComment = imported.replace(/\s*#.*$/, '').replace(/\\$/, '').trim();
      const present = beforeComment.split(',').map((name) => name.trim().split(/\s+as\s+/)[0]);
      const missing = wanted.filter((name) => !present.includes(name.split(/\s+as\s+/)[0]));
      if (!missing.length) return null;
      // Insert before a trailing comment, not after it, and without leaving
      // the extra space that was padding it.
      let column = model.getLineMaxColumn(index);
      let tail = '';
      const commentAt = line.indexOf('#');
      if (commentAt >= 0) {
        let at = commentAt;
        while (at > 0 && line[at - 1] === ' ') at -= 1;
        column = at + 1;
        tail = ' ';
      }
      const separator = beforeComment.endsWith(',') ? ' ' : ', ';
      return {
        range: new monaco.Range(index, column, index, column),
        text: `${separator}${missing.join(', ')}${tail}`,
      };
    }
  }

  // Follow brackets so an import never lands inside a parenthesised one.
  let lastImport = 0;
  let depth = 0;
  let continued = false;
  const limit = Math.min(model.getLineCount(), 80);
  for (let index = 1; index <= limit; index += 1) {
    const line = model.getLineContent(index);
    const startsImport = /^\s*(from|import)\s/.test(line);
    if (startsImport && depth === 0) lastImport = index;
    for (const character of line) {
      if (character === '(' || character === '[' || character === '{') depth += 1;
      else if (character === ')' || character === ']' || character === '}') depth = Math.max(0, depth - 1);
    }
    if (startsImport && depth > 0) continued = true;
    else if (continued && depth === 0) {
      lastImport = index;
      continued = false;
    }
  }
  if (lastImport) {
    const column = model.getLineMaxColumn(lastImport);
    return {
      range: new monaco.Range(lastImport, column, lastImport, column),
      text: `\n${statement}`,
    };
  }
  return { range: new monaco.Range(1, 1, 1, 1), text: `${statement}\n` };
}

function wordRange(monaco: Monaco, model: TextModel, position: MonacoNs.Position) {
  const word = model.getWordUntilPosition(position);
  return new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
}

/** The whole identifier at the position, or nothing on blank space. */
function nameRange(
  monaco: Monaco,
  model: TextModel,
  position: MonacoNs.Position,
): MonacoNs.Range | undefined {
  const word = model.getWordAtPosition(position);
  if (!word) return undefined;
  return new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
}

function completionKind(monaco: Monaco, type: string | undefined): MonacoNs.languages.CompletionItemKind {
  const kinds = monaco.languages.CompletionItemKind;
  switch (type) {
    case 'class':
      return kinds.Class;
    case 'function':
      return kinds.Function;
    case 'module':
      return kinds.Module;
    case 'keyword':
      return kinds.Keyword;
    case 'param':
      return kinds.Variable;
    case 'instance':
      return kinds.Variable;
    case 'statement':
      return kinds.Variable;
    default:
      return kinds.Text;
  }
}

function register(monaco: Monaco): void {
  if (registeredFor === monaco) return;
  registeredFor = monaco;

  monaco.languages.registerCompletionItemProvider('python', {
    // A dot is the only character whose answer is already known; a quote or a
    // bracket used to spend a round trip on a name list that is empty there.
    triggerCharacters: ['.'],
    provideCompletionItems: async (model, position) => {
      // The engine's surface is one request per session; until it lands the
      // local list still answers with keywords, builtins and file names.
      void ensureSymbolIndex();
      // One bounded wait, only until the engine's surface has landed: without
      // it the very first `self.` would be missing every inherited method.
      if (!hasSymbolIndex()) await withDeadline(whenSymbolsReady(), 800);
      // Monaco can ask for a position from a buffer it has already replaced;
      // every read below would throw on that line and drop the whole list.
      const line = Math.min(Math.max(position.lineNumber, 1), Math.max(model.getLineCount(), 1));
      const column = Math.min(Math.max(position.column, 1), model.getLineMaxColumn(line));
      const safe = new monaco.Position(line, column);
      const local = localSuggestions(monaco, model, safe);
      const range = wordRange(monaco, model, safe);
      const typed = model.getWordUntilPosition(safe).word;
      const showPrivate = typed.startsWith('_');
      const seen = new Set<string>();
      const suggestions: MonacoNs.languages.CompletionItem[] = [];
      const add = (item: MonacoNs.languages.CompletionItem) => {
        const label = String(item.label);
        // jedi offers private members too; they belong behind a leading
        // underscore, not in the list a reader scans while typing.
        if (seen.has(label) || (!showPrivate && label.startsWith('_'))) return;
        seen.add(label);
        // jedi hands back a bare name. A function accepted from the list opens
        // its call and asks for its parameters here, the same as one from the
        // local list, so the two sources do not behave differently.
        const kinds = monaco.languages.CompletionItemKind;
        const opensCall = (item.kind === kinds.Function || item.kind === kinds.Method)
          && item.insertText === label
          && model.getLineContent(line)[column - 1] !== '(';
        if (!opensCall) {
          suggestions.push({ ...item, range });
          return;
        }
        suggestions.push({
          ...item,
          insertText: `${label}($0)`,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          command: { id: 'editor.action.triggerParameterHints', title: 'Parameter info' },
          range,
        });
      };

      for (const item of local.items) add(item);

      // A known base, a keyword or a name already in the file is a complete
      // answer. Anything else is inference, and inference gets a ceiling: a
      // reply that has not arrived in under a second has not earned the
      // keystroke, and the list above is already on screen.
      if (!local.certain) {
        const pending = ask('complete', safe);
        const reply = pending ? await withDeadline(pending, JEDI_BUDGET) : null;
        for (const item of (reply?.data as { items?: CompletionItem[] } | null)?.items ?? []) {
          add({
            label: item.label,
            kind: completionKind(monaco, item.kind),
            detail: item.detail,
            documentation: item.documentation ? { value: item.documentation } : undefined,
            // The name, never jedi's `complete` field: that one carries only
            // the part of the word still missing, so accepting it on top of a
            // typed prefix ate the first letter ("B" became "acktester").
            insertText: item.label,
            range,
            sortText: `7${item.label}`,
          });
        }

        // Names that exist but were never imported, the way an IDE offers
        // them: with the import line attached. Only for a word being typed.
        if (typed.length >= 2) {
          const pendingImports = ask('imports', safe);
          const replyImports = pendingImports ? await withDeadline(pendingImports, JEDI_BUDGET) : null;
          const candidates = (replyImports?.data as { items?: ImportCandidate[] } | null)?.items ?? [];
          for (const candidate of candidates) {
            const alreadyImported = new RegExp(
              `^\\s*(from\\s+\\S+\\s+)?import\\s.*\\b${candidate.label}\\b`,
            ).test(model.getValue());
            if (alreadyImported) continue;
            const edit = importEdit(monaco, model, candidate.statement);
            add({
              label: candidate.label,
              kind: completionKind(monaco, candidate.kind),
              detail: `import from ${candidate.statement.replace(/^from\s+/, '').split(' import ')[0]}`,
              insertText: candidate.label,
              range,
              additionalTextEdits: edit ? [edit] : [],
              sortText: `z${candidate.label}`,
            });
          }
        }
      }

      // `incomplete` tells Monaco to ask again for every new character
      // instead of fuzzy-filtering this list: that reuse is how a name from an
      // earlier prefix survived into a later word.
      return { suggestions, incomplete: true };
    },
  });

  // The file's own structure, from the same parse the completion list uses:
  // "Go to symbol in file" lists the classes, methods and names that are
  // actually declared, the way an IDE's structure popup does. No round trip.
  monaco.languages.registerDocumentSymbolProvider('python', {
    provideDocumentSymbols: (model) => documentSymbols(monaco, model),
  });

  monaco.languages.registerHoverProvider('python', {
    provideHover: async (model, position) => {
      const reply = await ask('hover', position);
      const info = reply?.data as HoverInfo | null;
      if (!info) return null;
      const signature = info.description || `${info.name}: ${info.type}`;
      const contents: MonacoNs.IMarkdownString[] = [{ value: `\`\`\`python\n${signature}\n\`\`\`` }];
      if (info.doc) contents.push({ value: info.doc });
      // Scoped to the identifier under the pointer, as an IDE hovers a symbol
      // and not whatever blank space happens to share its line.
      return { contents, range: nameRange(monaco, model, position) };
    },
  });

  monaco.languages.registerSignatureHelpProvider('python', {
    signatureHelpTriggerCharacters: ['(', ','],
    provideSignatureHelp: async (_model, position) => {
      const reply = await ask('signature', position);
      const data = reply?.data as { signatures?: SignatureInfo[]; active?: number } | null;
      if (!data?.signatures?.length) return null;
      return {
        value: {
          signatures: data.signatures.map((signature) => ({
            label: `${signature.label}(${signature.params.join(', ')})`,
            documentation: signature.doc ? { value: signature.doc } : undefined,
            parameters: signature.params.map((param) => ({ label: param })),
          })),
          activeSignature: 0,
          activeParameter: Math.min(data.active ?? 0, Math.max(data.signatures[0].params.length - 1, 0)),
        },
        dispose: () => undefined,
      };
    },
  });

  monaco.languages.registerDefinitionProvider('python', {
    provideDefinition: async (model, position) => {
      const reply = await ask('define', position);
      const definition = reply?.data as DefinitionInfo | null;
      if (!definition) return null;
      // A definition in another project file is handed to the page, which
      // opens that file and puts the cursor on the line.
      if (!definition.external && definition.path && definition.path !== currentPath()) {
        fileOpener?.(definition.path, definition.line, definition.column);
        return null;
      }
      if (definition.external) return null;
      return {
        uri: model.uri,
        range: {
          startLineNumber: definition.line,
          startColumn: definition.column,
          endLineNumber: definition.line,
          endColumn: definition.column + Math.max(definition.name.length, 1),
        },
      };
    },
  });
}

function scheduleDiagnostics(): void {
  if (diagnosticTimer) window.clearTimeout(diagnosticTimer);
  diagnosticTimer = window.setTimeout(() => {
    diagnosticTimer = null;
    void refreshDiagnostics();
  }, 650);
}

/** Runs the checker once and returns the same list the gutter marks. */
export async function checkNow(): Promise<{ path: string; items: DiagnosticItem[] } | null> {
  if (!target || target.model.isDisposed()) return null;
  const path = currentPath();
  const reply = await ask('diagnostics', { lineNumber: 1, column: 1 } as MonacoNs.Position);
  if (reply?.ok === false) return null;
  const items = ((reply?.data as { items?: DiagnosticItem[] } | null)?.items ?? []).filter(
    // Tidy-ups are noise while a file is being written; a name that does not
    // exist and a broken statement are not.
    (item) => !/imported but unused|assigned to but never used/i.test(item.message),
  );
  return { path, items };
}

async function refreshDiagnostics(): Promise<void> {
  if (!target) return;
  const { monaco, model } = target;
  const found = await checkNow();
  if (!found || target?.model.isDisposed()) return;
  const { items } = found;
  monaco.editor.setModelMarkers(
    model,
    'jedi',
    items.map((item) => ({
      severity: item.severity === 1 ? SEVERITY.error : SEVERITY.warning,
      message: item.message,
      startLineNumber: item.line,
      startColumn: item.column + 1,
      endLineNumber: item.line,
      endColumn: Math.max(item.column + 2, 2),
    })),
  );
}

/** Points the analyser at the file on screen and checks it straight away. */
export function setJediTarget(next: JediTarget | null): void {
  changeListener?.dispose();
  changeListener = null;
  target = next;
  if (!next) return;
  // Asked for as soon as a file opens, so `self.` already knows the engine's
  // members on the first keystroke rather than the keystroke after it.
  void ensureSymbolIndex();
  register(next.monaco);
  changeListener = next.model.onDidChangeContent(() => scheduleDiagnostics());
  scheduleDiagnostics();
}

/** The project's saved files, so imports between them resolve as they run. */
export function setJediProject(files: Record<string, string>): void {
  projectFiles = files;
  // The other files' names are offered as completions, the way an IDE offers
  // the project and not only the buffer under the cursor.
  setProjectSources(files);
  scheduleDiagnostics();
}
