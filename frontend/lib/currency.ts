// currency.ts — what money a price is shown in.
//
// Bars are stored in the currency their own exchange quotes: an Indian
// listing is in rupees, a Japanese one in yen, a US one in dollars. This file
// answers two questions the UI asks about that:
//
//   1. Which currency should "my currency" mean? A region reading of the
//      browser's locale and time zone, overridable in Settings, so someone in
//      India sees rupees without having to find a switch first.
//   2. How do you convert a price, or a whole series, between two of them?
//      Through the daily FX table the bucket publishes (USD per unit), which
//      is the same table sltp's engine converts with.
//
// Conversion is a display choice only. Nothing here rewrites stored bars, and
// a backtest still runs on the listing's own prices.

import type { Bar } from '../src/components/Chart'
import type { FxTable } from '../src/store/parquet'

/** The currencies the published FX table carries, plus the base. */
export const CURRENCY_CODES = [
  'USD',
  'EUR',
  'GBP',
  'JPY',
  'CAD',
  'AUD',
  'SEK',
  'SGD',
  'CHF',
  'HKD',
  'INR',
] as const

export type CurrencyCode = (typeof CURRENCY_CODES)[number]

/** `auto` follows the region; anything else is a deliberate choice. */
export type CurrencyChoice = 'auto' | CurrencyCode

/** A code is supported only when the FX table carries a column for it. */
export function isCurrencyChoice(value: unknown): value is CurrencyChoice {
  const text = typeof value === 'string' ? value.trim().toUpperCase() : ''
  return text === 'AUTO' || (CURRENCY_CODES as readonly string[]).includes(text)
}

/** Country code to the currency that country quotes in. */
const COUNTRY_CURRENCY: Record<string, CurrencyCode> = {
  US: 'USD',
  GB: 'GBP',
  CA: 'CAD',
  AU: 'AUD',
  IN: 'INR',
  JP: 'JPY',
  DE: 'EUR',
  FR: 'EUR',
  IT: 'EUR',
  NL: 'EUR',
  ES: 'EUR',
  PT: 'EUR',
  IE: 'EUR',
  BE: 'EUR',
  AT: 'EUR',
  FI: 'EUR',
  GR: 'EUR',
  CH: 'CHF',
  SE: 'SEK',
  SG: 'SGD',
  HK: 'HKD',
}

/** Time-zone families: the location signal, checked before the locale. */
const ZONE_CURRENCY: [RegExp, CurrencyCode][] = [
  [/^Asia\/(Kolkata|Calcutta)$/, 'INR'],
  [/^Asia\/(Tokyo|Osaka)$/, 'JPY'],
  [/^Asia\/(Singapore|Kuala_Lumpur)$/, 'SGD'],
  [/^Asia\/(Hong_Kong|Macau)$/, 'HKD'],
  [/^Europe\/(London|Belfast|Guernsey|Jersey|Isle_of_Man)$/, 'GBP'],
  [/^Europe\/Zurich$/, 'CHF'],
  [/^Europe\/Stockholm$/, 'SEK'],
  [/^Australia\//, 'AUD'],
  [
    /^America\/(Toronto|Montreal|Vancouver|Edmonton|Winnipeg|Regina|Halifax|Moncton|Glace_Bay|Goose_Bay|Thunder_Bay|Rainy_River|Whitehorse|Yellowknife|Iqaluit|St_Johns|Nipigon|Atikokan)$/,
    'CAD',
  ],
  [
    /^America\/(New_York|Chicago|Denver|Los_Angeles|Phoenix|Anchorage|Honolulu|Detroit|Boise|Juneau|Nome|Sitka|Adak|Indiana\/[A-Za-z_]+|Kentucky\/[A-Za-z_]+|North_Dakota\/[A-Za-z_]+|Puerto_Rico)$/,
    'USD',
  ],
  [
    /^Europe\/(Berlin|Paris|Madrid|Rome|Amsterdam|Brussels|Vienna|Dublin|Lisbon|Helsinki|Athens|Bratislava|Ljubljana|Luxembourg|Riga|Tallinn|Vilnius|Malta|Monaco|Andorra|San_Marino|Vatican|Podgorica|Zagreb)$/,
    'EUR',
  ],
]

/**
 * The currency this browser's owner most likely thinks in.
 *
 * Where the machine is beats how the person talks. A Mac whose region is set
 * to India but whose clock runs in Toronto reports `en-IN` as its language and
 * `America/Toronto` as its zone: the zone is the location, the locale is the
 * language, so reading the locale first showed rupees to a reader in Canada.
 *
 * The locale's region is still the fallback for a machine whose zone we do not
 * map. A region whose money the published FX table does not carry (Brazil,
 * Norway, New Zealand…) reads in US dollars rather than in a neighbouring
 * currency the reader does not use, and that is also the last resort when both
 * signals are missing.
 *
 * This never leaves the machine: it is a reading of the browser, not a lookup
 * of the person.
 */
export function detectedCurrency(
  locale: string = typeof navigator === 'undefined' ? 'en-US' : navigator.language,
  timeZone: string = typeof Intl === 'undefined'
    ? ''
    : Intl.DateTimeFormat().resolvedOptions().timeZone,
): CurrencyCode {
  for (const [pattern, code] of ZONE_CURRENCY) {
    if (timeZone && pattern.test(timeZone)) return code
  }
  const region = /[-_]([A-Za-z]{2})(?:$|[-_])/.exec(locale)?.[1]?.toUpperCase()
  if (region && COUNTRY_CURRENCY[region]) return COUNTRY_CURRENCY[region]!
  return 'USD'
}

/** The code a saved choice resolves to right now. */
export function resolveCurrency(choice: unknown): CurrencyCode {
  if (choice === 'auto' || choice == null) return detectedCurrency()
  const text = String(choice).trim().toUpperCase()
  return (CURRENCY_CODES as readonly string[]).includes(text)
    ? (text as CurrencyCode)
    : detectedCurrency()
}

/** How the choice reads in a control: "Match my region (INR)". */
export function currencyChoiceLabel(choice: CurrencyChoice): string {
  return choice === 'auto'
    ? `Match my region (${detectedCurrency()})`
    : `${choice} — ${currencyName(choice)}`
}

const CURRENCY_NAMES: Record<CurrencyCode, string> = {
  USD: 'US dollar',
  EUR: 'Euro',
  GBP: 'British pound',
  JPY: 'Japanese yen',
  CAD: 'Canadian dollar',
  AUD: 'Australian dollar',
  SEK: 'Swedish krona',
  SGD: 'Singapore dollar',
  CHF: 'Swiss franc',
  HKD: 'Hong Kong dollar',
  INR: 'Indian rupee',
}

export function currencyName(code: string): string {
  return CURRENCY_NAMES[code as CurrencyCode] ?? code
}

/** The symbol a reader recognises, for a button label: ₹, $, ¥, £. */
export function currencySymbol(code: string): string {
  try {
    const parts = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: code,
      currencyDisplay: 'narrowSymbol',
    }).formatToParts(0)
    return parts.find((part) => part.type === 'currency')?.value ?? code
  } catch {
    return code
  }
}

