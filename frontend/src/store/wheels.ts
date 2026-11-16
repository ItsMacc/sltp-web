// wheels.ts — the one place a pinned Python wheel is resolved, cached and
// installed.
//
// Both Pyodide workers (the Research engine and the Lab) install from here, and
// they share one OPFS copy: WHEELS/ holds the wheel, WHEELS/resolved.json holds
// the PyPI filename each pin resolved to. The answer never changes for a pin,
// so a warm visit reads it from disk instead of asking the PyPI API again.

import { getFile, hasFile, putFile } from './opfs';

/** Where the pinned name@version -> PyPI file mapping is remembered. */
const RESOLVED_KEY = 'WHEELS/resolved.json';

type ResolvedWheel = { filename: string; url: string };
let resolvedCache: Record<string, ResolvedWheel> | null = null;

/** What a wheel install needs from the runtime and from micropip. */
export interface WheelRuntime {
  FS: { writeFile: (path: string, data: Uint8Array) => void };
}

export interface Micropip {
  install: (requirement: string) => Promise<unknown>;
}

/** Everything that installs has to say for itself. */
export interface WheelResult {
  /** True when the wheel came from OPFS — nothing was downloaded. */
  cached: boolean;
  /** The PyPI filename, or null when the install fell back to micropip. */
  filename: string | null;
}

async function resolvedTable(): Promise<Record<string, ResolvedWheel>> {
  if (resolvedCache) return resolvedCache;
  try {
    const stored = await getFile(RESOLVED_KEY);
    resolvedCache = stored
      ? (JSON.parse(await stored.text()) as Record<string, ResolvedWheel>)
      : {};
  } catch {
    resolvedCache = {};
  }
  return resolvedCache;
}

async function rememberWheel(key: string, entry: ResolvedWheel): Promise<void> {
  const table = await resolvedTable();
  table[key] = entry;
  try {
    await putFile(RESOLVED_KEY, new Blob([JSON.stringify(table)], { type: 'application/json' }));
  } catch {
    /* a write that fails only costs one lookup next boot */
  }
}

/** Exact wheel URL for a pinned pure-Python release, via the PyPI API. */
async function pypiWheelUrl(name: string, version: string): Promise<ResolvedWheel> {
  const res = await fetch(`https://pypi.org/pypi/${name}/${version}/json`);
  if (!res.ok) throw new Error(`PyPI lookup failed for ${name}==${version} (${res.status})`);
  const meta = (await res.json()) as { urls?: { filename: string; url: string }[] };
  const pure = (meta.urls ?? []).find(
    (u) => u.filename.endsWith('.whl') && !u.filename.includes('cp') && !u.filename.includes('pp'),
  );
  const wheel = pure ?? (meta.urls ?? []).find((u) => u.filename.endsWith('.whl'));
  if (!wheel) throw new Error(`No wheel found for ${name}==${version}`);
  return { filename: wheel.filename, url: wheel.url };
}

/**
 * One pinned wheel: OPFS on a hit, PyPI (then stored) on a miss. Installs
 * through micropip's `emfs:` scheme, which reads the file written below. Any
 * OPFS trouble falls back to a plain PyPI install so a locked-down browser
 * still gets the engine.
 */
export async function installWheel(
  runtime: WheelRuntime,
  micropip: Micropip,
  name: string,
  version: string,
): Promise<WheelResult> {
  try {
    const pin = `${name}==${version}`;
    const known = (await resolvedTable())[pin];
    const { filename, url } = known ?? (await pypiWheelUrl(name, version));
    if (!known) await rememberWheel(pin, { filename, url });
    const key = `WHEELS/${filename}`;
    let cached = true;
    if (!(await hasFile(key))) {
      cached = false;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Wheel download failed for ${filename} (${res.status})`);
      await putFile(key, new Blob([await res.arrayBuffer()]));
    }
    const file = await getFile(key);
    if (!file) throw new Error(`Wheel vanished after download: ${filename}`);
    runtime.FS.writeFile(`/tmp/${filename}`, new Uint8Array(await file.arrayBuffer()));
    await micropip.install(`emfs:/tmp/${filename}`);
    return { cached, filename };
  } catch {
    await micropip.install(`${name}==${version}`);
    return { cached: false, filename: null };
  }
}
