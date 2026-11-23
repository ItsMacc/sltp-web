#!/usr/bin/env node
// The Lab's Python lives in TypeScript template literals, and TypeScript
// compiles those escapes before Python ever sees them. A stray `\n` or `\b`
// in that source is valid TypeScript, turns into a real newline or backspace at
// runtime, and only breaks in the browser: the analyser stops defining
// `analyze` and every completion dies with "name 'analyze' is not defined".
//
// So this reads the *cooked* strings (what the bundler actually ships) and has
// a real Python parse them. It runs before `tsc` on every build, which makes
// that class of bug impossible to ship quietly.
//
// Usage: node scripts/check-python-sources.mjs [path/to/pythonSources.ts]

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

const sourcePath = process.argv[2] ?? new URL('../src/lab/pythonSources.ts', import.meta.url);
const source = readFileSync(sourcePath, 'utf8');
const parsed = ts.createSourceFile('pythonSources.ts', source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);

const wanted = new Set(['ANALYZER', 'LAB_BOOTSTRAP']);
const found = new Map();

const visit = (node) => {
  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    wanted.has(node.name.text) &&
    node.initializer &&
    ts.isNoSubstitutionTemplateLiteral(node.initializer)
  ) {
    // `.text` is the cooked value: escapes already resolved, exactly what the
    // browser hands to Python.
    found.set(node.name.text, node.initializer.text);
  }
  ts.forEachChild(node, visit);
};
visit(parsed);

const missing = [...wanted].filter((name) => !found.has(name));
if (missing.length > 0) {
  console.error(`check-python-sources: ${missing.join(', ')} must stay a plain template literal`);
  process.exit(1);
}

const python = process.env.PYTHON ?? 'python3';
const probe = spawnSync(python, ['--version'], { encoding: 'utf8' });
if (probe.error || probe.status !== 0) {
  // Not every machine that builds the site has Python; say so rather than
  // pretending the check ran.
  console.warn(`check-python-sources: ${python} not available, skipping the parse check`);
  process.exit(0);
}

const directory = mkdtempSync(join(tmpdir(), 'sltp-python-'));
const problems = [];

for (const [name, text] of found) {
  const file = join(directory, `${name}.py`);
  writeFileSync(file, text);
  const result = spawnSync(
    python,
    ['-c', 'import ast, sys\nast.parse(open(sys.argv[1], encoding="utf-8").read(), sys.argv[1])', file],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    problems.push(`${name} does not parse as Python:\n${(result.stderr || result.stdout || '').trim()}`);
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`check-python-sources: ${problem}`);
  process.exit(1);
}

console.log(`check-python-sources: ${[...found.keys()].join(', ')} parse as Python`);
