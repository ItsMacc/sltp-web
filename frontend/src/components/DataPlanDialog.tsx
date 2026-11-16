// DataPlanDialog.tsx — the confirmation step for changing a phone's market
// data plan. It states what the switch costs in disk and in data before a byte
// moves, then applies it: bars outside the new window are deleted, bars inside
// it are fetched, and the page reloads so every range button matches the plan.

import { useEffect, useState } from 'react';
import { AlertTriangle, Database, HardDriveDownload, Trash2, X } from 'lucide-react';
import Button from '../ui/Button';
import { applyDataPlan, previewDataPlan, useMarketSyncStatus, type DataPlanPreview } from '../store/sync';
import type { DataPlanYears } from '../store/device';
import './DataPlanDialog.css';

interface DataPlanDialogProps {
  years: DataPlanYears;
  currentYears: DataPlanYears;
  onClose: () => void;
}

const mb = (bytes: number): string =>
  bytes >= 1_000_000_000
    ? `${(bytes / 1_000_000_000).toFixed(1)} GB`
    : `${Math.round(bytes / 1_000_000)} MB`;

export default function DataPlanDialog({ years, currentYears, onClose }: DataPlanDialogProps) {
  const [preview, setPreview] = useState<DataPlanPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const sync = useMarketSyncStatus();

  useEffect(() => {
    let cancelled = false;
    previewDataPlan(years)
      .then((next) => {
        if (!cancelled) setPreview(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not read the data plan.');
      });
    return () => {
      cancelled = true;
    };
  }, [years]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !applying) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, applying]);

  const confirm = async () => {
    setApplying(true);
    setError(null);
    try {
      await applyDataPlan(years);
      // The timeframe buttons and the date floor are built once per page, so a
      // reload is what makes the new window real everywhere.
      window.location.reload();
    } catch (err) {
      setApplying(false);
      setError(err instanceof Error ? err.message : 'The plan could not be changed.');
    }
  };

  const shrinking = years < currentYears;
  const addText = preview ? `${preview.add.length} files · ${mb(preview.addBytes)}` : 'Reading the manifest…';
  const removeText = preview ? `${preview.remove.length} files · ${mb(preview.removeBytes)}` : 'Reading the manifest…';
  const keepText = preview ? mb(preview.keepBytes) : '—';

  return (
    <div
      className="data-plan-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !applying) onClose();
      }}
    >
      <div className="data-plan" role="dialog" aria-modal="true" aria-labelledby="data-plan-title">
        <header className="data-plan-head">
          <span className="data-plan-icon" aria-hidden="true">
            <Database size={16} />
          </span>
          <div>
            <h2 id="data-plan-title" className="data-plan-title">
              {years}-year data plan
            </h2>
            <p className="data-plan-sub">
              This changes the market history stored on this phone. It does not change your
              account, and your laptop keeps its own plan.
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close"
            onClick={onClose}
            disabled={applying}
          >
            <X size={16} aria-hidden="true" />
          </Button>
        </header>

        <div className="data-plan-body">
          <dl className="data-plan-facts">
            <div>
              <dt>
                <HardDriveDownload size={14} aria-hidden="true" /> Downloads
              </dt>
              <dd>{addText}</dd>
            </div>
            <div>
              <dt>
                <Trash2 size={14} aria-hidden="true" /> Frees on this phone
              </dt>
              <dd>{removeText}</dd>
            </div>
            <div>
              <dt>Keeps already stored</dt>
              <dd>{keepText}</dd>
            </div>
          </dl>

          {shrinking ? (
            <p className="data-plan-note">
              Older years are deleted from this phone. Nothing is lost from the dataset: the
              files are still published, and setting a longer plan later downloads them again.
              A chart or a backtest that starts before the new window will no longer find data
              here.
            </p>
          ) : (
            <p className="data-plan-note">
              The extra years download once and stay on this phone. Charts, date pickers and
              backtests can then reach {years} years back instead of {currentYears}.
            </p>
          )}

          <div className="data-plan-risk">
            <AlertTriangle size={15} aria-hidden="true" />
            <p>
              {years} years of bars on this phone is about {mb((preview?.keepBytes ?? 0) + (preview?.addBytes ?? 0))}{' '}
              on disk, against {mb(preview?.keepBytes ?? 0)} now. The first switch downloads the
              difference over your connection. Long drags across a decade of candles are heavier
              on an older phone, and if the browser starts evicting storage, charts fall back to
              fetching a file at a time.
            </p>
          </div>

          {error && (
            <p className="data-plan-error" role="alert">
              {error}
            </p>
          )}
          {applying && (
            <p className="data-plan-progress" role="status">
              {sync.phase === 'priority'
                ? 'Downloading the files a chart needs first…'
                : sync.phase === 'prefetch'
                  ? 'Downloading the rest of the window…'
                  : sync.phase === 'checking'
                    ? 'Reading the manifest…'
                    : 'Preparing this phone…'}
            </p>
          )}
          {applying && sync.totalFiles > 0 && (
            <p className="data-plan-progress-sub">
              {sync.loadedFiles.length} of {sync.totalFiles} history files
            </p>
          )}
        </div>

        <footer className="data-plan-foot">
          <Button variant="secondary" size="md" onClick={onClose} disabled={applying}>
            Keep {currentYears} years
          </Button>
          <Button variant="primary" size="md" onClick={() => void confirm()} disabled={applying}>
            {applying ? 'Applying…' : shrinking ? 'Delete and switch' : 'Download and switch'}
          </Button>
        </footer>
      </div>
    </div>
  );
}
