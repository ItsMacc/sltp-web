// help.tsx — Gotchas, FAQ, glossary and the changelog.
import { C } from '../Blocks';
import type { DocGroup } from '../types';

export const HELP: DocGroup = {
  id: 'help',
  title: 'Help',
  source: 'frontend/src/docs/pages/help.tsx',
  pages: [
    {
      slug: 'gotchas',
      title: 'Gotchas and common mistakes',
      lead: 'Each of these twelve behaviours is deliberate. Each one changes what your results mean, and each one has looked like a bug.',
      blocks: [
        {
          kind: 'cards',
          items: [
            {
              title: 'Levels are measured from the signal close',
              text: <>The entry is the next open plus slippage. A 5% stop computed from the close is not 5% from the fill.</>,
            },
            {
              title: 'A lot can stop out on its entry day',
              text: 'Resting exits are checked after the fills, against the same bar. Two fees in one session.',
            },
            {
              title: 'should_exit waits for the open',
              text: <>A signal exit is queued and filled tomorrow, at whatever the open is. It is not a resting level.</>,
            },
            {
              title: 'Refusals are silent',
              text: <>No exception, no callback. Read <C>result["rejections"]</C> before concluding a rule never triggered.</>,
            },
            {
              title: 'One Backtester runs once',
              text: 'The second call raises. Build a new instance and a new strategy for every window.',
            },
            {
              title: 'The universe hook must settle',
              text: <>It may be probed forward for up to 1826 days. It must return True with tickers and leave that list behind on the final call.</>,
            },
            {
              title: 'Missing tickers are skipped',
              text: 'You can add a symbol with no local data. It never trades and the run does not fail.',
            },
            {
              title: 'Indicators start with NaN',
              text: <>A window shorter than the period leaves the last value NaN, and every comparison against it is False. Use <C>MIN_BARS_REQUIRED</C>.</>,
            },
            {
              title: 'Arrays are read-only',
              text: 'Writing to a StockData array raises ValueError. Compute into a new array.',
            },
            {
              title: 'Shorts are not cash-funded',
              text: 'Exposure is capped by equity, not by available cash, and no borrow fee is charged.',
            },
            {
              title: 'A dropped ticker is still held',
              text: 'Removing it from the universe does not close the lot. The engine keeps polling it for exits.',
            },
            {
              title: 'Fees move the next fill',
              text: 'Orders in the same open are sized one after another, each after the previous fee. The last one may not fit.',
            },
          ],
        },
        {
          kind: 'callout',
          tone: 'tip',
          title: 'The first three explain most surprises',
          text: <>If a fill, an exit or an entry does not happen when you expected, check the day boundary before you check your indicator.</>,
        },
      ],
    },
    {
      slug: 'faq',
      title: 'FAQ',
      lead: 'Short answers to the questions that come up while you read a first result.',
      blocks: [
        { kind: 'h3', id: 'first-trade-late', text: 'Why did my first trade happen a day after the start?' },
        {
          kind: 'p',
          text: <>A signal is a decision, not a fill. <C>on_signal</C> runs on the start date's close and the order fills at the next open. Nothing buys at the close that produced the signal.</>,
        },
        { kind: 'h3', id: 'no-trades', text: 'Why did no trades happen at all?' },
        {
          kind: 'p',
          text: <>Check in this order. Did the universe end up empty? Are the tickers in local data? Is the indicator still NaN? Was every order refused? <C>result["equity"]</C> exists even when nothing trades, so a flat curve is not proof the run failed.</>,
        },
        { kind: 'h3', id: 'win-rate-zero', text: 'Why is win_rate zero on a profitable run?' },
        {
          kind: 'p',
          text: <>Trade statistics only count closed lots. A buy-and-hold strategy has none, so win rate, expectancy and average win are zero while the equity curve rises.</>,
        },
        { kind: 'h3', id: 'cagr-low', text: 'Why does CAGR look low on a three-month test?' },
        {
          kind: 'p',
          text: <>Annualisation divides by at least one year. A short run's total return comes back close to as-is rather than extrapolated. Compare <C>ending_value</C> for short windows.</>,
        },
        { kind: 'h3', id: 'close-everything', text: 'How do I close everything at the end?' },
        {
          kind: 'p',
          text: <>Set <C>LIQUIDATE_ON_END = True</C>. Every open lot closes at the final close with an <C>END_OF_BACKTEST</C> event, paying exit slippage and fees.</>,
        },
        { kind: 'h3', id: 'add-to-position', text: 'Can I add to an existing position?' },
        {
          kind: 'p',
          text: <>Yes, with <C>MAX_LOTS_PER_TICKER</C> above 1. Each entry is a separate lot with its own levels. Nothing averages the entry price.</>,
        },
        { kind: 'h3', id: 'two-exit-types', text: 'Why do I see both STOP_LOSS and SIGNAL exits?' },
        {
          kind: 'p',
          text: <>They are different mechanisms. A stop fires intrabar from the order's levels. A signal exit comes from <C>should_exit</C> and fills at the next open. A strategy can use both at once.</>,
        },
        { kind: 'h3', id: 'tomorrow', text: "Can a strategy see tomorrow's bar?" },
        {
          kind: 'p',
          text: <>No. Every history is sliced so its last element is the current session. Holding a reference across sessions gives you an old view, not a future one.</>,
        },
        { kind: 'h3', id: 'other-window', text: 'How do I run the same strategy on another window?' },
        {
          kind: 'p',
          text: <>Construct a new instance of both the strategy and the Backtester. Reusing either carries state from the previous run.</>,
        },
        { kind: 'h3', id: 'extra-costs', text: 'Which costs should I add on top?' },
        {
          kind: 'p',
          text: <>None for the modelled ones. Slippage and fees are already in every fill. To stress-test a less liquid name, run a copy with a wider stop and a smaller size instead of padding the levels of this one.</>,
        },
        { kind: 'h3', id: 'capacity', text: 'Why did downloads pause in the past?' },
        {
          kind: 'p',
          text: <>Earlier builds sent every download through a small gateway Worker with a monthly read allowance, and a busy month could exhaust it. That gateway is gone. The browser now reads the public bucket directly, the same host the Python engine uses, so there is no monthly allowance left to exhaust.</>,
        },
        {
          kind: 'p',
          text: <>What you may still see: a slow first visit, because the full archive is about 1.4GB and a cold browser has none of it. Charts paint the newest bundles first and older years fill in behind them, and the bytes that do arrive stay in this browser until you clear them.</>,
        },
        {
          kind: 'p',
          text: <>If a download fails, the browser retries it on the next visit and the error names the file it could not get. Write to <C>support@sltp-app.com</C> with that message if it keeps happening.</>,
        },
      ],
    },
    {
      slug: 'glossary',
      title: 'Glossary',
      lead: 'The words these pages use in a specific sense.',
      blocks: [
        {
          kind: 'table',
          head: ['Term', 'Meaning here'],
          rows: [
            ['Allocation', <>Size of one entry. A fraction of equity by default, index points under <C>FIXED</C>, or a cash-capped fraction under <C>AVAILABLE</C>.</>],
            ['Bar', 'One session of OHLCV data. A period is a count of bars, not calendar days.'],
            ['Book', 'The open lots, cash, costs and equity owned by the portfolio manager.'],
            ['CAGR', 'Compounded annual growth rate of the equity index.'],
            ['Drawdown', 'Fall from a previous equity peak, measured in percent.'],
            ['Equity index', 'Portfolio value starting at 100, including cash dividends, used instead of a currency amount.'],
            ['Event', 'An immutable record of a trade closing: date, type and price.'],
            ['Fill', 'The moment an order becomes a trade, at the open or at a resting level.'],
            ['Gap', 'An open beyond a resting level. The fill is the open, not the level.'],
            ['Lot', 'One entry. Stored as one Trade with its own levels and fees.'],
            ['Lookahead', 'Using data from after the decision point. Prevented by slicing.'],
            ['Notional', 'Equity at entry multiplied by allocation, in index points.'],
            ['PSR', 'Probabilistic Sharpe Ratio: confidence that the true Sharpe exceeds 1.0.'],
            ['Rejection', 'A refused order, counted by reason, never raised.'],
            ['Resting exit', 'A stop or target stored on the trade and checked against each bar.'],
            ['Slippage', 'The 0.05% charged against your direction on every fill.'],
            ['Universe', 'The tickers the engine may signal on, held in strategy.tickers.'],
            ['Warmup', 'The forward search for a date on which the universe hook can build.'],
          ],
        },
      ],
    },
    {
      slug: 'changelog',
      title: 'Changelog',
      lead: 'What changed in the documentation and in the engine surface it describes.',
      blocks: [
        { kind: 'h2', id: 'release-0-1-44', text: 'Release 0.1.44 — November 2026' },
        {
          kind: 'p',
          text: <>Market data now comes straight from the public archive, and it covers far more than the United States. The engine moves to <C>0.1.44</C>, and a strategy written for 0.1.42 keeps working unchanged.</>,
        },
        {
          kind: 'ul',
          items: [
            <><strong>No more gateway.</strong> The browser used to fetch every file through a small Worker with a monthly read allowance, and a busy month could pause downloads until that allowance reset. It now reads the same public archive the Python engine reads, so there is no allowance left to run out of. What is left is speed: a first visit still pulls the archive, about 1.4GB in all, newest five years first.</>,
            <><strong>International listings.</strong> Roughly 7,400 companies outside the US are searchable now, from the NSE and the LSE to Tokyo and Toronto. Each one carries its exchange, its country and its quote currency, so a quote opens in the currency it trades in. A button beside the price converts it to yours at the day&apos;s rate, and the chart follows.</>,
            <><strong>A currency setting.</strong> Settings has a new control, Converted price currency. It starts on Auto, which reads your region and falls back to USD, and you can pin any of eleven currencies instead.</>,
            <><strong>Five-year files.</strong> Bars ship as five-year bundles, so 1998 to 2002 is one file. The next bundle is 2028-2032, and it arrives as a new file with no app update. A nightly refresh now rewrites a small tail rather than a whole year.</>,
            <><strong>Backtests stay US.</strong> Long-run tests, the strategy catalogue and the Lab still run on US listings only. International names are for research and charts today, and backtesting them is a later release.</>,
          ],
        },
        {
          kind: 'callout',
          tone: 'note',
          title: 'One thing to know if your browser already had the old files',
          text: <>Per-year files are not read any more. The first visit on this release clears them from the cache once, which frees the space they were holding.</>,
        },
        { kind: 'h2', id: 'release-0-1-42', text: 'Release 0.1.42 — November 2026' },
        {
          kind: 'p',
          text: <>One history per ticker for the whole run instead of one per ticker per session. The fields that hold the bars are now plural, and two of them are gone.</>,
        },
        {
          kind: 'ul',
          items: [
            <><strong>The bar arrays are plural.</strong> <C>closes</C>, <C>opens</C>, <C>highs</C>, <C>lows</C> and <C>volumes</C>. <C>close_price</C>, <C>open_price</C>, <C>high</C>, <C>low</C> and <C>volume</C> raise <C>AttributeError</C>. Rename the reads and nothing else changes.</>,
            <><strong>The <C>dates</C> keyword and <C>labels</C> are gone.</strong> Build with <C>date_codes</C>. Labels come from <C>data.dates</C>, which still indexes and slices like a string array.</>,
            <><strong>A history is a window, not a copy.</strong> The engine keeps one object per ticker and moves its window to the current session before each callback, so <C>len(data)</C> is the bars visible and <C>data.window</C> is the <C>(start, end)</C> pair. A ten-year run used to build about 294,000 of these objects and 1.7M array headers; it now builds one per ticker.</>,
            <><strong>A kept reference follows the window.</strong> The object handed to you today is yesterday&apos;s, widened. Store the values you need, not the object.</>,
            <><strong>Equality is identity.</strong> <C>a == b</C> compared bars cell by cell and raised <C>ValueError</C> whenever a run compared two histories; the generated hash raised on the arrays. Both are identity now.</>,
            <><strong>Results did not move.</strong> The adaptive strategy over 2022&ndash;2026 still ends at <C>172.6053</C> with 270 trades, and the 2020 buy-and-hold baseline still reads <C>118.0106477949049</C>. On that adaptive run, peak memory fell from about 660 MB to about 470 MB.</>,
          ],
        },
        {
          kind: 'code',
          file: 'stockdata_fields.py',
          code: `# 0.1.41 and earlier
close = float(data.close_price[-1])
volume = data.volume[-20:]

# 0.1.42
close = float(data.closes[-1])
volume = data.volumes[-20:]`,
        },
        {
          kind: 'callout',
          tone: 'warning',
          title: '_atr_stop is still broken in 0.1.44',
          text: <>The shipped helper reads <C>data.highss</C> and <C>data.lowss</C>, and <C>StockData</C> exposes neither, so <C>self._atr_stop(trade, 2.0)</C> raises <C>AttributeError</C> in 0.1.44 as well. Compute the ATR from <C>data.highs</C>, <C>data.lows</C> and <C>data.closes</C> yourself, or use <C>_trailing_stop</C>.</>,
        },
        { kind: 'h2', id: 'release-0-1-41', text: 'Release 0.1.41 — November 2026' },
        {
          kind: 'p',
          text: <>One field leaves the order record. A run's results do not change.</>,
        },
        {
          kind: 'ul',
          items: [
            <><strong><C>Order</C> has no <C>order_date</C>.</strong> A strategy no longer states when a signal happened, because the engine never read it: an order fills at the next session&apos;s open, and that bar is the date. The fill is recorded on <C>Trade.entry_date</C>, which is what the trade log already shows.</>,
            <><strong>Passing it now fails loudly.</strong> <C>Order(..., order_date=…)</C> raises <C>TypeError</C> for an unexpected keyword. Delete the argument and the call is otherwise unchanged; keyword callers need no other edit.</>,
            <><strong>Stop and target follow <C>allocation</C>.</strong> <C>stop_loss</C> and <C>take_profit</C> were already required, and with the date gone they sit directly after <C>allocation</C> in the record. Positional callers shift by one field; keyword callers do not.</>,
          ],
        },
        {
          kind: 'code',
          file: 'order_signature.py',
          code: `# 0.1.40 and earlier
Order(ticker, position_type, allocation, order_date, stop_loss, take_profit, meta_data, sizing)

# 0.1.41
Order(ticker, position_type, allocation, stop_loss, take_profit, meta_data, sizing)`,
        },
        { kind: 'h2', id: 'release-0-1-40', text: 'Release 0.1.40 — November 2026' },
        {
          kind: 'p',
          text: <>Two things change what a result contains: a fill that buys almost nothing no longer becomes a trade, and every cost an experiment sets is now a flag on the command line.</>,
        },
        {
          kind: 'ul',
          items: [
            <><strong>Dust fills are refused, not booked.</strong> When the book ran out of cash it still shrank orders to fractions of a cent and booked them as trades: they read as 0.00% allocation and held a position slot for good. Any fill whose notional is under <C>MIN_FILL_NOTIONAL</C> now carries the whole order to the next open instead.</>,
            <><strong>The floor is a knob.</strong> <C>MIN_FILL_NOTIONAL</C> defaults to $0.01, is set per run with <C>Backtester(min_fill_notional=…)</C>, and <C>0.0</C> turns it off. Its value is recorded in the run stamp&apos;s costs.</>,
            <><strong>Running out of cash is not an invalid order.</strong> Zero or negative affordability carries the order, because a sale has to free the cash first. An order that itself asks for a zero or negative allocation is still rejected as invalid.</>,
            <><strong>Costs are command-line flags.</strong> <C>--spread-bps</C>, <C>--max-participation</C>, <C>--min-fill</C> and <C>--borrow-rate</C> work on both <C>sltp backtest</C> and <C>sltp compare</C>. Spread is in basis points; participation is a fraction, the fill floor dollars, borrow an annual fraction.</>,
          ],
        },
        {
          kind: 'callout',
          tone: 'note',
          title: 'What the floor changed',
          text: <>The SMR strategy from 2025-11-01 used to book eight dust fills and now books none. Its ending value moved from 111.82 to 116.09 for one reason: lots worth fractions of a cent were occupying position slots it needed.</>,
        },
        { kind: 'h2', id: 'release-0-1-39', text: 'Release 0.1.39 — November 2026' },
        {
          kind: 'p',
          text: <>The container bars are stored in five-year bundles under <C>MARKET_DATA/DAILY/</C>, one directory per market (<C>US</C> and <C>INTERNATIONAL</C>). Each bundle opens with a short preamble and a JSON header naming each symbol&apos;s rows and each column&apos;s offset, and the columns follow in raw little-endian order. The catalog, the FX table and corporate actions stay parquet; only bars are in bundles.</>,
        },
        {
          kind: 'ul',
          items: [
            <>Rows are stored symbol-major and date-ascending, so a reader slices one symbol&apos;s range instead of parsing parquet row groups and merging calendars.</>,
            <>The engine&apos;s parquet bar path is gone: one header parser serves the engine and <C>sltp data check</C>, and choosing a range reads headers only. The package reads bundles; it does not write them, so a folder of parquet bars is not converted by <C>sltp</C> itself.</>,
            <><C>sltp data status</C> and <C>sltp data check</C> validate a bundle&apos;s header runs and payload sizes, and the sync, prune and R2 layout follow the same keys with <C>.bin</C> payloads.</>,
            'A full archive loads in about 3.9s with the raw payload against 5.7s gzipped, and a warm read takes about 0.9s, so the bundles are stored uncompressed.',
            <>The sorted ticker list is cached instead of re-sorted every day, and the ticker directory only offers symbols that clear <C>MIN_TRADABLE_BARS</C> sessions.</>,
            <>Proof this is a container change and nothing else: the adaptive strategy over 2022&ndash;2026 ends at <C>172.6053</C> with 270 trades on every layout, and the 2020 buy-and-hold baseline still reads <C>118.0106477949049</C>.</>,
          ],
        },
        { kind: 'h2', id: 'structural', text: 'Structural changes since 0.1.36' },
        {
          kind: 'p',
          text: <>Not one release&apos;s fixes: these define the shape every later release assumes.</>,
        },
        {
          kind: 'ul',
          items: [
            <><strong>Strategies declare what they read.</strong> <C>LOOKBACK_BARS</C> trims the bulk read to the history a strategy&apos;s rules need instead of fetching it all.</>,
            <><strong>One rename worth knowing.</strong> <C>MAX_WARMUP_DAYS</C> is now <C>MAX_START_PROBE_DAYS</C>. It never warmed anything: it bounds the forward search for a date the universe hook can build on.</>,
            <><strong>The data layer changed format, not tuning.</strong> Parquet chunks became flat single-file bundles, and the R2 and packaging layout follow the same keys with different payloads.</>,
            <><strong>The fill path has three outcomes.</strong> An order is trimmed to what the cash allows, a remainder or a dust-sized fill carries to the next open, and only an order that is wrong in itself is rejected.</>,
            <><strong>Two kinds of settings.</strong> Experiment knobs — spread, participation, fill floor, borrow — are per-run flags recorded in the run stamp. Machine choices — the data directory and auto-update — live in <C>config.json</C>.</>,
          ],
        },
        {
          kind: 'callout',
          tone: 'note',
          title: 'Where the depth lives',
          text: <>These pages stay at the level of behaviour: what a call does, what a result contains, what a rule costs you. The entries below cover individual features, and the source is the final word when a page and the code disagree.</>,
        },
        { kind: 'h2', id: 'order-sizing', text: 'Order sizing — November 2026' },
        {
          kind: 'ul',
          items: [
            <>Added <C>OrderSizing</C> to <C>Order</C>. <C>EQUITY</C> is the default and keeps the old fraction-of-equity behaviour; <C>FIXED</C> reads <C>allocation</C> as index points; <C>AVAILABLE</C> caps a fraction at uninvested cash.</>,
            <>A zero <C>AVAILABLE</C> order is now a no-op rather than a rejection. The allocation rejection reason is <C>Invalid order allocation for ticker: X | allocation: N</C>.</>,
            'Global Trend Allocation and Statistical Mean Reversion opt into EQUITY explicitly; the default is unchanged for every other strategy.',
            'The Utils and Fills pages describe the three modes, the resolved weight and the cash behaviour.',
          ],
        },
        { kind: 'h2', id: 'global-trend-allocation', text: 'Global Trend Allocation — November 2026' },
        {
          kind: 'ul',
          items: [
            'Added a five-ETF trend book: a ten-month filter, a low-correlation sleeve, one-year momentum and a GLD-or-TLT haven, rebuilt monthly.',
            <>Each entry uses <C>OrderSizing.EQUITY</C> at 19.9% of the book; the eight reported windows now carry strategy-versus-benchmark charts.</>,
            'The strategy page documents the sequential matrix, the cash buffer and the cases where the last fill is refused.',
          ],
        },
        { kind: 'h2', id: 'adaptive-momentum', text: 'Adaptive Momentum — November 2026' },
        {
          kind: 'ul',
          items: [
            'Added a long-only momentum strategy: the top 20 liquid US stocks by 12-month return, skipping the latest month, with the score divided by 126-day volatility.',
            'A 60% annualized volatility ceiling removes the parabolic names that wreck a plain momentum screen; SPY above its 200-day average is the risk switch.',
            'Monthly rebalance, a top-40 holding buffer, and eight report windows with fees, slippage and dividends included.',
          ],
        },
        { kind: 'h2', id: 'dividends', text: 'Cash dividends — November 2026' },
        {
          kind: 'ul',
          items: [
            "Lots held from the previous close collect cash dividends on the ex-date, before that session's fills. A buy on the ex-date does not.",
            <>Equity is <C>starting + realized + dividends − costs + unrealized</C>. Closed-trade returns include the cash.</>,
            <><C>Trade</C> and <C>metrics</C> carry <C>dividend_income</C>; <C>Backtester</C> takes <C>include_dividends=True</C> for a price-only comparison.</>,
            'Non-positive, non-finite and implausibly large distributions are dropped before the engine sees them.',
            'The Results, Engine, Utils and Getting started pages describe the new field, step and formula.',
            'Strategy reports and their charts were regenerated with dividends included.',
          ],
        },
        { kind: 'h2', id: 'docs-2', text: 'Docs 2.0 — November 2026' },
        {
          kind: 'ul',
          items: [
            'Rebuilt as a routed site: one page per topic, a persistent grouped sidebar, an on-page contents rail and search over titles and headings.',
            'Thirty-nine pages, ordered the way the engine executes rather than by feature.',
            'Every parameter name, method signature and constant checked against the source at the time of writing.',
            'Engine and portfolio behaviour is described in prose; code appears only where a rule is easier to read than to explain.',
          ],
        },
        { kind: 'h2', id: 'source-fixes', text: 'Source corrections published with these docs' },
        {
          kind: 'ul',
          items: [
            <><C>Strategy.equity</C> now exists as a read-only property, matching what the documentation and the manager already referred to.</>,
            <><C>_atr_stop</C> compares against the latest ATR value instead of an array of them, which previously made the comparison ambiguous.</>,
            <><C>Order</C> and <C>Trade</C> comments now call the field <C>allocation</C> everywhere; the word "weight" is gone.</>,
            'The base class header names the real hooks and properties: open_positions, run_daily and equity.',
          ],
        },
        { kind: 'h2', id: 'engine-2', text: 'Engine 2.0 — current behaviour' },
        {
          kind: 'ul',
          items: [
            'Dates are stored as int32 day numbers in a shared calendar, so a bar costs four bytes instead of forty.',
            'Every callback sees read-only arrays ending on its own session. There is no path to a future bar.',
            'One entry is one lot. Scale-ins never average an entry price.',
            'Exit checks are pessimistic: the stop is tested first, and gaps fill at the open.',
            'Order refusals are counted by reason and returned with the result.',
            'A Backtester refuses to run twice.',
          ],
        },
        { kind: 'h2', id: 'runtime-versions', text: 'Runtime versions' },
        {
          kind: 'table',
          head: ['Runtime', 'Pinned sltp version'],
          rows: [
            ['Browser engine (Pyodide)', '0.1.44'],
            ['Lab (Pyodide)', '0.1.44'],
            ['Backend', '>=0.1.44'],
          ],
        },
        {
          kind: 'callout',
          tone: 'note',
          title: 'Versioning',
          text: <>These docs track the <C>sltp</C> package on PyPI. The browser engine is pinned to <C>sltp 0.1.44</C>; the backend requires <C>sltp&gt;=0.1.44</C>. The backend and the site release separately; the headings below name behaviour, not a tagged build.</>,
        },
      ],
    },
  ],
};
