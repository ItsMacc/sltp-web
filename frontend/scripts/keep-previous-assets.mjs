// keep-previous-assets.mjs — leaves the last deploy's hashed CSS and JS in place.
//
// gh-pages replaces the whole tree on publish, so the moment a deploy lands the
// previous index-<hash>.css stops existing. A crawl that fetched the old HTML a
// minute earlier then asks for a file that is already gone, and Google records a
// render with no stylesheet. This copies the files the last deploy advertised
// into the new dist and writes the list of what this deploy publishes, so the
// next run knows what to keep. One generation, ~1 MB, bounded.

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

const git = (args, quiet = false) =>
  execFileSync('git', args, {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
    stdio: quiet ? ['ignore', 'pipe', 'ignore'] : ['ignore', 'pipe', 'inherit'],
  });

// -------- Previous generation --------
function previousFiles() {
  try {
    git(['fetch', '--quiet', 'origin', 'gh-pages'], true);
    const listed = git(['show', `origin/gh-pages:${MANIFEST}`]).toString();
    return JSON.parse(listed);
  } catch {
    // No branch yet, or the first run after this step was added.
    return [];
  }
}

let kept = 0;
for (const file of previousFiles()) {
  if (!/\.(js|css)$/.test(file)) continue; // the wasm and fonts are not worth carrying
  const target = join(dist, file);
  if (existsSync(target)) continue;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, git(['show', `origin/gh-pages:${file}`]));
  kept += 1;
}

// -------- This generation --------
const published = readdirSync(join(dist, 'assets'))
  .filter((name) => /\.(js|css)$/.test(name))
  .sort()
  .map((name) => `assets/${name}`);
writeFileSync(join(dist, MANIFEST), `${JSON.stringify(published, null, 2)}\n`);

console.log(`kept ${kept} files from the previous deploy; publishing ${published.length} css/js files`);
