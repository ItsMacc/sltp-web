// device.ts — what kind of browser this is, decided once per session.
//
// Phones get a smaller market plan (the recent tail plus the five calendar
// years the picker offers, not 29 years) and can run strategies only from
// those files. The window is deliberately short: ten years of bars was enough
// for iOS Safari to kill the tab while drawing a chart. Detection is UA plus a
// small touch screen; tablets keep the desktop plan. A device does not change
// class mid-visit, so callers can read the module consts.

/** The window a phone can hold, in years. Five is the default; ten is the
    other choice in Settings. Desktops always hold everything. */
export type DataPlanYears = 5 | 10;

/** Device-level, not account-level: the same person's phone and laptop keep
    different plans, so this key is never synced or sent to the server. */
const DATA_PLAN_KEY = 'st_data_plan_years';

export function readDataPlanYears(): DataPlanYears {
  try {
    const raw = Number(window.localStorage.getItem(DATA_PLAN_KEY));
    return raw === 10 ? 10 : 5;
  } catch {
    return 5;
  }
}

/** Writes the phone's choice. Desktop never calls this: its plan is fixed. */
export function writeDataPlanYears(years: DataPlanYears): void {
  try {
    window.localStorage.setItem(DATA_PLAN_KEY, String(years));
  } catch {
    // Private browsing: the plan applies for this visit and no further.
  }
}

/** The plan this session runs on: the stored choice on a phone, everything
    on a desktop. Read at load, because more than one module bakes it into a
    constant (the timeframe buttons, for one). */
export const DATA_PLAN_YEARS: DataPlanYears = readDataPlanYears();

/** Earliest day a phone will ever query: January 1 of the year N years back.
    The date picker uses this as its min, and the sync plan keeps that year's
    file. Using the first of the year means a January run is a whole calendar
    year, not a partial one cut off by today's date. */
export function mobileHistoryStartFor(years: number, today: Date = new Date()): string {
  return `${today.getFullYear() - years}-01-01`;
}

export function mobileHistoryStart(today: Date = new Date()): string {
  return mobileHistoryStartFor(DATA_PLAN_YEARS, today);
}

export const MOBILE_HISTORY_START = mobileHistoryStart();

/** `?phone=1` runs the phone plan on any browser and `?phone=0` runs the
    desktop one, so mobile behaviour can be tested without a device (or a UA
    switcher). Nothing else sets these. */
function phoneOverride(): boolean | null {
  if (typeof window === 'undefined') return null;
  const value = new URLSearchParams(window.location.search).get('phone');
  if (value === '1') return true;
  if (value === '0') return false;
  return null;
}

/** True on phones (and phone-sized emulation). Tablets stay desktop. */
export function isMobileDevice(): boolean {
  const forced = phoneOverride();
  if (forced !== null) return forced;
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/Android|iPhone|iPod|Mobile/i.test(ua)) return true;
  if (/iPad/i.test(ua)) return false;
  if (typeof window === 'undefined') return false;
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  const shortest = Math.min(window.screen?.width ?? 9999, window.screen?.height ?? 9999);
  return coarse && shortest < 500;
}

/** The answer for this session, so callers do not each re-parse the UA. */
export const IS_MOBILE = isMobileDevice();
