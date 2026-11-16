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
        { kind: 'h3', id: 'capacity', text: "We didn't expect this many people this month" },
        {
          kind: 'p',
          text: <>Because that is exactly what happened. We sized our market-data budget for the number of people we thought would join this month, and more of you arrived than we planned for. When that budget runs out, new downloads pause for the rest of the month.</>,
        },
        {
          kind: 'p',
          text: <>What keeps working: everything already saved in your browser. Charts, strategies and the Lab keep running on the history that device has. What waits: history it has never downloaded, such as older years, or a first visit on a new device.</>,
        },
        {
          kind: 'p',
          text: <>When it comes back: the allowance renews on the 6th of each month. We are raising it as fast as we can, so it may return sooner. Nothing is lost in the meantime, and you do not have to do anything: the download continues by itself on the first visit after the reset.</>,
        },
        {
          kind: 'p',
          text: <>If a date has passed and you are still seeing this, write to <C>support@sltp-app.com</C> with what the toast said, and we will look at your account.</>,
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
        { kind: 'h2', id: 'release-0-1-39', text: 'Release 0.1.39 — November 2026' },
        {
          kind: 'p',
          text: <>One release number covers a lot this time, so here is the whole of it in one place before the details below. If you have read the engine source but this is your first pass over the docs, start here: these are the changes that alter what a result means.</>,
        },
        {
          kind: 'ul',
          items: [
            <><strong>Order sizing is explicit.</strong> An order can be a fraction of equity, which is the old behaviour and still the default. It can also be a fixed number of index points, or a fraction capped by the cash you hold. The <C>OrderSizing</C> enum and the three modes are on the Utils page.</>,
            <><strong>Dividends are paid.</strong> A lot held from the previous close collects cash on the ex-date, before that session&apos;s fills. Equity and closed-trade returns include it, and <C>include_dividends=False</C> reproduces the old price-only curve. Results pages show <C>dividend_income</C>.</>,
            <><strong>Three strategies joined the library:</strong> Global Trend Allocation, Adaptive Momentum and a revised Statistical Mean Reversion. Each has a report, a rules page and eight windows with fees, slippage and dividends in.</>,
            <><strong>The stored history changed container.</strong> A period&apos;s bars now live in one self-contained binary file instead of parquet: a header naming each symbol&apos;s run, then the columns. A chart reads one symbol&apos;s slice rather than a whole file, which is why a first load is quicker than it used to be. Nothing in the API changes \u2014 <C>query_market_data</C> and the Lab see the same frames.</>,
            <><strong>The engine surface did not break.</strong> No strategy hook changed signature, no constant was renamed. Existing strategies run unchanged; the differences you can measure are dividends, if you were running price-only before.</>,
          ],
        },
        {
          kind: 'callout',
          tone: 'note',
          title: 'Where the depth lives',
          text: <>These pages stay at the level of behaviour: what a call does, what a result contains, what a rule costs you. The code-level notes for this release are in the entries below, and the source is the final word when a page and the code disagree.</>,
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
            'Every callback receives an immutable, as-of-date slice. There is no path to a future bar.',
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
            ['Browser engine (Pyodide)', '0.1.39'],
            ['Lab (Pyodide)', '0.1.39'],
            ['Backend', '>=0.1.39'],
          ],
        },
        {
          kind: 'callout',
          tone: 'note',
          title: 'Versioning',
          text: <>These docs track the <C>sltp</C> package on PyPI. The browser engine is pinned to <C>sltp 0.1.39</C>; the backend requires <C>sltp&gt;=0.1.39</C>. The backend and the site release separately; the headings below name behaviour, not a tagged build.</>,
        },
      ],
    },
  ],
};
