// BenchPage.tsx — hidden timing terminal at #/bench.
//
// Runs Python in the same worker, same interpreter and same mounted OPFS
// market cache the rest of the app uses, so nothing is downloaded again: the
// bars the sync already wrote are what these numbers are measured against.
// Not linked from anywhere; the hash is the only way in.
import { useCallback, useRef, useState, type KeyboardEvent } from 'react'
import { runPython, useEngineStatus } from '../store/pyodide'

const DEFAULT_SCRIPT = `import json, time
from sltp.data import market_data_service as service

# 1. What this device is working with. Two phones with different universes are
#    not running the same backtest, whatever the code says.
t = time.perf_counter()
universe = service.get_all_tickers()
print("universe:", len(universe), "in", round(time.perf_counter() - t, 2), "s")

# 2. Pure interpreter speed, no data and no numpy: the baseline the engine
#    numbers should be read against.
t = time.perf_counter()
s = 0.0
for i in range(3_000_000):
    s += i * 0.5
print("cpu probe 3e6:", round(time.perf_counter() - t, 3), "s")

# 3. One real run, with the worker's own timings beside the wall clock.
t = time.perf_counter()
out = json.loads(run_strategy("adaptive-momentum", "2022-01-01", None))
print("adaptive-momentum wall:", round(time.perf_counter() - t, 2), "s")
print("timings:", out.get("timings"))
print("sessions:", len(out.get("equity") or []), "trades:", len(out.get("trades") or []))
out = None
`

export function BenchPage() {
  const status = useEngineStatus()
  const [code, setCode] = useState(DEFAULT_SCRIPT)
  const [output, setOutput] = useState('')
  const [running, setRunning] = useState(false)
  const startedRef = useRef(0)

  const run = useCallback(async () => {
    if (running) return
    setRunning(true)
    setOutput(status.phase === 'ready' ? 'Running…' : 'Booting Python, then running…')
    startedRef.current = performance.now()
    try {
      const text = await runPython(code)
      const wall = ((performance.now() - startedRef.current) / 1000).toFixed(2)
      let body = text
      try {
        const parsed = JSON.parse(text) as { ok?: boolean; stdout?: string; error?: string }
        body = [parsed.stdout ?? '', parsed.error ?? ''].filter(Boolean).join('\n')
        if (!parsed.ok && !parsed.stdout) body = parsed.error ?? 'failed'
      } catch {
        /* the worker answered with something other than its JSON envelope */
      }
      setOutput(`${body}\n\n[worker round trip ${wall}s]`)
    } catch (error) {
      setOutput(error instanceof Error ? error.message : String(error))
    } finally {
      setRunning(false)
    }
  }, [code, running, status.phase])

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      void run()
    }
  }

  return (
    <div style={{ padding: '1.25rem', maxWidth: '56rem', margin: '0 auto' }}>
      <h1 style={{ fontSize: '1.25rem', margin: '0 0 0.25rem' }}>Bench</h1>
      <p style={{ color: 'var(--text-secondary)', margin: '0 0 1rem', fontSize: '0.9375rem' }}>
        Python against the cached market data. Engine: {status.phase}
        {status.detail ? ` — ${status.detail}` : ''}
      </p>

      <textarea
        value={code}
        onChange={(event) => setCode(event.target.value)}
        onKeyDown={onKeyDown}
        spellCheck={false}
        rows={18}
        style={{
          width: '100%',
          boxSizing: 'border-box',
          padding: '0.75rem',
          fontFamily: 'var(--font-mono)',
          fontSize: '0.8125rem',
          lineHeight: 1.5,
          color: 'var(--text-strong)',
          background: 'var(--bg-surface)',
          border: '1px solid var(--border-subtle)',
          borderRadius: '0.5rem',
          resize: 'vertical',
        }}
      />

      <div style={{ display: 'flex', gap: '0.5rem', margin: '0.75rem 0 1rem' }}>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => void run()} disabled={running}>
          {running ? 'Running…' : 'Run  (⌘⏎)'}
        </button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOutput('')}>
          Clear output
        </button>
      </div>

      <pre
        style={{
          margin: 0,
          padding: '0.75rem',
          minHeight: '4rem',
          fontFamily: 'var(--font-mono)',
          fontSize: '0.8125rem',
          lineHeight: 1.5,
          color: 'var(--text-strong)',
          background: 'var(--bg-canvas)',
          border: '1px solid var(--border-subtle)',
          borderRadius: '0.5rem',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {output}
      </pre>
    </div>
  )
}

export default BenchPage
