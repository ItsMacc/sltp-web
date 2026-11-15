// device.ts — what kind of browser this is, decided once per session.
//
// Phones get a smaller market plan (the recent tail plus the five calendar
// years the picker offers, not 29 years) and can run strategies only from
// those files. The window is deliberately short: ten years of bars was enough
// for iOS Safari to kill the tab while drawing a chart. Detection is UA plus a
// small touch screen; tablets keep the desktop plan. A device does not change
// class mid-visit, so callers can read the module consts.

/** Earliest day a phone will ever query: January 1 of the year five years
    back. The date picker uses this as its min, and the sync plan keeps that
    year's file. Using the first of the year means a January run is a whole
    calendar year, not a partial one cut off by today's date. */
export function mobileHistoryStart(today: Date = new Date()): string {
  return `${today.getFullYear() - 5}-01-01`;
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
