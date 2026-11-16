// carryGuest.ts — moves a visitor's Lab work into the account they just made.
//
// The Lab runs on this browser when nobody is signed in, and on the account once
// somebody is. Without this, a first sign-in looked like the work had vanished:
// the account opened on an empty list while the files sat in localStorage under
// an anonymous key.
//
// The order matters. A workspace is created with its main file already in it
// (that is the only way the API creates one), then the rest of the tree is
// written over it, then that workspace's saved reports are added. Everything
// goes through the signed-in path, so the account row, the caches and the
// quota rules are exactly the same as if the work had been done there.
//
// Each workspace is pruned from the browser copy the moment its account copy
// exists, so a failure halfway through retries only what is left rather than
// creating duplicates. A saved report that cannot be re-saved (malformed, or
// larger than the server accepts) is counted and skipped: it must not block the
// files that did make it.

import { clearGuestLab, readGuestLab, removeGuestWorkspace } from './guestStore';
import { createLabBacktest, createLabWorkspace, saveLabFiles } from './store';

export interface CarriedLab {
  workspaces: number;
  files: number;
  backtests: number;
  /** Workspaces that could not be created; they stay in the browser copy. */
  failed: number;
  /** Reports the account refused. The workspace and files still moved. */
  reportsSkipped: number;
}

/** The file the account's create call seeds, so its name has to come first. */
function pickMain(files: { path: string; content: string }[]) {
  return files.find((file) => /(^|\/)main\.py$/.test(file.path)) ?? files[0];
}

function stemOf(path: string | undefined): string {
  if (!path) return 'main';
  const name = path.split('/').pop() ?? path;
  return name.replace(/\.py$/, '') || 'main';
}

/** One run per page: the caller can be an effect that re-fires, and a second
 * run would copy the same workspace twice. */
let inFlight: Promise<CarriedLab | null> | null = null;

/**
 * Copies every guest workspace and report into the signed-in account, then
 * drops the browser copy. Returns null when there was nothing to carry.
 */
export function carryGuestLab(): Promise<CarriedLab | null> {
  if (!inFlight) inFlight = carry();
  return inFlight;
}

async function carry(): Promise<CarriedLab | null> {
  const snapshot = readGuestLab();
  if (!snapshot) return null;

  const carried: CarriedLab = { workspaces: 0, files: 0, backtests: 0, failed: 0, reportsSkipped: 0 };

  for (const workspace of snapshot.workspaces) {
    try {
      const main = pickMain(workspace.files);
      // The account's create call names the seeded file after the strategy, so
      // passing the guest file's own stem keeps workspace/main.py where it was.
      const created = await createLabWorkspace({
        workspace_name: workspace.name,
        strategy_name: stemOf(main?.path),
        code: main?.content ?? '',
        settings: workspace.settings ?? undefined,
      });
      const projectId = created.project_id;
      if (!projectId) throw new Error('The new workspace came back without a project.');
      carried.workspaces += 1;
      if (main) carried.files += 1;

      const rest = workspace.files.filter((file) => file.path !== main?.path);
      if (rest.length > 0) {
        const saved = await saveLabFiles(projectId, rest);
        carried.files += saved.saved.length;
      }

      for (const report of snapshot.backtests.filter((item) => item.projectId === workspace.projectId)) {
        try {
          await createLabBacktest(projectId, report.payload, report.name);
          carried.backtests += 1;
        } catch {
          carried.reportsSkipped += 1;
        }
      }

      // Only now: the account has the workspace, its files and its settings.
      removeGuestWorkspace(workspace.projectId);
    } catch {
      carried.failed += 1;
    }
  }

  // Nothing left to carry means the browser copy has done its job. A workspace
  // that failed stays behind and is tried again on the next sign-in.
  if (readGuestLab() === null) clearGuestLab();
  return carried;
}
