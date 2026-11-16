// Chart.tsx — Shared price/equity chart with toolbar and tooltip
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import Button from '../ui/Button'
import './Chart.css'

export interface Bar {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

interface ChartProps {
  bars: Bar[]
  ticker: string
  chartStyle?: 'candles' | 'line'
  defaultZoom?: number
  /** Open with the whole series on screen instead of the last DEFAULT_VISIBLE bars.
   *  The page uses it for an all-history range, so the range label is truthful. */
  showAll?: boolean
  /** Most bars that may be visible at once; Infinity removes the ceiling. */
  maxVisible?: number
  /** Render the ticker/price line inside the toolbar. Pages that show the
   *  quote themselves in a larger header pass false and keep the actions. */
  showQuote?: boolean
  /** Draw the volume strip. Price charts do; equity curves do not. */
  showVolume?: boolean
  /** Show the zoom / Latest toolbar. A fitted chart has nothing to control. */
  controls?: boolean
  /** Fit the whole series and turn off zoom and pan. Used by strategy runs. */
  fit?: boolean
  /** Drop the card chrome when the host panel already supplies it. */
  flat?: boolean
  /** Equity changes the tooltip from OHLC to one value and its daily move. */
  variant?: 'price' | 'equity'
  valueFormatter?: (value: number) => string
}

const AXIS_MIN_WIDTH = 54
const PADDING_TOP = 16
const PADDING_BOTTOM = 24
const VOLUME_RATIO = 0.18
const MIN_VISIBLE = 15
// Ceiling on how many candles can be on screen at once. Past this, the chart stops
// keeping up with the pointer, so older bars are reached by panning rather than by
// zooming the whole history out. The reader can raise it in Settings.
const DEFAULT_MAX_VISIBLE = 1500
const ZOOM_OPTIONS = [30, 60, 90] as const
const DEFAULT_VISIBLE = 90
const TOOLTIP_GAP = 12

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

// A restated price runs into the millions on a fund that reverse-split repeatedly, which
// an axis tick has no room for. Past five digits the label switches to a short suffix.
const priceLabel = (value: number) => {
  const abs = Math.abs(value)
  if (abs >= 1_000_000_000_000) return `${(value / 1_000_000_000_000).toFixed(1)}T`
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (abs >= 10_000) return `${(value / 1_000).toFixed(1)}K`
  return abs >= 1000 ? value.toFixed(0) : abs >= 10 ? value.toFixed(1) : value.toFixed(2)
}

const dateLabel = (iso: string) => {
  if (!iso) return ''
  const [y, m, d] = iso.split('-')
  if (!y || !m || !d) return iso
  return `${d}/${m}/${y.slice(2)}`
}

const volumeLabel = (value: number) => {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return `${value}`
}

/**
 * Candle + volume chart with wheel-zoom, click-drag panning, pinch zoom, and
 * a crosshair tooltip. The same interaction layer renders a fitted equity
 * line for strategy runs. All interaction state lives here so the page
 * itself only ever has to pass in a ticker and a list of bars.
 */
export default function Chart({
  bars,
  ticker,
  chartStyle = 'candles',
  defaultZoom,
  showAll = false,
  maxVisible = DEFAULT_MAX_VISIBLE,
  showQuote = true,
  showVolume = true,
  controls = true,
  fit = false,
  flat = false,
  variant = 'price',
  valueFormatter = priceLabel,
}: ChartProps) {
  // One number for every clamp below, whatever the setting resolves to.
  const ceiling = Math.max(MIN_VISIBLE, Math.min(bars.length || MIN_VISIBLE, maxVisible))
  const containerRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(360)
  const [height, setHeight] = useState(420)

  const preferred = useRef(defaultZoom && ZOOM_OPTIONS.includes(defaultZoom as 30 | 60 | 90) ? defaultZoom : DEFAULT_VISIBLE)
  const [visible, setVisibleState] = useState(() =>
    defaultZoom && ZOOM_OPTIONS.includes(defaultZoom as 30 | 60 | 90) ? defaultZoom : DEFAULT_VISIBLE
  )
  const setVisible = useCallback((next: number | ((current: number) => number)) => {
    setVisibleState((current) => {
      const value = typeof next === 'function' ? next(current) : next
      preferred.current = value
      return value
    })
  }, [])

  const [end, setEnd] = useState(bars.length)
  const [hover, setHover] = useState<{ index: number; x: number; y: number } | null>(null)
  // A tapped candle stays on screen until another tap or a tap outside. It is
  // stored by date, so panning or zooming keeps the same day under the
  // crosshair rather than the same slot.
  const [pinned, setPinned] = useState<{ ticker: string; date: string } | null>(null)

  useEffect(() => {
    if (bars.length === 0) return
    const wanted = fit
      ? Math.min(bars.length, ceiling)
      : showAll
        ? ceiling
        : clamp(preferred.current, MIN_VISIBLE, ceiling)
    preferred.current = wanted
    setVisibleState(wanted)
    setEnd(bars.length)
  }, [bars, showAll, fit, ceiling])

  useLayoutEffect(() => {
    const element = containerRef.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      const w = entry.contentRect.width
      setWidth(w)
      setHeight(w < 560 ? 360 : 440)
    })
    observer.observe(element)
    setWidth(element.clientWidth)
    setHeight(element.clientWidth < 560 ? 360 : 440)
    return () => observer.disconnect()
  }, [])

  const count = Math.min(visible, bars.length)
  const safeEnd = clamp(end, count, bars.length)
  const start = Math.max(0, safeEnd - count)
  const windowData = useMemo(() => bars.slice(start, safeEnd), [bars, start, safeEnd])

  const { min, max, maxVolume } = useMemo(() => {
    if (windowData.length === 0) return { min: 0, max: 1, maxVolume: 1 }
    let lo = Infinity
    let hi = -Infinity
    let vol = 0
    for (const bar of windowData) {
      lo = Math.min(lo, bar.low)
      hi = Math.max(hi, bar.high)
      vol = Math.max(vol, bar.volume)
    }
    const pad = (hi - lo) * 0.06 || 1
    // A price cannot go below zero, so a penny stock's padding stops at the floor
    // instead of drawing a negative tick under the axis.
    const floor = lo >= 0 ? Math.max(0, lo - pad) : lo - pad
    return { min: floor, max: hi + pad, maxVolume: vol || 1 }
  }, [windowData])

  const gridLines = useMemo(() => {
    const steps = 4
    return Array.from({ length: steps + 1 }, (_, i) => min + ((max - min) * i) / steps)
  }, [min, max])

  // A fixed axis width clipped long prices at the right edge. Measure the
  // longest formatted tick and reserve enough room for it, with a sensible
  // floor so ordinary labels stay on the same rhythm.
  const axisWidth = useMemo(() => {
    const longest = gridLines.reduce((longestLabel, value) => {
      return Math.max(longestLabel, valueFormatter(value).length)
    }, 4)
    return Math.max(AXIS_MIN_WIDTH, longest * 7 + 12)
  }, [gridLines, valueFormatter])

  const plotWidth = Math.max(100, width - axisWidth)
  const plotHeight = height - PADDING_TOP - PADDING_BOTTOM
  const volumeHeight = showVolume ? Math.round(plotHeight * VOLUME_RATIO) : 0
  const priceHeight = plotHeight - volumeHeight - (showVolume ? 10 : 0)
  const volumeTop = PADDING_TOP + priceHeight + (showVolume ? 10 : 0)
  const slot = plotWidth / Math.max(1, windowData.length)
  const candleWidth = Math.max(1, Math.min(14, slot * 0.66))

  const yPrice = useCallback(
    (value: number) => PADDING_TOP + ((max - value) / (max - min)) * priceHeight,
    [max, min, priceHeight]
  )
  const yVolume = useCallback(
    (value: number) => volumeTop + volumeHeight - (value / maxVolume) * volumeHeight,
    [volumeTop, volumeHeight, maxVolume]
  )

  const dateTicks = useMemo(() => {
    if (windowData.length === 0) return []
    const target = Math.max(3, Math.floor(plotWidth / (width < 560 ? 74 : 120)))
    const lastIndex = windowData.length - 1
    const steps = Math.max(1, Math.min(target - 1, lastIndex))
    const ticks: { index: number; label: string; x: number }[] = []
    for (let i = 0; i <= steps; i += 1) {
      const index = Math.round((i / steps) * lastIndex)
      const label = dateLabel(windowData[index]!.date)
      const margin = label.length * 3.6
      ticks.push({
        index,
        label,
        // The first and last ticks sit half off the plot, so their labels are held
        // inside the frame instead of being cut in half at the edge.
        x: clamp(index * slot + slot / 2, margin, Math.max(margin, plotWidth - margin)),
      })
    }
    return ticks
  }, [windowData, plotWidth, width, slot])

  // Built once per view, not once per hover: a full window is thousands of SVG nodes,
  // and rebuilding them on every pointer move is what made the crosshair stutter.
  const priceSeries = useMemo(() => {
    if (chartStyle === 'line') {
      const points = windowData
        .map((bar, index) => `${(index * slot + slot / 2).toFixed(1)},${yPrice(bar.close).toFixed(1)}`)
        .join(' ')
      return (
        <g>
          {variant === 'equity' && (
            <polygon
              points={`0,${PADDING_TOP + priceHeight} ${points} ${plotWidth},${PADDING_TOP + priceHeight}`}
              className="chart-equity-area"
            />
          )}
          <polyline points={points} className="chart-line" fill="none" />
          {showVolume &&
            windowData.map((bar, index) => (
              <g key={bar.date || index} className={bar.close >= bar.open ? 'candle-up' : 'candle-down'}>
                <rect
                  x={index * slot + slot / 2 - candleWidth / 2}
                  y={yVolume(bar.volume)}
                  width={candleWidth}
                  height={Math.max(1, volumeTop + volumeHeight - yVolume(bar.volume))}
                  className="candle-volume"
                />
              </g>
            ))}
        </g>
      )
    }

    return windowData.map((bar, index) => {
      const cx = index * slot + slot / 2
      const up = bar.close >= bar.open
      const top = yPrice(Math.max(bar.open, bar.close))
      const bottom = yPrice(Math.min(bar.open, bar.close))

      return (
        <g key={bar.date || index} className={up ? 'candle-up' : 'candle-down'}>
          <line x1={cx} x2={cx} y1={yPrice(bar.high)} y2={yPrice(bar.low)} className="candle-wick" />
          <rect x={cx - candleWidth / 2} y={top} width={candleWidth} height={Math.max(1, bottom - top)} className="candle-body" />
          {showVolume && (
            <rect
              x={cx - candleWidth / 2}
              y={yVolume(bar.volume)}
              width={candleWidth}
              height={Math.max(1, volumeTop + volumeHeight - yVolume(bar.volume))}
              className="candle-volume"
            />
          )}
        </g>
      )
    })
  }, [chartStyle, variant, windowData, slot, candleWidth, yPrice, yVolume, volumeTop, volumeHeight, showVolume, plotWidth, priceHeight])

  const stateRef = useRef({ count, safeEnd, total: bars.length, slot, ceiling, fit })
  useLayoutEffect(() => {
    stateRef.current = { count, safeEnd, total: bars.length, slot, ceiling, fit }
  })

  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    const onWheel = (event: WheelEvent) => {
      if (fit) return
      event.preventDefault()
      const s = stateRef.current
      const factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1
      const dx = event.deltaX * factor
      const dy = event.deltaY * factor
      if (event.ctrlKey || Math.abs(dx) < Math.abs(dy)) {
        const next = clamp(Math.round(s.count * Math.exp(dy * 0.0018)), MIN_VISIBLE, s.ceiling)
        setVisible(next)
        setEnd((e) => clamp(e, next, s.total))
      } else {
        const barsMoved = dx / Math.max(1, s.slot)
        setEnd((e) => clamp(Math.round(e + barsMoved), s.count, s.total))
      }
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [fit, setVisible])

  const dragRef = useRef<{ x: number; end: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  // A finger that has not travelled yet is a tap; once it moves it is a pan.
  // Showing the candle on contact is what used to freeze the chart under a
  // thumb, so the tooltip waits for the finger to lift.
  const touchRef = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const pointersRef = useRef(new Map<number, { x: number; y: number }>())
  const pinchRef = useRef<{ distance: number; count: number; end: number } | null>(null)

  const pinchDistance = () => {
    const points = [...pointersRef.current.values()]
    if (points.length < 2) return 0
    return Math.hypot(points[0]!.x - points[1]!.x, points[0]!.y - points[1]!.y)
  }

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'touch') {
      pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (!fit && pointersRef.current.size === 2) {
        pinchRef.current = {
          distance: pinchDistance(),
          count,
          end: safeEnd,
        }
        dragRef.current = null
        touchRef.current = null
        setDragging(false)
        setHover(null)
        setPinned(null)
        return
      }
      if (pinchRef.current) return
      touchRef.current = { x: event.clientX, y: event.clientY, moved: false }
      setHover(null)
      setPinned(null)
    }

    if (fit) return
    dragRef.current = { x: event.clientX, end: safeEnd }
    setDragging(true)
    // Deliberately no setPointerCapture: in iOS Safari a captured pointer
    // keeps the gesture away from the page, which is why a vertical swipe
    // over the chart did nothing. Without it the browser can claim the swipe
    // and scroll, while horizontal drags still reach these handlers.
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const px = event.clientX - rect.left
    const py = event.clientY - rect.top
    const drag = dragRef.current
    const touch = touchRef.current

    if (event.pointerType === 'touch') {
      if (pointersRef.current.has(event.pointerId)) {
        pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
      }

      if (pinchRef.current) {
        const distance = pinchDistance()
        if (distance > 0) {
          const pinch = pinchRef.current
          const next = clamp(Math.round(pinch.count * (pinch.distance / distance)), MIN_VISIBLE, ceiling)
          setVisible(next)
          setEnd(clamp(pinch.end, next, bars.length))
        }
        return
      }

      if (touch && !touch.moved) {
        if (Math.abs(event.clientX - touch.x) > 6 || Math.abs(event.clientY - touch.y) > 6) {
          touch.moved = true
        }
      }

      if (fit) return
      if (drag) {
        // The first few pixels of a touch stay still, so a swipe pans cleanly
        // instead of nudging the window before it is recognised as a drag.
        if (touch && !touch.moved) return
        const moved = (drag.x - event.clientX) / Math.max(1, slot)
        setEnd(clamp(Math.round(drag.end + moved), count, bars.length))
        setHover(null)
      }
      return
    }

    if (drag) {
      const moved = (drag.x - event.clientX) / Math.max(1, slot)
      setEnd(clamp(Math.round(drag.end + moved), count, bars.length))
      return
    }

    if (px > plotWidth || windowData.length === 0) {
      setHover(null)
      return
    }
    const index = clamp(Math.floor(px / slot), 0, windowData.length - 1)
    setHover({ index, x: index * slot + slot / 2, y: py })
  }

  const endDrag = () => {
    dragRef.current = null
    setDragging(false)
  }

  const clearPointers = () => {
    pointersRef.current.clear()
    pinchRef.current = null
    touchRef.current = null
    endDrag()
  }

  // A tap is only a candle hit when the finger is on the body or wick. A tap
  // in the empty plot clears the tooltip instead of snapping to the nearest
  // bar, which is what made the stock chart feel almost right.
  const indexAt = (px: number, py: number) => {
    if (windowData.length === 0 || px > plotWidth) return null
    const index = clamp(Math.floor(px / slot), 0, windowData.length - 1)
    const bar = windowData[index]
    if (!bar) return null
    const cx = index * slot + slot / 2
    if (Math.abs(px - cx) > Math.max(6, candleWidth / 2 + 3)) return null
    if (chartStyle === 'line') {
      return Math.abs(py - yPrice(bar.close)) <= 14 ? index : null
    }
    return py >= yPrice(bar.high) - 5 && py <= yPrice(bar.low) + 5 ? index : null
  }

  // Lifting a finger that never travelled is the tap: pin that candle, or
  // dismiss the tooltip when the plot was empty.
  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'touch') {
      pointersRef.current.delete(event.pointerId)
      if (pinchRef.current) {
        if (pointersRef.current.size < 2) {
          pinchRef.current = null
          touchRef.current = null
          endDrag()
        }
        return
      }
    }

    const touch = touchRef.current
    touchRef.current = null
    if (touch && !touch.moved) {
      const rect = event.currentTarget.getBoundingClientRect()
      const index = indexAt(event.clientX - rect.left, event.clientY - rect.top)
      setPinned(index === null ? null : { ticker, date: windowData[index]!.date })
      if (index === null) setHover(null)
    }
    endDrag()
  }

  const cancelPoint = () => {
    clearPointers()
    setHover(null)
  }

  // A pin outside the current window simply hides the tooltip; sliding back
  // to it brings the same day back under the crosshair. The ticker is part of
  // the pin, so a new symbol never inherits the old symbol's date.
  const pinnedIndex =
    pinned && pinned.ticker === ticker
      ? windowData.findIndex((bar) => bar.date === pinned.date)
      : -1
  const hoverIndex = hover && hover.index < windowData.length ? hover.index : null
  const activeIndex = hoverIndex ?? (pinnedIndex >= 0 ? pinnedIndex : null)
  const activeBar = activeIndex !== null ? windowData[activeIndex] : undefined
  // An equity curve's two anchors, so a tooltip can say where the run started
  // and where it finished without the reader hunting for the ends.
  const equityStart = bars.length > 0 ? bars[0].close : 0
  const equityEnd = bars.length > 0 ? bars[bars.length - 1].close : 0
  const isTouch =
    typeof window !== 'undefined' &&
    window.matchMedia('(pointer: coarse), (max-width: 47.999rem)').matches
  const activeX = activeIndex !== null ? activeIndex * slot + slot / 2 : 0
  const activeY = activeBar ? yPrice(activeBar.close) : 0

  // A tap anywhere outside the plot (the toolbar, the page, another card)
  // closes the pinned candle, which is the gesture readers expect.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const plot = containerRef.current
      if (plot && !plot.contains(event.target as Node)) setPinned(null)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [])

  const atLatest = safeEnd >= bars.length
  const first = bars[0]
  const last = bars[bars.length - 1]
  const change = first && last ? last.close - first.close : 0
  const changePct = first && last && first.close !== 0 ? (change / first.close) * 100 : 0

  const tooltipWidth = Math.min(168, Math.max(136, plotWidth * 0.46))
  const tooltipHeight = variant === 'equity' ? 124 : 160
  const maxTop = Math.max(8, height - PADDING_BOTTOM - tooltipHeight - 8)
  const spaceRight = plotWidth - activeX - TOOLTIP_GAP
  const spaceLeft = activeX - TOOLTIP_GAP
  // On a phone neither side can hold the tooltip. Put it above or below the
  // active point instead, so the candle being read is never underneath it.
  let tooltipLeft: number
  let tooltipTop: number
  if (spaceRight >= tooltipWidth) {
    tooltipLeft = activeX + TOOLTIP_GAP
    tooltipTop = clamp(activeY - tooltipHeight / 2, 8, maxTop)
  } else if (spaceLeft >= tooltipWidth) {
    tooltipLeft = activeX - TOOLTIP_GAP - tooltipWidth
    tooltipTop = clamp(activeY - tooltipHeight / 2, 8, maxTop)
  } else {
    tooltipLeft = clamp(activeX - tooltipWidth / 2, 8, Math.max(8, plotWidth - tooltipWidth - 8))
    const above = activeY - tooltipHeight - TOOLTIP_GAP
    tooltipTop = above >= 8 ? above : clamp(activeY + TOOLTIP_GAP, 8, maxTop)
  }

  const detailTarget = chartStyle === 'line' ? 'point' : 'candle'
  const hint = variant === 'equity'
    ? isTouch
      ? `Tap a ${detailTarget} for the value. Tap empty space to dismiss.`
      : `Hover a ${detailTarget} for that session’s value.`
    : isTouch
      ? `Swipe to move, pinch or use +/− to zoom. Tap a ${detailTarget} for detail; tap empty space to dismiss.`
      : `Scroll to zoom, drag to pan, hover a ${detailTarget} for detail${showVolume ? ' and volume' : ''}.`

  return (
    <div className={`chart-card${flat ? ' is-flat' : ''}`}>
      {controls && (
        <div className={`chart-toolbar${showQuote ? '' : ' is-actions-only'}`}>
          {showQuote && (
            <div className="chart-toolbar-info">
              <span className="chart-ticker">{ticker}</span>
              {last && (
                <span className="chart-last-price">
                  ${priceLabel(last.close)}
                  <span className={`chart-change ${change >= 0 ? 'is-up' : 'is-down'}`}>
                    {change >= 0 ? '+' : ''}
                    {change.toFixed(2)} ({changePct >= 0 ? '+' : ''}
                    {changePct.toFixed(2)}%)
                  </span>
                </span>
              )}
            </div>
          )}
          <div className="chart-toolbar-actions">
            <span className="chart-bars-count">{windowData.length} bars visible</span>
            <div className="chart-zoom-group">
              <button
                type="button"
                aria-label="Zoom out"
                className="chart-zoom-btn"
                onClick={() => setVisible((v) => clamp(Math.round(v * 1.3), MIN_VISIBLE, ceiling))}
              >
                −
              </button>
              <button
                type="button"
                aria-label="Zoom in"
                className="chart-zoom-btn"
                onClick={() => setVisible((v) => clamp(Math.round(v / 1.3), MIN_VISIBLE, bars.length))}
              >
                +
              </button>
            </div>
            <Button variant="secondary" size="sm" onClick={() => setEnd(bars.length)} disabled={atLatest}>
              Latest
            </Button>
          </div>
        </div>
      )}

      <div className="chart-plot-frame">
        <div
          ref={containerRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={cancelPoint}
          onPointerLeave={(event) => {
            if (event.pointerType !== 'touch') {
              touchRef.current = null
              endDrag()
              setHover(null)
            }
          }}
          className="chart-plot-area"
          style={{ height, cursor: fit ? 'default' : dragging ? 'grabbing' : 'crosshair' }}
        >
          <svg width={width} height={height}>
            {gridLines.map((value) => (
              <g key={value}>
                <line x1={0} x2={plotWidth} y1={yPrice(value)} y2={yPrice(value)} className="chart-grid-line" />
                <text x={plotWidth + 8} y={yPrice(value) + 4} className="chart-axis-label">
                  {valueFormatter(value)}
                </text>
              </g>
            ))}

            {priceSeries}

            {dateTicks.map((tick) => (
              <text
                key={`${tick.index}-${tick.label}`}
                x={tick.x}
                y={height - 6}
                textAnchor="middle"
                className="chart-axis-label"
              >
                {tick.label}
              </text>
            ))}

            {activeBar && (
              <g pointerEvents="none">
                <line x1={activeX} x2={activeX} y1={PADDING_TOP} y2={height - PADDING_BOTTOM} className="chart-crosshair" />
                <line x1={0} x2={plotWidth} y1={activeY} y2={activeY} className="chart-crosshair" />
              </g>
            )}
          </svg>

          {activeBar && (
            <div
              className="chart-tooltip"
              style={{
                left: clamp(tooltipLeft, 8, Math.max(8, plotWidth - tooltipWidth - 8)),
                top: tooltipTop,
                width: tooltipWidth,
              }}
            >
              <p className="chart-tooltip-date">{activeBar.date}</p>
              {variant === 'equity' ? (
                <dl className="chart-tooltip-grid">
                  <dt>Value</dt>
                  <dd>{valueFormatter(activeBar.close)}</dd>
                  <dt>Start</dt>
                  <dd>{valueFormatter(equityStart)}</dd>
                  <dt>End</dt>
                  <dd>{valueFormatter(equityEnd)}</dd>
                  <dt>Day</dt>
                  <dd className={activeBar.close >= activeBar.open ? 'is-up' : 'is-down'}>
                    {activeBar.open !== 0
                      ? `${activeBar.close >= activeBar.open ? '+' : ''}${(((activeBar.close - activeBar.open) / activeBar.open) * 100).toFixed(2)}%`
                      : '—'}
                  </dd>
                </dl>
              ) : (
                <dl className="chart-tooltip-grid">
                  <dt>Open</dt>
                  <dd>${valueFormatter(activeBar.open)}</dd>
                  <dt>High</dt>
                  <dd className="is-up">${valueFormatter(activeBar.high)}</dd>
                  <dt>Low</dt>
                  <dd className="is-down">${valueFormatter(activeBar.low)}</dd>
                  <dt>Close</dt>
                  <dd className={activeBar.close >= activeBar.open ? 'is-up' : 'is-down'}>
                    ${valueFormatter(activeBar.close)}
                  </dd>
                  {showVolume && (
                    <>
                      <dt>Volume</dt>
                      <dd>{volumeLabel(activeBar.volume)}</dd>
                    </>
                  )}
                </dl>
              )}
            </div>
          )}
        </div>
      </div>

      <p className="chart-hint">{hint}</p>
    </div>
  )
}
