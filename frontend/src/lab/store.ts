// store.ts — the Lab's workspaces, projects and files, stored in Turso.
//
// The Lab pages speak the same words they always did (a workspace holds
// projects, a project holds files). This module is the one place that turns
// those words into the authenticated FastAPI calls in lib/api.ts, so the pages
// never touch a fetch or a session themselves.
//
// Every call takes the Supabase access token from the live session. The Lab is
// behind the sign-in gate, so a missing session means it expired mid-visit:
// the caller gets a plain message it can show instead of a silent empty list.
//
// Reads use a five-minute browser snapshot to save Turso reads, with one
// exception: the first seconds after a page load always ask the server. That
// is the reload case — create a workspace on the laptop, refresh the phone,
// see it immediately — while moving around inside the Lab still reuses the
// snapshot. Writes never wait for any of this: every create, save and delete
// is an awaited Turso round trip, and the snapshot it invalidates is dropped
// in the same call.

import { supabase } from '../../lib/supabase';
import { dropCachedBacktest, renameCachedBacktest } from './backtestCache';
import {
  createLabBacktest as apiCreateLabBacktest,
  createLabFile as apiCreateLabFile,
  createLabProject as apiCreateLabProject,
  createLabStrategy as apiCreateLabStrategy,
  createLabWorkspace as apiCreateLabWorkspace,
  deleteLabBacktest as apiDeleteLabBacktest,
  deleteLabFile as apiDeleteLabFile,
  deleteLabFolder as apiDeleteLabFolder,
  deleteLabProject as apiDeleteLabProject,
  deleteLabWorkspace as apiDeleteLabWorkspace,
  getLabBacktest as apiGetLabBacktest,
  getLabProjectFiles as apiGetLabProjectFiles,
  importLabFiles as apiImportLabFiles,
  listLabBacktests as apiListLabBacktests,
  listLabWorkspaces as apiListLabWorkspaces,
  renameLabBacktest as apiRenameLabBacktest,
  renameLabFile as apiRenameLabFile,
  saveLabFile as apiSaveLabFile,
  saveLabFiles as apiSaveLabFiles,
  saveLabFilesOnExit as apiSaveLabFilesOnExit,
  type LabBacktestRecord,
  type LabBacktestSummary,
  type LabFile,
  type LabProject,
  type LabWorkspace,
} from '../../lib/api';

export type { LabBacktestRecord, LabBacktestSummary, LabFile, LabProject, LabWorkspace };

export interface LabProjectFiles {
  project: { id: string; name: string };
  files: LabFile[];
  folders: string[];
}

// -------- Snapshot cache --------
// localStorage is a few megabytes in every browser. A project tree near that
// size is not worth caching: it would evict everything else and could fail
// the write anyway, so it is simply not stored.
const MAX_ENTRY_BYTES = 1_500_000;
const CACHE_PREFIX = 'st_lab_v1';
const CACHE_TTL_MS = 5 * 60 * 1000;
/** A page that just loaded must not answer from the previous page's snapshot. */
const FRESH_LOAD_MS = 10_000;

interface CacheEntry<T> {
  savedAt: number;
  data: T;
}

function cacheKey(userId: string, part: string): string {
  return `${CACHE_PREFIX}:${userId}:${part}`;
}

function freshLoad(): boolean {
  return typeof performance !== 'undefined' && performance.now() < FRESH_LOAD_MS;
}

/** The snapshot if it is younger than the TTL, and not from a previous page. */
function cachedNow<T>(key: string): T | null {
  if (freshLoad()) return null;
  const entry = readEntry<T>(key);
  if (!entry) return null;
  return Date.now() - entry.savedAt < CACHE_TTL_MS ? entry.data : null;
}

function readEntry<T>(key: string): CacheEntry<T> | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheEntry<T>;
    if (!parsed || typeof parsed.savedAt !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeEntry<T>(key: string, data: T): void {
  try {
    const encoded = JSON.stringify({ savedAt: Date.now(), data } satisfies CacheEntry<T>);
    if (encoded.length > MAX_ENTRY_BYTES) return;
    localStorage.setItem(key, encoded);
  } catch {
    // A full quota or a private window must never break a Lab read.
  }
}

function dropEntry(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Nothing to do: the next read simply misses.
  }
}

// Drops every Lab snapshot for the signed-in account, for a hard refresh.
export async function clearLabCache(): Promise<void> {
  const { userId } = await session();
  try {
    const prefix = `${CACHE_PREFIX}:${userId}:`;
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(prefix)) localStorage.removeItem(key);
    }
  } catch {
    // Best-effort, like every other cache write here.
  }
}

async function session(): Promise<{ token: string; userId: string }> {
  const { data: { session: live } } = await supabase.auth.getSession();
  if (!live?.access_token) {
    throw new Error('Your session has expired. Please sign in again.');
  }
  return { token: live.access_token, userId: live.user.id };
}

async function dropWorkspaces(userId: string): Promise<void> {
  dropEntry(cacheKey(userId, 'workspaces'));
}

// A project's tree changes whenever its files do, and its file count is part
// of the workspace list, so both snapshots go together.
async function dropProject(userId: string, projectId: string): Promise<void> {
  dropEntry(cacheKey(userId, `project:${projectId}`));
  dropEntry(cacheKey(userId, 'workspaces'));
}

// -------- Workspaces --------
export async function listLabWorkspaces(): Promise<LabWorkspace[]> {
  const { token, userId } = await session();
  const key = cacheKey(userId, 'workspaces');
  const cached = cachedNow<LabWorkspace[]>(key);
  if (cached) return cached;
  try {
    const data = await apiListLabWorkspaces(token);
    writeEntry(key, data);
    return data;
  } catch (err) {
    // Offline or the API is down: the last answer beats an empty screen, but
    // only when there is nothing current to show.
    const fallback = readEntry<LabWorkspace[]>(key);
    if (fallback) return fallback.data;
    throw err;
  }
}

