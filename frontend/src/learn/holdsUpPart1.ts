// holdsUpPart1.ts — Level 5 opens with costs and time: the toll for one
// round trip, the pace that multiplies it and the clock that sets the rate.

import type { LessonContent } from './types';

export const HOLDS_UP_PART_1: Record<string, LessonContent> = {
  'costs-time': {
    objectives: [
      'Price a round trip and the move it needs to break even',
      'Turn a per-trade cost into a yearly cost at your turnover',
      'See why the same toll is small at one speed and fatal at another',
    ],
    blocks: [
      { kind: 'p', text: 'A day trade rents the market for minutes. The rent is charged on the way in and again on the way out.' },
      { kind: 'p', text: 'Most traders can quote the commission. Fewer can quote the whole round trip, and fewer still can turn it into a yearly rate.' },
      { kind: 'p', text: 'The arithmetic is short enough to do before the open. It decides whether a strategy has a chance before the first entry.' },
      { kind: 'terms', items: [
        { term: 'Round trip', text: 'One buy and the sell that ends it. Both sides pay.' },
        { term: 'Hurdle', text: 'The price move a position needs before its costs are covered.' },
        { term: 'Cost drag', text: 'The share of a year of return that costs take at a given speed.' },
        { term: 'Basis point', text: 'One hundredth of a percentage point, written as 0.01%.' },
        { term: 'Spread', text: 'The gap between the best bid and the best ask.' },
        { term: 'Slippage', text: 'The difference between the price you expected and the price you got.' },
        { term: 'Turnover', text: 'How much you trade relative to the size of the account.' },
      ] },

      { kind: 'h', text: 'The toll' },
      { kind: 'p', text: 'A quote has two prices. You buy at the ask and sell at the bid, so the pair of fills crosses one full spread.' },
      { kind: 'p', text: 'Commission is the visible part. On a liquid US share it is often zero, while the spread and the fill still cost money.' },
      { kind: 'p', text: 'Add the parts and you have the toll for one round trip. Divide by the notional to express it in basis points.' },
      { kind: 'formula', title: 'One round trip, in basis points', rows: [
        { label: 'Spread', expression: 'spread in cents ÷ price × 100', note: 'A 2 cent spread on a $40 share is 5 bps.' },
        { label: 'Slippage', expression: 'actual fill − expected fill, in bps', note: 'A fill 3 cents worse on a $40 share adds 7.5 bps.' },
        { label: 'Commission', expression: 'commission a share × 2 ÷ price × 100', note: 'At $0.005 a share on a $40 share, both sides add 2.5 bps.' },
        { label: 'Hurdle', expression: 'total cost ÷ notional × 10,000', note: 'The move a trade needs before it is flat.' },
      ] },
      { kind: 'figure', widget: 'toll-receipt', caption: 'Set the price, the spread and the fill. The receipt shows what one round trip costs and the move it needs to get back to flat.' },

      { kind: 'h', text: 'The multiplier' },
      { kind: 'p', text: 'One toll is small enough to ignore. The number that decides the outcome is the toll multiplied by the round trips in a year.' },
      { kind: 'p', text: 'A toll of ten basis points, paid once a day, is about 25% of the account over 252 sessions. Ten times a day multiplies that by ten.' },
      { kind: 'p', text: 'The account size does not change the rate. The notional traded does, so half a position pays half the toll and needs half the edge.' },
      { kind: 'formula', title: 'From one trade to one year', rows: [
        { label: 'Yearly cost', expression: 'toll × round trips a year', note: '10 bps × 2,520 round trips is 25,200 bps, or 252%.' },
        { label: 'At half size', expression: 'yearly cost × share of the account traded', note: 'Half the notional pays half the cost and needs half the edge.' },
      ] },
      { kind: 'figure', widget: 'turnover-grid', caption: 'Pick a toll and a pace. The table prices the year, not the trade.' },

      { kind: 'h', text: 'The clock' },
      { kind: 'p', text: 'The same toll is a rounding error on a two-year hold and a serious tax on a two-minute one.' },
      { kind: 'p', text: 'Annual cost depends on how often the capital is rented out. Speed raises the number of tolls and time lowers it.' },
      { kind: 'p', text: 'The clock cuts both ways. A rule that is flat most of the day avoids the toll and also collects nothing.' },
      { kind: 'formula', title: 'Cost per unit of time', rows: [
        { label: 'Round trips a year', expression: 'sessions × round trips a session', note: '252 × 6 is 1,512.' },
        { label: 'Cost a year', expression: 'toll × round trips a year', note: '8 bps × 1,512 is 12,096 bps, or 121% of the notional traded.' },
        { label: 'Cost a minute', expression: 'toll ÷ holding minutes', note: 'A 10 bps toll on a 5 minute hold is 2 bps a minute.' },
      ] },
      { kind: 'figure', widget: 'cost-clock', caption: 'The same toll at seven holding periods. The scale is logarithmic, so each step is ten times the one below.' },

      { kind: 'h', text: 'The record' },
      { kind: 'p', text: 'The clearest evidence on turnover is old and still useful. Barber and Odean studied 66,465 accounts at a large US discount broker from 1991 to 1996.' },
      { kind: 'p', text: 'The fifth that traded most earned 11.4% a year after costs. The fifth that traded least earned 18.5%, and the market returned 17.9%.' },
      { kind: 'p', text: 'The authors traced the gap to costs and frequency, not to worse stock picking. The average round trip in their sample cost about 4%, mostly commissions.' },
      { kind: 'p', text: 'Commissions have collapsed since. The level is dated, and the arithmetic behind it is not.' },
      { kind: 'figure', widget: 'turnover-record', caption: 'The busiest fifth finished 6.5 points a year below the market over the same six years.' },

      { kind: 'h', text: 'What you do with it' },
      { kind: 'p', text: 'Work out the round trip before you test the rule. A strategy that needs a 12 basis point move to break even must win by more than 12 basis points on average.' },
      { kind: 'p', text: 'Compare the yearly cost with the yearly edge. If the cost is larger, the rule loses before the market does anything.' },
      { kind: 'p', text: 'Keep three numbers together: toll per round trip, round trips a year, and gross edge per trade. Any one alone says very little.' },
      { kind: 'list', items: [
        'The toll, in basis points, priced at the size you really trade.',
        'The round trips a year, at the pace you really keep.',
        'The gross edge per trade, from a test that charged the same toll.',
      ] },
      { kind: 'callout', tone: 'watch', title: 'A low commission is not a low cost', text: 'The spread and the fill are charged even when the commission is zero. Count the whole toll, not the line on the statement.' },
    ],
    recap: [
      'A round trip pays the spread, the fill and the commission.',
      'Yearly cost is the toll multiplied by the round trips in a year.',
      'The same toll is small on a slow hold and large on a fast one.',
    ],
    check: [
      {
        id: 'up-a1',
        lessonId: 'costs-time',
        prompt: 'A round trip costs 8 bps and you make 6 a session for 252 sessions at full size. What does the year cost, as a share of the notional traded?',
        options: ['About 12%', 'About 48%', 'About 121%', 'About 1,210%'],
        correctIndex: 2,
        explanation: '8 × 6 × 252 is 12,096 bps, or 120.96%.',
        hint: 'Multiply the toll by the round trips, then divide by 100.',
      },
      {
        id: 'up-a2',
        lessonId: 'costs-time',
        prompt: 'You buy at the ask and sell at the bid. Which cost does that pair of fills cross?',
        options: ['The commission', 'The spread', 'The dividend', 'The expense ratio'],
        correctIndex: 1,
        explanation: 'Buying at the ask and selling at the bid gives up the gap between them, which is the spread.',
        hint: 'Compare the two prices in the quote.',
      },
      {
        id: 'up-a3',
        lessonId: 'costs-time',
        prompt: 'What did Barber and Odean blame for the gap between the busiest and quietest households?',
        options: ['Worse stock selection', 'Costs and trading frequency', 'A different benchmark', 'Taxes on dividends'],
        correctIndex: 1,
        explanation: 'The paper found the gap came from what trading cost and how often it happened, not from the stocks chosen.',
        hint: 'The title of the paper points at trading.',
      },
    ],
  },
};
