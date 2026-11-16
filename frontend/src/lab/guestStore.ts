// guestStore.ts — the Lab without an account, kept in this browser.
//
// A visitor can open the Lab, make workspaces, write code and run it before
// signing up. Everything they create lives in one localStorage document, so it
// survives reloads and tab closes but stays on this browser: no account, no
// server, no sync to another device. store.ts routes every Lab call here when
// nobody is signed in, and the editor says so in a banner.
//
// The shapes deliberately match the authenticated API, so the pages cannot
// tell the two apart. Writes are synchronous in memory and flushed to
// localStorage on every call: a Lab document is small text files, and losing a
// file to a debounce is worse than paying for the write.

import type { LabBacktestRecord, LabBacktestSummary, LabFile, LabProject, LabWorkspace } from '../../lib/api';
import { getTemplate, type LabTemplateId } from './templates';

export interface GuestProjectFiles {
  project: { id: string; name: string };
  files: LabFile[];
  folders: string[];
}

const STORAGE_KEY = 'st_lab_guest_v1';
const WORKSPACE_FILE = 'workspace/main.py';

interface GuestProject {
  id: string;
  name: string;
  created_at: string;
  files: LabFile[];
  folders: string[];
  settings: Record<string, unknown> | null;
}

interface GuestWorkspace {
  id: string;
  name: string;
  created_at: string;
  project_id: string;
}

interface GuestDoc {
  version: 1;
  workspaces: GuestWorkspace[];
  projects: Record<string, GuestProject>;
  backtests: LabBacktestRecord[];
}

const empty = (): GuestDoc => ({ version: 1, workspaces: [], projects: {}, backtests: [] });

function read(): GuestDoc {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return empty();
    const parsed = JSON.parse(raw) as Partial<GuestDoc> | null;
    if (!parsed || typeof parsed !== 'object') return empty();
    return {
      version: 1,
      workspaces: Array.isArray(parsed.workspaces) ? parsed.workspaces : [],
      projects: parsed.projects && typeof parsed.projects === 'object' ? parsed.projects : {},
      backtests: Array.isArray(parsed.backtests) ? parsed.backtests : [],
    };
  } catch {
    return empty();
  }
}

function write(doc: GuestDoc): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(doc));
  } catch {
    throw new Error('This browser is out of space for Lab files. Delete a workspace or sign in.');
  }
}

const uid = (): string => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

const now = (): string => new Date().toISOString();

/** Every folder a set of paths implies, plus any empty one that was made. */
function foldersOf(files: LabFile[], extra: string[]): string[] {
  const found = new Set(extra);
  for (const file of files) {
    const parts = file.name.split('/');
    parts.pop();
    let path = '';
    for (const part of parts) {
      path = path ? `${path}/${part}` : part;
      found.add(path);
    }
  }
  return Array.from(found).sort();
}

function starterFor(template?: string, code?: string): string {
  if (code) return code;
  return getTemplate((template ?? 'blank') as LabTemplateId).code;
}

function projectFiles(project: GuestProject): GuestProjectFiles {
  return {
    project: { id: project.id, name: project.name },
    files: project.files,
    folders: foldersOf(project.files, project.folders),
  };
}

function workspaceOf(doc: GuestDoc, workspace: GuestWorkspace): LabWorkspace {
  const project = doc.projects[workspace.project_id];
  const files = project ? project.files.map((file) => ({ path: file.name })) : [];
  return {
    id: workspace.id,
    name: workspace.name,
    created_at: workspace.created_at,
    project_id: workspace.project_id,
    files,
    file_count: files.length,
  };
}

// -------- Workspaces --------
export async function listLabWorkspaces(): Promise<LabWorkspace[]> {
  const doc = read();
  return doc.workspaces.map((workspace) => workspaceOf(doc, workspace));
}

export async function createLabWorkspace(input: {
  workspace_name: string;
  strategy_name: string;
  template?: string;
  code?: string;
  settings?: Record<string, unknown>;
}): Promise<LabWorkspace> {
  const doc = read();
  const projectId = uid();
  const name = input.workspace_name.trim() || 'My workspace';
  const project: GuestProject = {
    id: projectId,
    name,
    created_at: now(),
    files: [{ name: WORKSPACE_FILE, content: starterFor(input.template, input.code), locked: false }],
    folders: ['workspace'],
    settings: input.settings ?? null,
  };
  const workspace: GuestWorkspace = { id: uid(), name, created_at: now(), project_id: projectId };
  doc.projects[projectId] = project;
  doc.workspaces.unshift(workspace);
  write(doc);
  return workspaceOf(doc, workspace);
}

