// supabase.ts — The browser Supabase client. The anon key is public by
// design; row-level security in Supabase is what protects the data.
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://jqyqfkrzwimxuzugyuiw.supabase.co';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpxeXFma3J6d2lteHV6dWd5dWl3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcwNzg2OTMsImV4cCI6MjEwMjY1NDY5M30.y51b5p_W5hhba94182apC7hlJTnDrA3GoaIZw1moYd4';

// -------- Remember me --------
// Supabase already keeps the session in localStorage and refreshes it in the
// background, so a returning visitor is signed in without typing anything. The
// checkbox only decides how long that lasts:
//
//   checked    the session survives until the user signs out (the refresh
//              token rotates, so it can outlive a password change);
//   unchecked  it expires one day after the sign-in, so a shared or borrowed
//              device drops the account on its own.
//
// The flag and the sign-in time live beside the session in localStorage. On
// boot the app compares them (see sessionExpired) and signs out when the day is
// up — the token itself is still valid, so this is a policy check, not a
// server-side revocation.
const REMEMBER_KEY = 'st_remember_me';
const LOGIN_AT_KEY = 'st_login_at';
const DAY_MS = 86_400_000;

/** How long a session lasts when "keep me signed in" is off. */
const UNREMEMBERED_SESSION_DAYS = 1;

/** Records the choice and stamps the sign-in. Call this BEFORE signing in, so
    the session the client stores belongs to the right kind of login. */
export function setRememberMe(remember: boolean): void {
  try {
    localStorage.setItem(REMEMBER_KEY, remember ? 'yes' : 'no');
    localStorage.setItem(LOGIN_AT_KEY, new Date().toISOString());
  } catch {
    // Private browsing: the session still works for this visit.
  }
}

/** True unless the visitor signed in without asking to be remembered. */
function isRemembered(): boolean {
  try {
    return localStorage.getItem(REMEMBER_KEY) !== 'no';
  } catch {
    return true;
  }
}

/** True when an unremembered session has passed its one-day allowance. */
export function sessionExpired(now: number = Date.now()): boolean {
  if (isRemembered()) return false;
  try {
    const stamped = Date.parse(localStorage.getItem(LOGIN_AT_KEY) || '');
    if (Number.isNaN(stamped)) return false;
    return now - stamped > UNREMEMBERED_SESSION_DAYS * DAY_MS;
  } catch {
    return false;
  }
}

/** Clears the stamp on sign-out so the next visitor starts clean. */
export function clearRememberedLogin(): void {
  try {
    localStorage.removeItem(LOGIN_AT_KEY);
  } catch {
    // Nothing to clear.
  }
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    // A confirmation or recovery link arrives as a URL carrying the session.
    // The client reads it on load, which is what signs the visitor in when
    // they click the email.
    detectSessionInUrl: true,
    persistSession: true,
    autoRefreshToken: true,
  },
});
