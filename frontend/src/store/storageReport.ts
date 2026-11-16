// storageReport.ts — what this browser is actually holding, measured rather
// than estimated.
//
// The site's data figure and the browser's own site-data screen disagree often
// enough that a reader deserves the real numbers: the OPFS cache broken down
// folder by folder, plus the storage manager's own usage and quota. Nothing
// here writes; a report is a snapshot taken when the page asks for one.

/** The single OPFS directory that holds every cached file. */
const CACHE_DIR = 'sltp-market';

export interface StorageFolder {
  name: string;
  bytes: number;
  files: number;
}

export interface StorageReport {
  /** Bytes under the cache folder, however they are split. */
  opfsBytes: number;
  folders: StorageFolder[];
  /** Files sitting directly in the cache root (the version marker). */
  rootFiles: number;
  rootBytes: number;
  /** What the storage manager reports for this origin, when it reports. */
  usageBytes: number | null;
  quotaBytes: number | null;
  /** Why the report is empty, when it is. */
  unavailable: string | null;
}

async function measure(dir: FileSystemDirectoryHandle): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  for await (const [, handle] of dir.entries()) {
    if (handle.kind === 'file') {
      try {
        bytes += (await (handle as FileSystemFileHandle).getFile()).size;
        files += 1;
      } catch {
        /* a handle that vanished between listing and reading costs itself */
      }
    } else {
      const nested = await measure(handle as FileSystemDirectoryHandle);
      bytes += nested.bytes;
      files += nested.files;
    }
  }
  return { bytes, files };
}

/** Walks the cache folder and asks the storage manager for the whole origin. */
export async function readStorageReport(): Promise<StorageReport> {
  const empty: StorageReport = {
    opfsBytes: 0,
    folders: [],
    rootFiles: 0,
    rootBytes: 0,
    usageBytes: null,
    quotaBytes: null,
    unavailable: null,
  };

  try {
    const estimate = await navigator.storage?.estimate?.();
    empty.usageBytes = typeof estimate?.usage === 'number' ? estimate.usage : null;
    empty.quotaBytes = typeof estimate?.quota === 'number' ? estimate.quota : null;
  } catch {
    /* no estimate is a display gap, not a failure */
  }

  if (!navigator.storage?.getDirectory) {
    return { ...empty, unavailable: 'This browser does not expose its file storage to pages.' };
  }

  try {
    const root = await navigator.storage.getDirectory();
    const cache = await root.getDirectoryHandle(CACHE_DIR, { create: false });
    const folders: StorageFolder[] = [];
    for await (const [name, handle] of cache.entries()) {
      if (handle.kind === 'file') {
        try {
          empty.rootBytes += (await (handle as FileSystemFileHandle).getFile()).size;
          empty.rootFiles += 1;
        } catch {
          /* skip */
        }
        continue;
      }
      const nested = await measure(handle as FileSystemDirectoryHandle);
      folders.push({ name, bytes: nested.bytes, files: nested.files });
    }
    folders.sort((a, b) => b.bytes - a.bytes);
    const opfsBytes = folders.reduce((sum, folder) => sum + folder.bytes, empty.rootBytes);
    return { ...empty, folders, opfsBytes };
  } catch {
    return { ...empty, unavailable: 'No cached files yet, or this browser will not list them.' };
  }
}
