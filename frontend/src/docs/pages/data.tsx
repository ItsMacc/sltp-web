// data.tsx — Where the bars come from, how to replace them, and how to check a replacement.
import { C } from '../Blocks';
import type { DocGroup } from '../types';

export const DATA: DocGroup = {
  id: 'data',
  title: 'Data',
  source: 'frontend/src/docs/pages/data.tsx',
  pages: [
    {
      slug: 'data',
      title: 'Data',
      lead: 'Every run reads daily bars from one place. This page covers where that place is, how to point the engine at your own files, and how to check them before you trust a number they produced.',
      blocks: [
        {
          kind: 'p',
          text: (
            <>
              A strategy never reads bars itself. It asks the engine for a session, and the engine answers from
              whatever source is configured. That separation is what lets you swap the feed without touching a line
              of strategy code.
            </>
          ),
        },
        { kind: 'h2', id: 'sources', text: 'Where bars come from' },
        {
          kind: 'p',
          text: <>Every run reads from the first source that has the bars it needs:</>,
        },
        {
          kind: 'ol',
          items: [
            <>
              Your own directory, if you set one with <C>sltp data use</C>, or with <C>SLTP_DATA_DIR</C> for a
              single run.
            </>,
            <>
              The managed cache in <C>~/.sltp/cache</C>, refreshed from R2.
            </>,
          ],
        },
        {
          kind: 'callout',
          tone: 'note',
          title: 'A fresh install needs no setup',
          text: (
            <>
              The first run downloads the bars its dates need. Later runs check a version stamp and top up only when
              the cache has moved, so a repeat of the same backtest does no network work.
            </>
          ),
        },
        { kind: 'h2', id: 'cache', text: 'The cache, and why a number moved' },
        {
          kind: 'p',
          text: (
            <>
              Each run records the source it used in <C>{'result["stamp"]["data_source"]'}</C>, as{' '}
              <C>own:&lt;dir&gt;</C> for a directory you pointed at, or <C>cache@&lt;version&gt;</C> for the managed
              cache. Two runs that disagree can therefore be explained without guessing: either the strategy changed,
              or the bars did.
            </>
          ),
        },
        {
          kind: 'p',
          text: (
            <>
              Pin <C>end_date</C> and a rerun over unchanged data is byte-identical. That is the property to rely on
              when you are chasing a difference between two results.
            </>
          ),
        },
        { kind: 'h2', id: 'own-bars', text: 'Bringing your own bars' },
        {
          kind: 'p',
          text: <>A directory is a valid source when it holds:</>,
        },
        {
          kind: 'ul',
          items: [
            <>
              Five-year bundles under <C>MARKET_DATA/DAILY/US/</C>, named <C>1998-2002.bin</C>,{' '}
              <C>2003-2007.bin</C> and so on. Each one is a self-contained container: a short preamble, a
              JSON header naming each symbol&apos;s rows and each column&apos;s offset, then the columns. The
              name is a label; the header decides which sessions the file holds.
            </>,
            <>
              <C>actions.parquet</C> inside each market directory for splits and dividends.
            </>,
            <>
              <C>MARKET_DATA/DAILY/INTERNATIONAL/</C> for every listing outside the US, in the same shape.
            </>,
            <>
              Columns are fixed by the format: symbol and date as 16-bit integers,{' '}
              <C>Open</C>, <C>High</C>, <C>Low</C>, <C>Close</C> and <C>Volume</C> as floats, with rows stored
              symbol by symbol and date-ascending.
            </>,
          ],
        },
        {
          kind: 'p',
          text: (
            <>
              Writing that layout is not part of the package. <C>sltp</C> reads bundles and{' '}
              <C>sltp data check</C> validates them, so the files must come from a publisher. Once
              they are in place, nothing about a run changes.
            </>
          ),
        },
        { kind: 'h2', id: 'testing', text: 'Testing your own data' },
        {
          kind: 'p',
          text: (
            <>
              Validate first, then use. <C>sltp data check</C> reads a directory the way a run would and reports what
              it found, without switching the source, so a broken folder costs nothing.
            </>
          ),
        },
        {
          kind: 'code',
          language: 'bash',
          code: `sltp data check ./my_bars     # validate before trusting it
sltp data use ./my_bars       # every later run reads these files
sltp data auto off            # no network at all from here
sltp backtest momentum.py --start 2019-01-01 --end 2023-12-31`,
        },
        {
          kind: 'p',
          text: (
            <>
              Then read the stamp. A run over your folder reports <C>own:./my_bars</C>; if it still says{' '}
              <C>cache@…</C>, the directory was rejected and the default was used, which is the one failure that
              otherwise looks like a strategy problem. Comparing the same strategy and dates against both sources
              tells you whether your feed and the managed one agree.
            </>
          ),
        },
        {
          kind: 'callout',
          tone: 'warning',
          title: 'A missing ticker is silent',
          text: (
            <>
              Tickers with no bars are skipped, not reported as errors. A universe built from a misspelled symbol
              therefore looks like a strategy that simply never trades. If a run is flat, check the names in your data
              before you check the strategy.
            </>
          ),
        },
        {
          kind: 'p',
          text: (
            <>
              <C>sltp data use --clear</C> forgets the directory and returns to the cache. With <C>auto off</C> the
              engine never phones home, and it warns when the local files go stale instead of failing or quietly
              downloading new ones.
            </>
          ),
        },
        { kind: 'h2', id: 'commands', text: 'The data commands' },
        {
          kind: 'table',
          head: ['Command', 'What it does'],
          rows: [
            ['sltp data', 'Shows the source in use and how fresh it is. This is the default action.'],
            ['sltp data update', 'Downloads the latest bars from R2 now, instead of waiting for the next run.'],
            ['sltp data auto on', 'Refresh on every run. This is the default.'],
            ['sltp data auto off', 'Stay offline and run on whatever is already cached.'],
            ['sltp data use DIR', 'Read bars from DIR instead of the cache.'],
            ['sltp data use --clear', 'Forget DIR and go back to the default source.'],
            ['sltp data check DIR', 'Validate a directory. Without DIR it checks the source currently in use.'],
            ['sltp reset', 'Forget every setting, including the data directory, and behave like a fresh install.'],
          ],
        },
        {
          kind: 'callout',
          tone: 'note',
          title: 'One bias the data cannot remove',
          text: (
            <>
              A ticker that stops trading is verified, then archived: its bars leave the bundles and its
              record moves to <C>META/delisted.json</C>. No run can trade it again, which is the honest way to
              keep a graveyard out of the data. It also means a run only meets listings that survived. The
              companies that failed are missing from the sample, so results lean a little optimistic. Treat a
              backtest as the best case for an idea, not a replay of everything that existed.
            </>
          ),
        },
        { kind: 'h2', id: 'next', text: 'What is coming' },
        {
          kind: 'p',
          text: (
            <>
              The bundle layout above is the current contract. More support for custom data is planned: additional
              ways to supply bars, and clearer checks when a directory is close but not quite right. Until that
              lands, <C>sltp data check</C> is the honest answer to "will this folder work".
            </>
          ),
        },
      ],
    },
  ],
};
