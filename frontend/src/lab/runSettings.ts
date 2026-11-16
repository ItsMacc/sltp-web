// runSettings.ts — the dates and trading costs a Lab run uses.
//
// The defaults mirror the engine: a two-year window to the latest bar, a 0.1%
// fee, 0.05% slippage, no spread, no participation cap and no borrow cost.
// The dialog keeps its values as strings so a half-typed number does not snap
// back; these helpers convert them once, when the run starts.

import { readStoredUserSettings } from '../../lib/settings';
import { IS_MOBILE, MOBILE_HISTORY_START } from '../store/device';

const STORAGE_KEY = 'sltp.lab.runSettings';

/** First day of the dataset a desktop holds. */
const HISTORY_START = '1998-01-01';

export interface LabRunSettings {
  start: string;
  /** Empty means "run to the latest bar". */
  end: string;
  dividends: boolean;
  feePct: string;
  slippagePct: string;
  spreadPct: string;
  participationPct: string;
  borrowPct: string;
  /** Dollars. A fill below this carries to the next open instead of booking. */
  minFillDollars: string;
}

/** What the Python worker receives. Rates are fractions, dates are ISO. */
export interface EngineRunSettings {
  start: string;
  end: string | null;
  dividends: boolean;
  fee_rate: number;
  slippage_pct: number;
  spread_pct: number;
  max_participation: number | null;
  borrow_rate: number;
  min_fill_notional: number;
}

/** The engine's own costs, in the units the fields show (percent). */
export function defaultLabRunSettings(): LabRunSettings {
  const start = new Date();
  start.setDate(start.getDate() - 730);
  return {
    start: localDate(start),
    end: '',
    dividends: true,
    feePct: '0.1',
    slippagePct: '0.05',
    spreadPct: '0',
    participationPct: '',
    borrowPct: '0',
    minFillDollars: '0.01',
  };
}

export function toEngineSettings(settings: LabRunSettings): EngineRunSettings {
  const fraction = (value: string) => {
    const number = Number(value.trim() || '0');
    return Number.isFinite(number) && number > 0 ? number / 100 : 0;
  };
  const participation = settings.participationPct.trim();
  return {
    start: settings.start,
    end: settings.end || null,
    dividends: settings.dividends,
    fee_rate: fraction(settings.feePct),
    slippage_pct: fraction(settings.slippagePct),
    spread_pct: fraction(settings.spreadPct),
    max_participation: participation ? Number(participation) / 100 : null,
    borrow_rate: fraction(settings.borrowPct),
    // Dollars, not a percent: 0 turns the floor off, which the engine allows.
    min_fill_notional: Math.max(0, Number(settings.minFillDollars.trim() || '0')),
  };
}

/**
 * The account's Lab defaults from Settings → Lab backtests.
 *
 * These seed a new workspace. Once a workspace exists its own copy lives in
 * Turso, so editing one workspace never moves another, and editing the
 * account defaults never rewrites a workspace someone already tuned.
 */
export function accountLabDefaults(): LabRunSettings {
  const defaults = defaultLabRunSettings();
  const stored = readStoredUserSettings()?.labRunSettings;
  if (stored && typeof stored === 'object') {
    return { ...defaults, ...(stored as Partial<LabRunSettings>) };
  }
  // No account choice yet: the last run on this device is the best guess.
  return readLabRunSettings();
}

/** The last settings used on this device, or the engine defaults. */
export function readLabRunSettings(): LabRunSettings {
  const defaults = defaultLabRunSettings();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults;
    const saved = JSON.parse(raw) as Partial<LabRunSettings> | null;
    if (!saved || typeof saved !== 'object') return defaults;
    return {
      ...defaults,
      ...saved,
      dividends: typeof saved.dividends === 'boolean' ? saved.dividends : defaults.dividends,
    };
  } catch {
    return defaults;
  }
}

/** Remembers the settings for the next run and the next visit. */
export function saveLabRunSettings(settings: LabRunSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Private browsing or a full quota: the run still uses the values in memory.
  }
}

/**
 * The first day a run can read on this device.
 *
 * A phone holds its plan's window, so a run may not start before the January
 * that window begins. A desktop holds the whole dataset, which starts in 1998.
 */
export function earliestRunStart(): string {
  return IS_MOBILE ? MOBILE_HISTORY_START : HISTORY_START;
}

/** Today, as the ISO day the pickers and the engine both use. */
export function todayIso(today: Date = new Date()): string {
  return localDate(today);
}

/** A problem the user can fix, or null when the values are usable. */
export function validateLabRunSettings(settings: LabRunSettings): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(settings.start)) return 'Pick a start date.';
  if (settings.end && !/^\d{4}-\d{2}-\d{2}$/.test(settings.end)) {
    return 'Pick a valid end date, or clear it to run to the latest bar.';
  }
  // A date in the future has no bars behind it, so the engine would find an
  // empty calendar and raise. Catch it here, where the fix is a picker.
  const today = todayIso();
  if (settings.start > today) return 'The start date cannot be in the future.';
  if (settings.end && settings.end > today) return 'The end date cannot be in the future.';
  const earliest = earliestRunStart();
  if (settings.start < earliest) {
    return `This device's market history starts on ${earliest}. Pick a later start date.`;
  }
  if (settings.end && settings.end < settings.start) {
    return 'The end date must be after the start date.';
  }
  for (const [label, value] of [
    ['Fee', settings.feePct],
    ['Slippage', settings.slippagePct],
    ['Spread', settings.spreadPct],
    ['Borrow rate', settings.borrowPct],
    ['Minimum fill', settings.minFillDollars],
  ] as const) {
    if (value.trim() === '') continue;
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return `${label} must be zero or more.`;
  }
  const participation = settings.participationPct.trim();
  if (participation !== '') {
    const number = Number(participation);
    if (!Number.isFinite(number) || number <= 0 || number > 100) {
      return 'Max participation must be above 0 and at most 100%.';
    }
  }
  return null;
}

/**
 * The engine reports an empty calendar as a bare ValueError. A run that never
 * had a day to trade is a wrong window, not a broken strategy, so it says so.
 */
export function describeRunFailure(error: string): string {
  if (/No trading days available/i.test(error)) {
    return 'No trading days fall between the dates you chose. Widen the window and run again.';
  }
  return error;
}

function localDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}
