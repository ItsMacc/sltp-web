// CostsTimeLesson.tsx — Lesson A of Level 5 is a worksheet rather than a
// chapter: a paper receipt for one round trip, a heat table for the year, a
// log-scale clock for holding time and one sourced study.

import { Fragment, useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { GlossaryText } from '../../components/GlossaryText';
import { LEARN_GLOSSARY } from '../../learn/learnGlossary';
import type { ContentBlock, WidgetId } from '../../learn/types';
import './CostsTimeLesson.css';

const G = ({ children }: { children: string }) => (
  <GlossaryText text={children} glossary={LEARN_GLOSSARY} />
);

const usd = (value: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  }).format(value);

const amount = (value: number) => new Intl.NumberFormat('en-US').format(value);

const rateText = (value: number) => {
  if (value >= 100) return `${amount(Math.round(value))}%`;
  if (value >= 10) return `${Math.round(value)}%`;
  return `${value.toFixed(1)}%`;
};

const PANEL_TAGS: Partial<Record<WidgetId, string>> = {
  'toll-receipt': 'Move the inputs',
  'turnover-grid': 'Pick a cell',
  'cost-clock': 'Pick a holding time',
  'turnover-record': 'One study',
};

const PANEL_EYEBROWS: Partial<Record<WidgetId, string>> = {
  'toll-receipt': 'Receipt: one round trip',
  'turnover-grid': 'Table: cost of a year',
  'cost-clock': 'Chart: cost by holding time',
  'turnover-record': 'Evidence: turnover and return',
};

/* ---------- Lesson body ---------- */

interface Station {
  heading: string;
  blocks: ContentBlock[];
}

function splitBlocks(blocks: ContentBlock[]) {
  const termsBlock = blocks.find((block) => block.kind === 'terms');
  const terms = termsBlock && termsBlock.kind === 'terms' ? termsBlock.items : [];
  const stream = blocks.filter((block) => block !== termsBlock);
  const firstHeading = stream.findIndex((block) => block.kind === 'h');
  const lead = firstHeading < 0 ? stream : stream.slice(0, firstHeading);
  const stations: Station[] = [];
  if (firstHeading >= 0) {
    for (let index = firstHeading; index < stream.length; index += 1) {
      const block = stream[index];
      if (block.kind === 'h') {
        stations.push({ heading: block.text, blocks: [] });
      } else if (stations.length) {
        stations[stations.length - 1].blocks.push(block);
      }
    }
  }
  return { lead, terms, stations };
}