export async function createLabWorkspace(input: {
  workspace_name: string;
  strategy_name: string;
  template?: string;
  code?: string;
}): Promise<LabWorkspace> {
  const { token, userId } = await session();
  const created = await apiCreateLabWorkspace(token, input);
  await dropWorkspaces(userId);
  return created;
}

export async function createLabStrategy(
  workspaceId: string,
  name: string,
  template?: string,
  code?: string,
): Promise<LabWorkspace> {
  const { token, userId } = await session();
  const created = await apiCreateLabStrategy(token, workspaceId, name, template, code);
  await dropWorkspaces(userId);
  return created;
}

export async function createLabProject(
  workspaceId: string,
  name: string,
  template?: string,
): Promise<LabProject> {
  const { token, userId } = await session();
  const created = await apiCreateLabProject(token, workspaceId, name, template);
  await dropWorkspaces(userId);
  return created;
}

export async function deleteLabWorkspace(workspaceId: string): Promise<void> {
  const { token, userId } = await session();
  await apiDeleteLabWorkspace(token, workspaceId);
  await dropWorkspaces(userId);
}

export async function deleteLabProject(projectId: string): Promise<void> {
  const { token, userId } = await session();
  await apiDeleteLabProject(token, projectId);
  await dropProject(userId, projectId);
}

// -------- Files --------
export async function getLabProjectFiles(projectId: string): Promise<LabProjectFiles> {
  const { token, userId } = await session();
  const key = cacheKey(userId, `project:${projectId}`);
  const cached = cachedNow<LabProjectFiles>(key);
  if (cached) return cached;
  try {
    const data = await apiGetLabProjectFiles(token, projectId);
    writeEntry(key, data);
    return data;
  } catch (err) {
    const fallback = readEntry<LabProjectFiles>(key);
    if (fallback) return fallback.data;
    throw err;
  }
}

// The editor autosaves through this. The cached tree is dropped rather than
// patched: a save can touch a dozen paths at once, and a stale tree is worse
// than one extra read on the next open.
export async function saveLabFiles(
  projectId: string,
  files: { path: string; content: string }[],
): Promise<{ saved: string[]; locked_skipped: string[] }> {
  const { token, userId } = await session();
  const result = await apiSaveLabFiles(token, projectId, files);
  await dropProject(userId, projectId);
  return result;
}

// Used when the tab is going away: the request is marked keepalive so the
// browser finishes it after the document is gone. Nothing here can be awaited,
// so the snapshot is dropped right after handing the write over.
export async function flushLabFilesOnExit(
  projectId: string,
  files: { path: string; content: string }[],
): Promise<void> {
  const { token, userId } = await session();
  apiSaveLabFilesOnExit(token, projectId, files);
  await dropProject(userId, projectId);
}

export async function saveLabFile(projectId: string, name: string, content: string): Promise<void> {
  const { token, userId } = await session();
  await apiSaveLabFile(token, projectId, name, content);
  await dropProject(userId, projectId);
}

export async function createLabFile(projectId: string, name: string): Promise<LabFile> {
  const { token, userId } = await session();
  const file = await apiCreateLabFile(token, projectId, name);
  await dropProject(userId, projectId);
  return file;
}

export async function renameLabFile(
  projectId: string,
  name: string,
  newName: string,
): Promise<{ name: string; previous: string }> {
  const { token, userId } = await session();
  const renamed = await apiRenameLabFile(token, projectId, name, newName);
  await dropProject(userId, projectId);
  return renamed;
}

export async function deleteLabFile(projectId: string, name: string): Promise<void> {
  const { token, userId } = await session();
  await apiDeleteLabFile(token, projectId, name);
  await dropProject(userId, projectId);
}

export async function deleteLabFolder(projectId: string, name: string): Promise<void> {
  const { token, userId } = await session();
  await apiDeleteLabFolder(token, projectId, name);
  await dropProject(userId, projectId);
}

export async function importLabFiles(
  projectId: string,
  files: { path: string; content: string }[],
  folders: string[] = [],
): Promise<{ imported: string[]; skipped: { path: string; reason: string }[] }> {
  const { token, userId } = await session();
  const result = await apiImportLabFiles(token, projectId, files, folders);
  await dropProject(userId, projectId);
  return result;
}

// -------- Backtests --------
export async function listLabBacktests(projectId: string): Promise<LabBacktestSummary[]> {
  return apiListLabBacktests(await token(), projectId);
}

export async function createLabBacktest(
  projectId: string,
  payload: unknown,
  name?: string,
): Promise<LabBacktestSummary> {
  return apiCreateLabBacktest(await token(), projectId, payload, name);
}

export async function getLabBacktest(backtestId: string): Promise<LabBacktestRecord> {
  return apiGetLabBacktest(await token(), backtestId);
}

export async function renameLabBacktest(
  backtestId: string,
  name: string,
): Promise<LabBacktestSummary> {
  const renamed = await apiRenameLabBacktest(await token(), backtestId, name);
  await renameCachedBacktest(backtestId, renamed.name);
  return renamed;
}

export async function deleteLabBacktest(backtestId: string): Promise<void> {
  await apiDeleteLabBacktest(await token(), backtestId);
  await dropCachedBacktest(backtestId);
}

// Backtests are read once and rendered from memory, so they keep the plain
// token helper rather than paying for a user id they do not use.
async function token(): Promise<string> {
  const { token: live } = await session();
  return live;
}
