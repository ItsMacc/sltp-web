// templates.ts — the starting strategies the New project wizard offers.
//
// Every template is a Strategy class, not a script that builds a Backtester.
// Run finds the class, instantiates it and runs it over the default window,
// so a new project is one click from a real report.
//
// The four named templates are the prebuilt strategies the browser engine
// runs, imported straight from their sources so the wizard always shows the
// code that ships with the engine.

import { Crosshair, FileCode, Globe, Shield, TrendingUp, type LucideIcon } from 'lucide-react';

import adaptiveMomentumSource from '../store/strategies/adaptive_momentum.py?raw';
import gtaSource from '../store/strategies/global_trend_allocation.py?raw';
import minVolSource from '../store/strategies/minimum_volatility.py?raw';
import smrSource from '../store/strategies/statistical_mean_reversion.py?raw';

export type LabTemplateId =
  | 'blank'
  | 'adaptive-momentum'
  | 'global-trend-allocation'
  | 'minimum-volatility'
  | 'statistical-mean-reversion';

export interface LabTemplate {
  id: LabTemplateId;
  name: string;
  summary: string;
  /** Where the starting code lives, shown under the name. */
  rule: string;
  /** The first lines of the file, shown in the wizard. */
  preview: string[];
  /** What every project starts with: workspace/main.py. */
  code: string;
  icon: LucideIcon;
}

/** Drop the "browser copy" note: it explains the bundling, not the strategy. */
function starter(source: string): string {
  return source
    .split('\n')
    .filter((line) => !line.startsWith('# BROWSER COPY') && !line.startsWith('# inside the engine worker'))
    .join('\n');
}

// The starting point a new reader sees. It is deliberately bare: the methods
// the engine calls, one line each, and nothing to delete before writing the
// first rule. Everything else lives in the docs, where it can be read once.
const BLANK = `from sltp import Order, OrderSizing, PositionType, RebalanceFrequency, StockData, Strategy


class MyStrategy(Strategy):

    def initialize_universe(self, current_date: str, histories: dict[str, StockData]) -> bool:
        # The tickers this strategy may trade.
        self.add_tickers(["AAPL", "MSFT", "NVDA", "SPY"])
        return True

    def run_daily(self, current_date: str) -> None:
        # Once per session, before any ticker is read.
        pass

    def on_rebalance(self, current_date: str, histories: dict[str, StockData]) -> None:
        # When REBALANCE_FREQUENCY is due.
        pass

    def on_signal(self, ticker: str, data: StockData) -> Order | None:
        # TODO: Your strategy logic here
        return None
`;

const ADAPTIVE_MOMENTUM = starter(adaptiveMomentumSource);
const GLOBAL_TREND_ALLOCATION = starter(gtaSource);
const MINIMUM_VOLATILITY = starter(minVolSource);
const STATISTICAL_MEAN_REVERSION = starter(smrSource);

export const LAB_TEMPLATES: LabTemplate[] = [
  {
    id: 'blank',
    name: 'Strategy skeleton',
    summary: 'The methods the engine calls, one line each, and nothing else.',
    rule: 'Starts in workspace/main.py',
    preview: [
      'class MyStrategy(Strategy):',
      '    def initialize_universe(self, current_date, histories):',
      '    def run_daily(self, current_date):',
      '    def on_rebalance(self, current_date, histories):',
      '    def on_signal(self, ticker, data):',
      '        # TODO: Your strategy logic here',
    ],
    code: BLANK,
    icon: FileCode,
  },
  {
    id: 'adaptive-momentum',
    name: 'Adaptive Momentum',
    summary: 'Holds the 20 strongest liquid US stocks while SPY is above its 200-day average.',
    rule: 'Starts in workspace/main.py',
    preview: [
      'class AdaptiveMomentum(Strategy):',
      'score = momentum / volatility',
      'if self._market_is_on(histories):',
    ],
    code: ADAPTIVE_MOMENTUM,
    icon: TrendingUp,
  },
  {
    id: 'global-trend-allocation',
    name: 'Global Trend Allocation',
    summary: 'Five-ETF book from trend, correlation and momentum. Exits a sleeve when its trend breaks.',
    rule: 'Starts in workspace/main.py',
    preview: [
      'class GlobalTrendAllocation(Strategy):',
      'self.MAX_POSITIONS: int = 5',
      'picks = self._execute_selection_matrix(...)',
    ],
    code: GLOBAL_TREND_ALLOCATION,
    icon: Globe,
  },
  {
    id: 'minimum-volatility',
    name: 'Minimum Volatility',
    summary: 'Equal-weighted 30 least volatile liquid US stocks, rebuilt quarterly.',
    rule: 'Starts in workspace/main.py',
    preview: [
      'class MinimumVolatility(Strategy):',
      'self.REBALANCE_FREQUENCY = RebalanceFrequency.QUARTERLY',
      'self._rank(histories)',
    ],
    code: MINIMUM_VOLATILITY,
    icon: Shield,
  },
  {
    id: 'statistical-mean-reversion',
    name: 'Statistical Mean Reversion',
    summary: 'Buys stocks that fell further than their volatility explains, then waits for the snap back.',
    rule: 'Starts in workspace/main.py',
    preview: [
      'class StatisticalMeanReversionStrategy(Strategy):',
      'if rsi < self.RSI_THRESHOLD and z_score < -self.Z_SCORE_THRESHOLD:',
      'stop and target at 3 standard deviations',
    ],
    code: STATISTICAL_MEAN_REVERSION,
    icon: Crosshair,
  },
];

export function getTemplate(id: LabTemplateId): LabTemplate {
  return LAB_TEMPLATES.find((template) => template.id === id) ?? LAB_TEMPLATES[0];
}