/**
 * A price in its own currency, the way a local quote page writes it.
 *
 * Yen and won have no cents, so they are drawn without them; everything else
 * gets two decimals. Very large values keep the reader's separators rather
 * than switching to a compact form, because a share price is not a market cap.
 */
export function formatMoney(value: number, code: string): string {
  if (!Number.isFinite(value)) return '—'
  const digits = code === 'JPY' ? 0 : 2
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: code,
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value)
  } catch {
    return `${value.toFixed(digits)} ${code}`
  }
}

/** A plain number with separators, for OHLC cells that name the code once. */
export function formatNumber(value: number, code: string): string {
  const digits = code === 'JPY' ? 0 : 2
  return value.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

const DAY_MS = 86_400_000

function dayCode(iso: string): number {
  return Math.floor(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / DAY_MS)
}

/** USD per one unit of `code` on that day, or null when the table lacks it. */
export function rateToUsd(fx: FxTable, code: string, iso: string): number | null {
  const currency = code.trim().toUpperCase()
  if (currency === 'USD') return 1
  const column = fx.rates[currency]
  if (!column || fx.days.length === 0) return null
  const wanted = dayCode(iso)
  let low = 0
  let high = fx.days.length - 1
  let found = -1
  while (low <= high) {
    const middle = (low + high) >> 1
    if (fx.days[middle]! <= wanted) {
      found = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  // A day before the first quote uses the first one, which is the same
  // carry-back rule sltp's fx module applies.
  const rate = column[Math.max(found, 0)]
  return rate != null && Number.isFinite(rate) && rate > 0 ? rate : null
}

/** One price moved from its listing currency to another on the same day. */
export function convertPrice(
  value: number,
  from: string,
  to: string,
  fx: FxTable,
  iso: string,
): number | null {
  if (from.toUpperCase() === to.toUpperCase()) return value
  const source = rateToUsd(fx, from, iso)
  const target = rateToUsd(fx, to, iso)
  if (source == null || target == null) return null
  return (value * source) / target
}

/**
 * A whole series in another currency, each bar at that day's rate. Percent
 * moves are unchanged, so a converted chart keeps its shape; only the level
 * moves, which is exactly what a reader comparing two markets wants to see.
 */
export function convertBars(bars: Bar[], from: string, to: string, fx: FxTable): Bar[] {
  if (from.toUpperCase() === to.toUpperCase()) return bars
  return bars.map((bar) => {
    const source = rateToUsd(fx, from, bar.date)
    const target = rateToUsd(fx, to, bar.date)
    if (source == null || target == null) return bar
    const factor = source / target
    return {
      ...bar,
      open: bar.open * factor,
      high: bar.high * factor,
      low: bar.low * factor,
      close: bar.close * factor,
    }
  })
}
