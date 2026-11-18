// LevelSwitcher.tsx — Text tabs, a lock for unopened levels, and Continue.

import { useEffect, useRef, type RefObject } from 'react';
import { LockKeyhole } from 'lucide-react';
import { LEVELS } from '../../learn/curriculum';
import type { LearnProgress } from '../../learn/progress';

interface LevelSwitcherProps {
  activeId: string;
  progress: LearnProgress;
  counts: (level: (typeof LEVELS)[number]) => { done: number; total: number };
  onSelect: (id: string) => void;
  onContinue?: () => void;
  continueLabel?: string;
  innerRef?: RefObject<HTMLDivElement | null>;
}

export function LevelSwitcher({
  activeId,
  progress,
  counts,
  onSelect,
  onContinue,
  continueLabel,
  innerRef,
}: LevelSwitcherProps) {
  const tabsRef = useRef<HTMLDivElement>(null);

  // The bar scrolls sideways, and on a phone the level the reader picked can
  // land past its right edge: the page changed under a tab they could not see.
  // Bring the active tab to the middle of the bar. The ends need no special
  // case — the first tab has nothing to its left and the last has nothing to
  // its right, so the clamp leaves those two where they are.
  useEffect(() => {
    const centre = () => {
      const list = tabsRef.current;
      const tab = list?.querySelector<HTMLElement>('[aria-selected="true"]');
      if (!list || !tab || list.clientWidth === 0) return;
      const listBox = list.getBoundingClientRect();
      const tabBox = tab.getBoundingClientRect();
      const tabLeft = tabBox.left - listBox.left + list.scrollLeft;
      const wanted = tabLeft - (list.clientWidth - tabBox.width) / 2;
      const max = Math.max(0, list.scrollWidth - list.clientWidth);
      const left = Math.min(Math.max(0, wanted), max);
      if (Math.abs(list.scrollLeft - left) < 1) return;
      const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      list.scrollTo({ left, behavior: still ? 'auto' : 'smooth' });
    };
    centre();
    // The first run can land before the bar has its final width (the fonts and
    // the Continue button both change it). One frame later the numbers hold.
    const frame = requestAnimationFrame(centre);
    return () => cancelAnimationFrame(frame);
  }, [activeId]);

  return (
    <div className="learn-switcher-shell" ref={innerRef}>
      <div className="learn-switcher">
        <div className="learn-switcher-tabs" role="tablist" aria-label="Course levels" ref={tabsRef}>
          {LEVELS.map((level, index) => {
            const count = counts(level);
            const previousOpen = index === 0 || progress.certifications.includes(LEVELS[index - 1].id);
            const locked = level.status === 'outline' || !previousOpen;
            return (
              <button
                key={level.id}
                type="button"
                role="tab"
                aria-selected={activeId === level.id}
                className={`learn-switcher-tab ${activeId === level.id ? 'is-active' : ''}`}
                onClick={() => onSelect(level.id)}
              >
                <span>{level.name}</span>
                <span className="learn-switcher-count">
                  {count.done}/{count.total}
                  {locked && <LockKeyhole size={13} aria-label="Locked" />}
                </span>
              </button>
            );
          })}
          <button
            type="button"
            role="tab"
            aria-selected={activeId === 'workshops'}
            className={`learn-switcher-tab ${activeId === 'workshops' ? 'is-active' : ''}`}
            onClick={() => onSelect('workshops')}
          >
            <span>Workshops</span>
            <span className="learn-switcher-count">
              Planned
              <LockKeyhole size={13} aria-label="Planned" />
            </span>
          </button>
        </div>
        {onContinue && continueLabel && (
          <button type="button" className="learn-continue" onClick={onContinue}>
            {continueLabel}
          </button>
        )}
      </div>
    </div>
  );
}
