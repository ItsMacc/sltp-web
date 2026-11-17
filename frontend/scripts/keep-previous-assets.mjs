// keep-previous-assets.mjs — leaves recent hashed CSS and JS on gh-pages.
//
// gh-pages replaces the whole tree on publish, so the moment a deploy lands the
// previous index-<hash>.css stops existing. A crawl that fetched the old HTML a
// minute earlier then asks for a file that is already gone, and Google records a
// render with no stylesheet. This copies the files recent deploys advertised into
// the new dist and rewrites the list, so the next run knows what to keep.
//
// Three generations, because a burst of deploys in one afternoon left a crawl
// two generations behind and it still asked for a file that no longer existed.

// -------- Imports --------
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// -------- Paths --------
const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist');
// No leading underscore: GitHub Pages drops those when it runs the tree through
// Jekyll, and the file has to be fetchable for anyone reading the deploy.
const MANIFEST = 'assets/published-assets.json';
const GENERATIONS = 3;

const git = (args, quiet = false) =>
  execFileSync('git', args, {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
    stdio: quiet ? ['ignore', 'pipe', 'ignore'] : ['ignore', 'pipe', 'inherit'],
  });

// -------- Earlier generations --------
function earlierGenerations() {
  try {
    git(['fetch', '--quiet', 'origin', 'gh-pages'], true);
    const data = JSON.parse(git(['show', `origin/gh-pages:${MANIFEST}`]).toString());
    // Older deploys wrote a bare array; this file may be either shape.
    return Array.isArray(data) ? [data] : (data.generations ?? []);
  } catch {
    // No branch yet, or the first run after this step was added.
    return [];
  }
}

const earlier = earlierGenerations();
let kept = 0;
for (const generation of earlier) {
  for (const file of generation) {
    if (!/\.(js|css)$/.test(file)) continue; // the wasm and the fonts are not worth carrying
    const target = join(dist, file);
    if (existsSync(target)) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, git(['show', `origin/gh-pages:${file}`]));
    kept += 1;
  }
}

// -------- This generation --------
const current = readdirSync(join(dist, 'assets'))
  .filter((name) => /\.(js|css)$/.test(name))
  .sort()
  .map((name) => `assets/${name}`);

// A rebuild with no source change produces the same hashes; do not list it twice.
const generations = JSON.stringify(earlier[0] ?? null) === JSON.stringify(current)
  ? earlier
  : [current, ...earlier];
const trimmed = generations.slice(0, GENERATIONS);

writeFileSync(join(dist, MANIFEST), `${JSON.stringify({ generations: trimmed }, null, 2)}\n`);
console.log(
  `kept ${kept} files from ${earlier.length} earlier generation(s); ` +
  `publishing ${current.length} css/js files across ${trimmed.length} kept`,
);