export function CostsTimeLesson({ blocks }: { blocks: ContentBlock[] }) {
  const { lead, terms, stations } = useMemo(() => splitBlocks(blocks), [blocks]);
  const [active, setActive] = useState(0);

  useEffect(() => {
    const nodes = stations
      .map((_, index) => document.getElementById(`ct-station-${index + 1}`))
      .filter((node): node is HTMLElement => Boolean(node));
    if (!nodes.length) return;
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          const index = nodes.indexOf(entry.target as HTMLElement);
          if (index >= 0) setActive(index);
        });
      },
      { rootMargin: '-35% 0px -55% 0px' },
    );
    nodes.forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [stations]);

  const jump = (index: number) => {
    const target = document.getElementById(`ct-station-${index + 1}`);
    if (!target) return;
    target.scrollIntoView({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      block: 'start',
    });
  };

  return (
    <div className="ct-lesson">
      <div className="ct-brief">
        <div className="ct-lead">
          {lead.map((block, index) => (
            <Block key={`lead-${index}`} block={block} />
          ))}
        </div>
        {terms.length > 0 && (
          <aside className="ct-words" aria-labelledby="ct-words-title">
            <p className="ct-eyebrow" id="ct-words-title">Words you need</p>
            <ol className="ct-words-list">
              {terms.map((item, index) => (
                <li className="ct-word" key={item.term}>
                  <span className="ct-word-num" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
                  <span>
                    <span className="ct-word-term">{item.term}</span>
                    <span className="ct-word-text"><G>{item.text}</G></span>
                  </span>
                </li>
              ))}
            </ol>
          </aside>
        )}
      </div>

      {stations.length > 1 && (
        <nav className="ct-route" aria-label="Stations in this lesson">
          {stations.map((station, index) => (
            <button
              key={station.heading}
              type="button"
              className={`ct-route-btn${index === active ? ' is-active' : ''}`}
              onClick={() => jump(index)}
            >
              <span aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
              {station.heading}
            </button>
          ))}
        </nav>
      )}

      {stations.map((station, index) => (
        <section
          className="ct-station"
          id={`ct-station-${index + 1}`}
          key={station.heading}
          aria-labelledby={`ct-station-title-${index + 1}`}
        >
          <div className="ct-gutter" aria-hidden="true">
            <span>{String(index + 1).padStart(2, '0')}</span>
          </div>
          <div className="ct-station-main">
            <h2 className="ct-station-title" id={`ct-station-title-${index + 1}`}>{station.heading}</h2>
            {station.blocks.map((block, blockIndex) => (
              <Block key={`${station.heading}-${blockIndex}`} block={block} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function Block({ block }: { block: ContentBlock }) {
  if (block.kind === 'p') {
    return (
      <p className="ct-copy">
        <G>{block.text}</G>
      </p>
    );
  }
  if (block.kind === 'list') {
    const Tag = block.ordered ? 'ol' : 'ul';
    return (
      <Tag className="ct-list">
        {block.items.map((item) => (
          <li key={item}><G>{item}</G></li>
        ))}
      </Tag>
    );
  }
  if (block.kind === 'formula') {
    return (
      <div className="ct-formula">
        {block.title && <p className="ct-eyebrow">{block.title}</p>}
        <dl className="ct-formula-list">
          {block.rows.map((row) => (
            <div className="ct-formula-row" key={row.label}>
              <dt>{row.label}</dt>
              <dd>
                <code>{row.expression}</code>
                {row.note && <span>{row.note}</span>}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    );
  }
  if (block.kind === 'callout') {
    return (
      <div className={`ct-note ct-note--${block.tone}`}>
        <p className="ct-note-title">{block.title}</p>
        <p><G>{block.text}</G></p>
      </div>
    );
  }
  if (block.kind === 'figure') {
    return (
      <figure className="ct-figure">
        <div className="ct-panel">
          <div className="ct-panel-head">
            <p className="ct-eyebrow">{PANEL_EYEBROWS[block.widget] ?? 'Figure'}</p>
            <span className="ct-panel-tag">{PANEL_TAGS[block.widget] ?? 'Interactive'}</span>
          </div>
          <StationWidget id={block.widget} />
        </div>
        <figcaption className="ct-caption">{block.caption}</figcaption>
      </figure>
    );
  }
  return null;
}

function StationWidget({ id }: { id: WidgetId }) {
  switch (id) {
    case 'toll-receipt':
      return <TollReceipt />;
    case 'turnover-grid':
      return <TurnoverGrid />;
    case 'cost-clock':
      return <CostClock />;
    case 'turnover-record':
      return <TurnoverRecord />;
    default:
      return null;
  }
}

/* ---------- Controls ---------- */

function Slider({
  label,
  value,
  display,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  display: string;
  min: number;
  max: number;
  step: number;
  onChange: (next: number) => void;
}) {
  return (
    <label className="ct-slider">
      <span className="ct-slider-label">
        {label}
        <strong>{display}</strong>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

/* ---------- 01, the toll ---------- */

function TollReceipt() {
  const [price, setPrice] = useState(42);
  const [spread, setSpread] = useState(1.2);
  const [shares, setShares] = useState(500);
  const [slip, setSlip] = useState(3);
  const [commission, setCommission] = useState(0);

  const notional = price * shares;
  const spreadCost = (spread * shares) / 100;
  const slipCost = (notional * slip) / 10000;
  const commissionCost = commission * shares * 2;
  const total = spreadCost + slipCost + commissionCost;
  const totalBps = (total / notional) * 10000;
  const moveCents = (total / shares) * 100;

  return (
    <div className="ct-toll">
      <div className="ct-receipt" role="group" aria-label="The cost of one round trip">
        <div className="ct-receipt-head">
          <span className="ct-eyebrow">One round trip</span>
          <span>{amount(shares)} shares at ${price}</span>
        </div>
        <div className="ct-receipt-row">
          <span>Spread, {spread.toFixed(1)}¢ a share</span>
          <span className="ct-leader" aria-hidden="true" />
          <strong>{usd(spreadCost)}</strong>
        </div>
        <div className="ct-receipt-row">
          <span>Slippage, {slip} bps</span>
          <span className="ct-leader" aria-hidden="true" />
          <strong>{usd(slipCost)}</strong>
        </div>
        <div className="ct-receipt-row">
          <span>Commission, both sides</span>
          <span className="ct-leader" aria-hidden="true" />
          <strong>{usd(commissionCost)}</strong>
        </div>
        <div className="ct-receipt-total">
          <span>Total toll</span>
          <span className="ct-leader" aria-hidden="true" />
          <strong>{usd(total)}</strong>
        </div>
        <div className="ct-receipt-stamp">
          <span>Break-even move</span>
          <strong>{moveCents.toFixed(2)}¢</strong>
          <span>{totalBps.toFixed(1)} bps</span>
        </div>
      </div>

      <div className="ct-controls">
        <Slider label="Share price" value={price} display={`$${price}`} min={5} max={400} step={1} onChange={setPrice} />
        <Slider label="Quoted spread" value={spread} display={`${spread.toFixed(1)}¢`} min={0.2} max={12} step={0.1} onChange={setSpread} />
        <Slider label="Shares" value={shares} display={amount(shares)} min={100} max={2000} step={100} onChange={setShares} />
        <Slider label="Slippage, round trip" value={slip} display={`${slip} bps`} min={0} max={30} step={1} onChange={setSlip} />
        <div className="ct-field">
          <span className="ct-field-label">Commission a share, each side</span>
          <div className="ct-seg" role="group" aria-label="Commission a share">
            {[0, 0.005, 0.01].map((option) => (
              <button
                key={option}
                type="button"
                className={`ct-seg-btn${commission === option ? ' is-on' : ''}`}
                aria-pressed={commission === option}
                onClick={() => setCommission(option)}
              >
                {option === 0 ? '$0' : `$${option.toFixed(3)}`}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- 02, the multiplier ---------- */

const PACES = [1, 3, 6, 12, 24];
const TOLLS = [2, 4, 8, 16];
const DEPLOYMENTS = [
  { value: 25, label: 'Quarter size' },
  { value: 50, label: 'Half size' },
  { value: 100, label: 'Full size' },
];

function TurnoverGrid() {
  const [toll, setToll] = useState(8);
  const [pace, setPace] = useState(12);
  const [deployed, setDeployed] = useState(100);

  const yearly = (tollBps: number, roundTrips: number) =>
    (tollBps * roundTrips * 252 * deployed) / 10000;
  const active = yearly(toll, pace);

  return (
    <div className="ct-grid-wrap">
      <div className="ct-grid" role="group" aria-label="Yearly cost by toll and pace">
        <span className="ct-grid-corner" aria-hidden="true" />
        {TOLLS.map((option) => (
          <span className="ct-grid-col" key={option}>{option} bps</span>
        ))}
        {PACES.map((roundTrips) => (
          <Fragment key={roundTrips}>
            <span className="ct-grid-row">{roundTrips} a day</span>
            {TOLLS.map((option) => {
              const value = yearly(option, roundTrips);
              const selected = option === toll && roundTrips === pace;
              return (
                <button
                  key={option}
                  type="button"
                  className={`ct-cell${selected ? ' is-selected' : ''}`}
                  aria-pressed={selected}
                  aria-label={`${option} basis points, ${roundTrips} round trips a day, ${rateText(value)} a year`}
                  onClick={() => {
                    setToll(option);
                    setPace(roundTrips);
                  }}
                >
                  <span
                    className="ct-cell-fill"
                    style={{ opacity: Math.min(0.32, Math.log10(value + 1) / 9) }}
                    aria-hidden="true"
                  />
                  <span className="ct-cell-value">{rateText(value)}</span>
                </button>
              );
            })}
          </Fragment>
        ))}
      </div>

      <p className="ct-readout">
        <strong>{rateText(active)}</strong> of the notional traded a year at {pace} round trips a day,
        {' '}{toll} bps each and {deployed}% of the account in each trade.
      </p>

      <div className="ct-field ct-field--inline">
        <span className="ct-field-label">Size of each trade</span>
        <div className="ct-seg" role="group" aria-label="Size of each trade">
          {DEPLOYMENTS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`ct-seg-btn${deployed === option.value ? ' is-on' : ''}`}
              aria-pressed={deployed === option.value}
              onClick={() => setDeployed(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <p className="ct-foot">252 sessions a year. The cost follows the notional traded, not the account size.</p>
    </div>
  );
}

/* ---------- 03, the clock ---------- */

const SESSIONS = 252;
const SESSION_MINUTES = 390;
const YEAR_MINUTES = SESSIONS * SESSION_MINUTES;
const CLOCK_PERIODS = [
  { label: '1 min', minutes: 1 },
  { label: '5 min', minutes: 5 },
  { label: '30 min', minutes: 30 },
  { label: '1 day', minutes: SESSION_MINUTES },
  { label: '1 week', minutes: SESSION_MINUTES * 5 },
  { label: '1 month', minutes: SESSION_MINUTES * 21 },
  { label: '1 year', minutes: YEAR_MINUTES },
];
const CLOCK_TICKS = [0.1, 1, 10, 100, 1000, 10000];
const CLOCK_FLOOR = 0.03;
const CLOCK_CEILING = 30000;

function clockPosition(value: number) {
  const span = Math.log10(CLOCK_CEILING) - Math.log10(CLOCK_FLOOR);
  return 2 + ((Math.log10(value) - Math.log10(CLOCK_FLOOR)) / span) * 82;
}

function CostClock() {
  const [toll, setToll] = useState(10);
  const [selected, setSelected] = useState(3);

  const annual = (minutes: number) => (toll / 10000) * (YEAR_MINUTES / minutes) * 100;
  const current = CLOCK_PERIODS[selected];

  return (
    <div className="ct-clock">
      <div className="ct-clock-head">
        <Slider label="Toll a round trip" value={toll} display={`${toll} bps`} min={2} max={30} step={1} onChange={setToll} />
      </div>

      <div className="ct-clock-plot">
        {CLOCK_TICKS.map((tick) => (
          <div className="ct-clock-line" key={tick} style={{ bottom: `${clockPosition(tick)}%` }}>
            <span>{rateText(tick)}</span>
          </div>
        ))}
        <div className="ct-clock-bars">
          {CLOCK_PERIODS.map((period, index) => {
            const value = annual(period.minutes);
            return (
              <button
                key={period.label}
                type="button"
                className={`ct-clock-col${index === selected ? ' is-selected' : ''}`}
                style={{ '--ct-bar': `${clockPosition(value)}%` } as CSSProperties}
                aria-pressed={index === selected}
                aria-label={`${period.label} holding time, ${rateText(value)} a year`}
                onClick={() => setSelected(index)}
              >
                <span className="ct-clock-value">{rateText(value)}</span>
                <span className="ct-clock-bar" aria-hidden="true" />
              </button>
            );
          })}
        </div>
      </div>

      <div className="ct-clock-labels" aria-hidden="true">
        {CLOCK_PERIODS.map((period) => (
          <span key={period.label}>{period.label}</span>
        ))}
      </div>

      <p className="ct-readout">
        At <strong>{current.label}</strong>, the toll is <strong>{rateText(annual(current.minutes))}</strong> of the account a year.
      </p>
      <p className="ct-foot">The capital goes back to work as soon as a trade closes, 252 sessions a year.</p>
    </div>
  );
}

/* ---------- 04, the record ---------- */

const RECORD = [
  { label: 'Quietest fifth', value: 18.5 },
  { label: 'Market', value: 17.9 },
  { label: 'Busiest fifth', value: 11.4, subject: true },
];

function TurnoverRecord() {
  const [open, setOpen] = useState(false);

  return (
    <div className="ct-record">
      <div
        className="ct-record-chart"
        role="img"
        aria-label="Net annual return, 1991 to 1996: quietest fifth 18.5%, market 17.9%, busiest fifth 11.4%"
      >
        {RECORD.map((row) => (
          <div className={`ct-record-row${row.subject ? ' is-subject' : ''}`} key={row.label}>
            <span className="ct-record-label">{row.label}</span>
            <span className="ct-record-track">
              <span className="ct-record-fill" style={{ width: `${(row.value / 18.5) * 100}%` }} />
            </span>
            <span className="ct-record-value">{row.value.toFixed(1)}%</span>
          </div>
        ))}
      </div>

      <p className="ct-record-note">Net annual return, 1991 to 1996. The market line is the value-weighted index the paper used.</p>

      <button
        type="button"
        className="ct-disclosure"
        aria-expanded={open}
        aria-controls="ct-record-finding"
        onClick={() => setOpen(!open)}
      >
        {open ? 'Close the finding' : 'Read the finding'}
      </button>

      {open && (
        <div className="ct-finding" id="ct-record-finding">
          <p><strong>Sample.</strong> 66,465 households at a large US discount broker, January 1991 to December 1996.</p>
          <p><strong>Round trip.</strong> About 4%, roughly 3% in commissions and 1% in spread.</p>
          <p><strong>Finding.</strong> Costs and frequency, not the stocks chosen, explained the gap.</p>
        </div>
      )}

      <p className="ct-source">
        Barber and Odean, “Trading Is Hazardous to Your Wealth”, <em>Journal of Finance</em> 55(2), 2000.{' '}
        <a
          href="https://faculty.haas.berkeley.edu/odean/Papers/returns/Individual_Investor_Performance_Final.pdf"
          target="_blank"
          rel="noreferrer"
        >
          Read the paper
        </a>
      </p>
    </div>
  );
}