export async function createLabStrategy(
  workspaceId: string,
  name: string,
  template?: string,
  code?: string,
  settings?: Record<string, unknown>,
): Promise<LabWorkspace> {
  const doc = read();
  const workspace = doc.workspaces.find((item) => item.id === workspaceId);
  if (!workspace) throw new Error('That workspace is not in this browser any more.');
  const project = doc.projects[workspace.project_id];
  if (!project) throw new Error('That workspace has no project.');
  const path = `workspace/${name.trim() || 'strategy'}.py`;
  const clean = path.endsWith('.py') ? path : `${path}.py`;
  if (!project.files.some((file) => file.name === clean)) {
    project.files.push({ name: clean, content: starterFor(template, code), locked: false });
  }
  if (settings) project.settings = settings;
  write(doc);
  return workspaceOf(doc, workspace);
}

export async function createLabProject(
  workspaceId: string,
  name: string,
  template?: string,
  settings?: Record<string, unknown>,
): Promise<LabProject> {
  const doc = read();
  const workspace = doc.workspaces.find((item) => item.id === workspaceId);
  if (!workspace) throw new Error('That workspace is not in this browser any more.');
  const project: GuestProject = {
    id: uid(),
    name: name.trim() || 'Project',
    created_at: now(),
    files: [{ name: WORKSPACE_FILE, content: starterFor(template), locked: false }],
    folders: ['workspace'],
    settings: settings ?? null,
  };
  doc.projects[project.id] = project;
  write(doc);
  return { id: project.id, name: project.name, created_at: project.created_at, file_count: 1 };
}

export async function deleteLabWorkspace(workspaceId: string): Promise<void> {
  const doc = read();
  const workspace = doc.workspaces.find((item) => item.id === workspaceId);
  if (workspace) delete doc.projects[workspace.project_id];
  doc.workspaces = doc.workspaces.filter((item) => item.id !== workspaceId);
  write(doc);
}

export async function deleteLabProject(projectId: string): Promise<void> {
  const doc = read();
  delete doc.projects[projectId];
  doc.workspaces = doc.workspaces.filter((item) => item.project_id !== projectId);
  write(doc);
}

// -------- Per-workspace run settings --------
export async function getLabProjectRunSettings(
  projectId: string,
): Promise<Record<string, unknown> | null> {
  const project = read().projects[projectId];
  return project?.settings ?? null;
}

export async function saveLabProjectRunSettings(
  projectId: string,
  settings: Record<string, unknown>,
): Promise<void> {
  const doc = read();
  const project = doc.projects[projectId];
  if (!project) throw new Error('That workspace is not in this browser any more.');
  project.settings = settings;
  write(doc);
}

// -------- Files --------
export async function getLabProjectFiles(projectId: string): Promise<GuestProjectFiles> {
  const project = read().projects[projectId];
  if (!project) throw new Error('That workspace is not in this browser any more.');
  return projectFiles(project);
}

export async function saveLabFiles(
  projectId: string,
  files: { path: string; content: string }[],
): Promise<{ saved: string[]; locked_skipped: string[] }> {
  const doc = read();
  const project = doc.projects[projectId];
  if (!project) throw new Error('That workspace is not in this browser any more.');
  const skipped: string[] = [];
  const saved: string[] = [];
  for (const incoming of files) {
    const existing = project.files.find((file) => file.name === incoming.path);
    if (existing) {
      if (existing.locked) {
        skipped.push(incoming.path);
        continue;
      }
      existing.content = incoming.content;
      saved.push(incoming.path);
    } else {
      project.files.push({ name: incoming.path, content: incoming.content, locked: false });
      saved.push(incoming.path);
    }
  }
  write(doc);
  return { saved, locked_skipped: skipped };
}

export async function flushLabFilesOnExit(
  projectId: string,
  files: { path: string; content: string }[],
): Promise<void> {
  await saveLabFiles(projectId, files);
}

export async function saveLabFile(projectId: string, name: string, content: string): Promise<void> {
  await saveLabFiles(projectId, [{ path: name, content }]);
}

export async function createLabFile(projectId: string, name: string): Promise<LabFile> {
  const doc = read();
  const project = doc.projects[projectId];
  if (!project) throw new Error('That workspace is not in this browser any more.');
  const path = name.includes('/') ? name : `workspace/${name}`;
  const file: LabFile = { name: path, content: '', locked: false };
  if (!project.files.some((item) => item.name === path)) project.files.push(file);
  project.folders = foldersOf(project.files, []);
  write(doc);
  return file;
}

export async function renameLabFile(
  projectId: string,
  name: string,
  newName: string,
): Promise<{ name: string; previous: string }> {
  const doc = read();
  const project = doc.projects[projectId];
  if (!project) throw new Error('That workspace is not in this browser any more.');
  const file = project.files.find((item) => item.name === name);
  if (!file) throw new Error('That file is not in this workspace any more.');
  file.name = newName;
  project.folders = foldersOf(project.files, []);
  write(doc);
  return { name: newName, previous: name };
}

export async function deleteLabFile(projectId: string, name: string): Promise<void> {
  const doc = read();
  const project = doc.projects[projectId];
  if (!project) return;
  project.files = project.files.filter((file) => file.name !== name);
  project.folders = foldersOf(project.files, project.folders);
  write(doc);
}

export async function deleteLabFolder(projectId: string, name: string): Promise<void> {
  const doc = read();
  const project = doc.projects[projectId];
  if (!project) return;
  project.files = project.files.filter((file) => !file.name.startsWith(`${name}/`));
  project.folders = foldersOf(project.files, project.folders.filter((folder) => folder !== name));
  write(doc);
}

export async function importLabFiles(
  projectId: string,
  files: { path: string; content: string }[],
  folders: string[] = [],
): Promise<{ imported: string[]; skipped: { path: string; reason: string }[] }> {
  const doc = read();
  const project = doc.projects[projectId];
  if (!project) throw new Error('That workspace is not in this browser any more.');
  const imported: string[] = [];
  const skipped: { path: string; reason: string }[] = [];
  for (const file of files) {
    const path = file.path.startsWith('workspace/') ? file.path : `workspace/${file.path}`;
    if (project.files.some((existing) => existing.name === path)) {
      skipped.push({ path, reason: 'already in the workspace' });
      continue;
    }
    project.files.push({ name: path, content: file.content, locked: false });
    imported.push(path);
  }
  project.folders = foldersOf(project.files, [...project.folders, ...folders]);
  write(doc);
  return { imported, skipped };
}

// -------- Backtests --------
export async function listLabBacktests(projectId: string): Promise<LabBacktestSummary[]> {
  return read()
    .backtests.filter((record) => record.project_id === projectId)
    .map(({ payload: _payload, ...summary }) => summary);
}

export async function createLabBacktest(
  projectId: string,
  payload: unknown,
  name?: string,
): Promise<LabBacktestSummary> {
  const doc = read();
  const data = payload as { stats?: Record<string, unknown>; strategy_name?: string | null } | null;
  const stats = data?.stats ?? {};
  const number = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  const stamp = now();
  const record: LabBacktestRecord = {
    id: uid(),
    project_id: projectId,
    name: name ?? `${data?.strategy_name ?? 'Backtest'} · ${stamp.slice(0, 10)}`,
    strategy_name: data?.strategy_name ?? 'Strategy',
    total_return: number(stats.total_return),
    cagr: typeof stats.cagr === 'number' ? stats.cagr : null,
    created_at: stamp,
    updated_at: stamp,
    payload,
  };
  doc.backtests.unshift(record);
  write(doc);
  const { payload: _payload, ...summary } = record;
  return summary;
}

export async function getLabBacktest(backtestId: string): Promise<LabBacktestRecord> {
  const record = read().backtests.find((item) => item.id === backtestId);
  if (!record) throw new Error('That backtest is not in this browser any more.');
  return record;
}

export async function renameLabBacktest(
  backtestId: string,
  name: string,
): Promise<LabBacktestSummary> {
  const doc = read();
  const record = doc.backtests.find((item) => item.id === backtestId);
  if (!record) throw new Error('That backtest is not in this browser any more.');
  record.name = name;
  record.updated_at = now();
  write(doc);
  const { payload: _payload, ...summary } = record;
  return summary;
}

export async function deleteLabBacktest(backtestId: string): Promise<void> {
  const doc = read();
  doc.backtests = doc.backtests.filter((item) => item.id !== backtestId);
  write(doc);
}

/** Nothing to warm up: the whole document is already in memory. */
export async function prefetchLabProjects(_projectIds: string[]): Promise<void> {
  return;
}

/** Dropped on sign-out: a guest Lab belongs to the visitor, not the account. */
export function clearGuestLab(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private mode: nothing was written anyway.
  }
}
