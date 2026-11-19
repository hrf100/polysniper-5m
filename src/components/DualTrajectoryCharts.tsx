import React, { useId, useState } from 'react';
import type { ChartPoint, OrderbookSnapshot, SniperMetrics } from '../types/sniper';

interface DualTrajectoryChartsProps {
  chartSeries: ChartPoint[];
  strikePrice: number;
  alignedSpotPrice: number;
  orderbook: OrderbookSnapshot;
  sniperMetrics: SniperMetrics | null;
  maxEntryCents: number;
  simVirtualBankroll: number;
}

function formatUsdPrice(price: number): string {
  return `$${price.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatUsdDelta(delta: number): string {
  const sign = delta >= 0 ? '+' : '-';
  return `${sign}$${Math.abs(delta).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export const DualTrajectoryCharts: React.FC<DualTrajectoryChartsProps> = ({
  chartSeries,
  strikePrice,
  alignedSpotPrice,
  orderbook,
  sniperMetrics,
  maxEntryCents,
  simVirtualBankroll,
}) => {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const glowId = useId();
  const goldenGradId = useId();

  const width = 580;
  const height = 248;
  const padLeft = 54;
  const padRight = 18;
  const padTop = 34;
  const padBottom = 26;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const toX = (sec: number) => padLeft + (Math.max(0, Math.min(300, sec)) / 300) * plotW;

  const latestPoint = chartSeries.length > 0 ? chartSeries[chartSeries.length - 1] : null;
  const hoveredPoint =
    hoverIdx !== null && hoverIdx >= 0 && hoverIdx < chartSeries.length
      ? chartSeries[hoverIdx]
      : null;

  // Single source of truth for aligned price, strike, and delta (exact match with blue curve endpoint)
  const displayStrike = latestPoint ? latestPoint.strike : strikePrice;
  const displayAlignedPrice = latestPoint ? latestPoint.spot : alignedSpotPrice;
  const roundedStrike = Math.round(displayStrike * 100) / 100;
  const roundedAlignedPrice = Math.round(displayAlignedPrice * 100) / 100;
  const displayDelta =
    displayStrike > 0 && displayAlignedPrice > 0
      ? Number((roundedAlignedPrice - roundedStrike).toFixed(2))
      : null;

  const atr1m = sniperMetrics ? sniperMetrics.atr1m : null;
  const normalizedGapR = sniperMetrics ? sniperMetrics.normalizedGapR : null;
  const remainSec = sniperMetrics?.remainSec ?? 0;
  const inGoldenWindow = remainSec >= 70 && remainSec <= 240;

  const upOdds = (100 / Math.max(0.1, orderbook.upAsk)).toFixed(1);
  const downOdds = (100 / Math.max(0.1, orderbook.downAsk)).toFixed(1);
  const upTriggered = orderbook.upAsk <= maxEntryCents;
  const downTriggered = orderbook.downAsk <= maxEntryCents;

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (chartSeries.length < 1) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / rect.width) * width;
    const sec = ((relX - padLeft) / plotW) * 300;
    let closest = 0;
    let bestDist = Infinity;
    for (let i = 0; i < chartSeries.length; i++) {
      const d = Math.abs(chartSeries[i].elapsedSec - sec);
      if (d < bestDist) {
        bestDist = d;
        closest = i;
      }
    }
    setHoverIdx(closest);
  };

  const renderPriceSvg = () => {
    if (chartSeries.length === 0) {
      return (
        <div className="h-[248px] flex flex-col items-center justify-center bg-[#070B12] rounded-lg border border-slate-800/80 text-xs text-slate-500">
          <span>正在收集当前 5m 盘口实时价格轨迹...</span>
          <span className="mt-1 text-[11px] text-slate-600">
            收到首帧实盘行情后自动绘制 Chainlink 与对齐现货曲线
          </span>
        </div>
      );
    }

    let rawMin = Infinity;
    let rawMax = -Infinity;
    for (let i = 0; i < chartSeries.length; i++) {
      const pt = chartSeries[i];
      if (pt.spot < rawMin) rawMin = pt.spot;
      if (pt.spot > rawMax) rawMax = pt.spot;
      if (pt.chainlink < rawMin) rawMin = pt.chainlink;
      if (pt.chainlink > rawMax) rawMax = pt.chainlink;
      if (pt.strike < rawMin) rawMin = pt.strike;
      if (pt.strike > rawMax) rawMax = pt.strike;
    }
    const padPrice = Math.max(8, (rawMax - rawMin) * 0.25);
    const minP = rawMin - padPrice;
    const maxP = rawMax + padPrice;
    const rangeP = Math.max(maxP - minP, 1);

    const toY = (price: number) => padTop + (1 - (price - minP) / rangeP) * plotH;
    const spotPoints = chartSeries.map((p) => `${toX(p.elapsedSec)},${toY(p.spot)}`).join(' ');
    const clPoints = chartSeries
      .map((p) => `${toX(p.elapsedSec)},${toY(p.chainlink)}`)
      .join(' ');

    const strikeY = toY(displayStrike);
    const strikeLabelText = `Strike: ${formatUsdPrice(displayStrike)}`;
    const strikeLabelW = Math.max(114, strikeLabelText.length * 6.3 + 10);
    const strikeLabelY = Math.max(padTop + 4, Math.min(height - padBottom - 18, strikeY - 17));

    const endX = toX(latestPoint!.elapsedSec);
    const endY = toY(latestPoint!.spot);
    const latestPriceText = formatUsdPrice(latestPoint!.spot);
    const latestTagW = Math.max(76, latestPriceText.length * 6.4 + 12);
    const placeTagLeft = endX + latestTagW + 14 > width - padRight;
    const latestTagX = placeTagLeft
      ? Math.max(padLeft + 4, endX - latestTagW - 10)
      : endX + 10;
    const latestTagY = Math.max(padTop + 4, Math.min(height - padBottom - 19, endY - 9));

    const atrText = `1m ATR: $${atr1m !== null ? atr1m.toFixed(1) : '--'}`;
    const rGapText = `R_gap: ${normalizedGapR !== null ? normalizedGapR.toFixed(2) : '--'}`;
    const atrTagW = Math.max(88, atrText.length * 6.1 + 12);
    const rGapTagW = Math.max(72, rGapText.length * 6.1 + 12);

    return (
      <svg
        viewBox={`0 0 ${width} ${height}`}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoverIdx(null)}
        role="img"
        aria-label="当前盘 BTC 价格走势图"
        className="w-full aspect-[580/248] lg:h-[248px] bg-[#070B12] rounded-lg border border-slate-800/80 cursor-crosshair"
      >
        <defs>
          <filter id={glowId} x="-80%" y="-80%" width="260%" height="260%">
            <feGaussianBlur stdDeviation="2.6" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Horizontal Grid & Y Axis */}
        {[0, 0.25, 0.5, 0.75, 1].map((frac) => {
          const y = padTop + frac * plotH;
          const pVal = maxP - frac * rangeP;
          return (
            <g key={frac}>
              <line
                x1={padLeft}
                y1={y}
                x2={width - padRight}
                y2={y}
                stroke="#1e293b"
                strokeWidth="0.7"
              />
              <text
                x={padLeft - 6}
                y={y + 3}
                textAnchor="end"
                fill="#64748b"
                fontSize="9"
                className="font-mono"
              >
                {Math.round(pVal).toLocaleString('en-US')}
              </text>
            </g>
          );
        })}

        {/* Top-left compact parameter tags inside chart */}
        <g data-testid="btc-atr-tag">
          <rect
            x={padLeft + 4}
            y={7}
            width={atrTagW}
            height={18}
            rx={4}
            fill="#0F172A"
            stroke="#334155"
            strokeWidth="0.8"
          />
          <text
            x={padLeft + 10}
            y={19}
            fill="#cbd5e1"
            fontSize="9.5"
            className="font-mono"
          >
            {atrText}
          </text>
        </g>

        <g data-testid="btc-rgap-tag">
          <rect
            x={padLeft + 10 + atrTagW}
            y={7}
            width={rGapTagW}
            height={18}
            rx={4}
            fill="#0F172A"
            stroke="#334155"
            strokeWidth="0.8"
          />
          <text
            x={padLeft + 16 + atrTagW}
            y={19}
            fill="#93c5fd"
            fontSize="9.5"
            className="font-mono"
          >
            {rGapText}
          </text>
        </g>

        {/* Top-right inline legend */}
        <text x={width - 166} y={19} fill="#eab308" fontSize="9.5">
          ● Chainlink
        </text>
        <text x={width - 96} y={19} fill="#38bdf8" fontSize="9.5">
          ● 币安对齐价
        </text>

        {/* Yellow dashed Strike line + crisp label */}
        <line
          x1={padLeft}
          y1={strikeY}
          x2={width - padRight}
          y2={strikeY}
          stroke="#f59e0b"
          strokeWidth="1.4"
          strokeDasharray="5,4"
        />
        <g data-testid="strike-line-label">
          <rect
            x={padLeft + 4}
            y={strikeLabelY}
            width={strikeLabelW}
            height={15}
            rx={3}
            fill="#070B12"
            fillOpacity="0.9"
            stroke="#f59e0b"
            strokeOpacity="0.45"
            strokeWidth="0.8"
          />
          <text
            x={padLeft + 9}
            y={strikeLabelY + 10.8}
            fill="#fbbf24"
            fontSize="9.5"
            fontWeight="600"
            className="font-mono"
          >
            {strikeLabelText}
          </text>
        </g>

        {/* Price curves */}
        {chartSeries.length >= 2 && (
          <>
            <polyline fill="none" stroke="#eab308" strokeWidth="1.9" points={clPoints} />
            <polyline fill="none" stroke="#38bdf8" strokeWidth="2" points={spotPoints} />
          </>
        )}

        {/* Glowing endpoint dot + live price tag on blue curve */}
        <g data-testid="blue-line-endpoint">
          <circle
            cx={endX}
            cy={endY}
            r="8"
            fill="#38bdf8"
            fillOpacity="0.18"
          />
          <circle
            cx={endX}
            cy={endY}
            r="4"
            fill="#38bdf8"
            stroke="#e0f2fe"
            strokeWidth="1.2"
            filter={`url(#${glowId})`}
          />
          <rect
            x={latestTagX}
            y={latestTagY}
            width={latestTagW}
            height={18}
            rx={4}
            fill="#0B1629"
            stroke="#38bdf8"
            strokeOpacity="0.7"
            strokeWidth="0.9"
          />
          <text
            x={latestTagX + latestTagW / 2}
            y={latestTagY + 12.2}
            textAnchor="middle"
            fill="#e0f2fe"
            fontSize="9.5"
            fontWeight="700"
            className="font-mono"
          >
            {latestPriceText}
          </text>
        </g>

        {/* Hover crosshair */}
        {hoveredPoint && (
          <g>
            <line
              x1={toX(hoveredPoint.elapsedSec)}
              y1={padTop}
              x2={toX(hoveredPoint.elapsedSec)}
              y2={height - padBottom}
              stroke="#64748b"
              strokeWidth="1"
              strokeDasharray="2,2"
            />
            <circle
              cx={toX(hoveredPoint.elapsedSec)}
              cy={toY(hoveredPoint.spot)}
              r="3.2"
              fill="#38bdf8"
            />
            <circle
              cx={toX(hoveredPoint.elapsedSec)}
              cy={toY(hoveredPoint.chainlink)}
              r="3.2"
              fill="#eab308"
            />
          </g>
        )}

        {/* X Axis labels */}
        <text x={padLeft} y={height - 8} fill="#64748b" fontSize="9" className="font-mono">
          0s (开盘)
        </text>
        <text
          x={padLeft + plotW / 2}
          y={height - 8}
          textAnchor="middle"
          fill="#64748b"
          fontSize="9"
          className="font-mono"
        >
          150s (盘中)
        </text>
        <text
          x={width - padRight}
          y={height - 8}
          textAnchor="end"
          fill="#64748b"
          fontSize="9"
          className="font-mono"
        >
          300s (结算)
        </text>
      </svg>
    );
  };

  const renderOrderbookSvg = () => {
    const toY = (cents: number) =>
      padTop + (1 - Math.max(0, Math.min(100, cents)) / 100) * plotH;

    const upAskPoints = chartSeries
      .map((p) => `${toX(p.elapsedSec)},${toY(p.upAsk)}`)
      .join(' ');
    const downAskPoints = chartSeries
      .map((p) => `${toX(p.elapsedSec)},${toY(p.downAsk)}`)
      .join(' ');
    const zoneY = toY(maxEntryCents);
    const bottomY = toY(0);

    const goldenX1 = toX(70);
    const goldenX2 = toX(240);
    const goldenW = goldenX2 - goldenX1;

    return (
      <svg
        viewBox={`0 0 ${width} ${height}`}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoverIdx(null)}
        role="img"
        aria-label="Polymarket 涨跌买一卖一价格走势图"
        className="w-full aspect-[580/248] lg:h-[248px] bg-[#070B12] rounded-lg border border-slate-800/80 cursor-crosshair"
      >
        <defs>
          <linearGradient id={goldenGradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#10b981" stopOpacity="0.11" />
            <stop offset="100%" stopColor="#38bdf8" stopOpacity="0.04" />
          </linearGradient>
        </defs>

        {/* Golden Sniper Time Window (70s - 240s) vertical highlight band */}
        <g data-testid="golden-window-band">
          <rect
            x={goldenX1}
            y={padTop}
            width={goldenW}
            height={plotH}
            fill={`url(#${goldenGradId})`}
          />
          <line
            x1={goldenX1}
            y1={padTop}
            x2={goldenX1}
            y2={height - padBottom}
            stroke="#34d399"
            strokeOpacity="0.32"
            strokeWidth="1"
            strokeDasharray="3,3"
          />
          <line
            x1={goldenX2}
            y1={padTop}
            x2={goldenX2}
            y2={height - padBottom}
            stroke="#38bdf8"
            strokeOpacity="0.32"
            strokeWidth="1"
            strokeDasharray="3,3"
          />
          <text
            x={goldenX1 + goldenW / 2}
            y={padTop - 10}
            textAnchor="middle"
            fill="#34d399"
            fillOpacity="0.9"
            fontSize="9.5"
            fontWeight="600"
            className="font-mono"
          >
            黄金狙击窗 (70s–240s)
          </text>
        </g>

        {/* Horizontal Grid & Y Axis */}
        {[0, 25, 50, 75, 100].map((c) => {
          const y = toY(c);
          return (
            <g key={c}>
              <line
                x1={padLeft}
                y1={y}
                x2={width - padRight}
                y2={y}
                stroke={c === 50 ? '#334155' : '#1e293b'}
                strokeWidth={c === 50 ? '1' : '0.7'}
                strokeDasharray={c === 50 ? '3,3' : undefined}
              />
              <text
                x={padLeft - 6}
                y={y + 3}
                textAnchor="end"
                fill="#64748b"
                fontSize="9"
                className="font-mono"
              >
                {c}¢
              </text>
            </g>
          );
        })}

        {/* Sub-10c Deep-OTM Sniper Zone */}
        <rect
          x={padLeft}
          y={zoneY}
          width={plotW}
          height={Math.max(4, bottomY - zoneY)}
          fill="rgba(244, 63, 94, 0.14)"
        />
        <line
          x1={padLeft}
          y1={zoneY}
          x2={width - padRight}
          y2={zoneY}
          stroke="#f43f5e"
          strokeWidth="1.2"
          strokeDasharray="4,3"
        />
        <text x={padLeft + 6} y={zoneY - 5} fill="#fb7185" fontSize="9.5" fontWeight="600">
          ≤{maxEntryCents}¢ 深虚值反转狙击带 (10x+ 赔率)
        </text>

        {/* Orderbook polylines */}
        {chartSeries.length >= 2 && (
          <>
            <polyline fill="none" stroke="#10b981" strokeWidth="2.1" points={upAskPoints} />
            <polyline fill="none" stroke="#f43f5e" strokeWidth="2.1" points={downAskPoints} />
          </>
        )}

        {/* Current progress cursor & endpoint dots */}
        {latestPoint && (
          <g>
            <line
              x1={toX(latestPoint.elapsedSec)}
              y1={padTop}
              x2={toX(latestPoint.elapsedSec)}
              y2={height - padBottom}
              stroke="#94a3b8"
              strokeOpacity="0.28"
              strokeWidth="1"
            />
            <circle
              cx={toX(latestPoint.elapsedSec)}
              cy={toY(latestPoint.upAsk)}
              r="3.4"
              fill="#10b981"
              stroke="#d1fae5"
              strokeWidth="1"
            />
            <circle
              cx={toX(latestPoint.elapsedSec)}
              cy={toY(latestPoint.downAsk)}
              r="3.4"
              fill="#f43f5e"
              stroke="#ffe4e6"
              strokeWidth="1"
            />
          </g>
        )}

        {/* Hover crosshair */}
        {hoveredPoint && (
          <g>
            <line
              x1={toX(hoveredPoint.elapsedSec)}
              y1={padTop}
              x2={toX(hoveredPoint.elapsedSec)}
              y2={height - padBottom}
              stroke="#64748b"
              strokeWidth="1"
              strokeDasharray="2,2"
            />
            <circle
              cx={toX(hoveredPoint.elapsedSec)}
              cy={toY(hoveredPoint.upAsk)}
              r="3.5"
              fill="#10b981"
            />
            <circle
              cx={toX(hoveredPoint.elapsedSec)}
              cy={toY(hoveredPoint.downAsk)}
              r="3.5"
              fill="#f43f5e"
            />
          </g>
        )}

        {/* X Axis ticks including 70s & 240s golden boundaries */}
        <text x={padLeft} y={height - 8} fill="#64748b" fontSize="9" className="font-mono">
          0s
        </text>
        <text
          x={goldenX1}
          y={height - 8}
          textAnchor="middle"
          fill="#34d399"
          fillOpacity="0.85"
          fontSize="9"
          className="font-mono"
        >
          70s
        </text>
        <text
          x={padLeft + plotW / 2}
          y={height - 8}
          textAnchor="middle"
          fill="#64748b"
          fontSize="9"
          className="font-mono"
        >
          150s
        </text>
        <text
          x={goldenX2}
          y={height - 8}
          textAnchor="middle"
          fill="#38bdf8"
          fillOpacity="0.85"
          fontSize="9"
          className="font-mono"
        >
          240s
        </text>
        <text
          x={width - padRight}
          y={height - 8}
          textAnchor="end"
          fill="#64748b"
          fontSize="9"
          className="font-mono"
        >
          300s
        </text>
      </svg>
    );
  };

  return (
    <section
      id="trajectory-charts"
      aria-label="量化行情与盘口双轨 HUD 看板"
      className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-stretch"
    >
      {/* Left Card: BTC Price Trajectory HUD */}
      <div className="bg-[#0E1420] border border-slate-800/90 rounded-xl p-4 flex flex-col gap-3">
        <div className="space-y-2 lg:min-h-[64px] flex flex-col justify-between">
          {/* Row 1: Title + Large Aligned Price + Delta Capsule */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-display text-sm font-bold text-white whitespace-nowrap">
              BTC 价格走势
            </h2>

            <div className="flex items-center gap-2.5">
              <span
                data-testid="aligned-spot-price"
                className="text-lg sm:text-xl font-mono font-bold tabular-nums text-white tracking-tight"
              >
                {displayAlignedPrice > 0 ? formatUsdPrice(displayAlignedPrice) : '等待首帧...'}
              </span>
              {displayDelta !== null ? (
                <span
                  data-testid="strike-delta-capsule"
                  className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-mono font-semibold tabular-nums whitespace-nowrap border ${
                    displayDelta >= 0
                      ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/35'
                      : 'bg-rose-500/15 text-rose-300 border-rose-500/35'
                  }`}
                >
                  {formatUsdDelta(displayDelta)}
                </span>
              ) : (
                <span
                  data-testid="strike-delta-capsule"
                  className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-mono font-semibold tabular-nums whitespace-nowrap bg-slate-800/80 text-slate-400 border border-slate-700/70"
                >
                  $0.00
                </span>
              )}
            </div>
          </div>

          {/* Row 2: Compact Strike / Hover Readout Strip */}
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono text-slate-400">
            <span>
              基准 Strike:{' '}
              <strong className="text-amber-300 font-semibold">
                {displayStrike > 0 ? formatUsdPrice(displayStrike) : '--'}
              </strong>
            </span>
            <span className="truncate">
              {hoveredPoint
                ? `T+${hoveredPoint.elapsedSec}s · 对齐 ${formatUsdPrice(
                    hoveredPoint.spot
                  )} · CL ${formatUsdPrice(hoveredPoint.chainlink)}`
                : '对齐价与蓝线末端 / 差值严格同源'}
            </span>
          </div>
        </div>

        {renderPriceSvg()}
      </div>

      {/* Right Card: Polymarket Orderbook Trajectory HUD */}
      <div className="bg-[#0E1420] border border-slate-800/90 rounded-xl p-4 flex flex-col gap-3">
        <div className="space-y-2 lg:min-h-[64px] flex flex-col justify-between">
          {/* Row 1: Title + Countdown + Golden Window Badge + Bankroll */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-display text-sm font-bold text-white whitespace-nowrap">
              Polymarket 盘口走势
            </h2>

            <div className="flex flex-wrap items-center gap-2 text-xs font-mono tabular-nums">
              <span className="inline-flex items-center gap-1 text-slate-300 whitespace-nowrap">
                <span className="text-slate-400 font-sans text-[11px]">剩余</span>
                <strong
                  data-testid="cycle-countdown"
                  className="text-sm font-bold text-white"
                >
                  {Math.floor(remainSec / 60)}:{String(remainSec % 60).padStart(2, '0')}
                </strong>
              </span>

              <span
                data-testid="window-status-badge"
                className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-sans font-medium whitespace-nowrap border ${
                  inGoldenWindow
                    ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/35'
                    : 'bg-slate-800/90 text-slate-400 border-slate-700/70'
                }`}
              >
                {inGoldenWindow ? '黄金狙击窗' : '观察期'}
              </span>

              <span className="inline-flex items-center gap-1 whitespace-nowrap">
                <span className="text-slate-400 font-sans text-[11px]">资金池</span>
                <strong
                  data-testid="sim-bankroll"
                  className="font-bold text-indigo-300"
                >
                  ${simVirtualBankroll.toFixed(2)}
                </strong>
              </span>
            </div>
          </div>

          {/* Row 2: UP / DOWN Single-Line Quote Capsules + Feed Source */}
          <div className="flex flex-wrap xl:flex-nowrap items-center justify-between gap-2">
            <div className="flex flex-wrap sm:flex-nowrap items-center gap-2 min-w-0">
              <span
                data-testid="up-quote-capsule"
                className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-mono font-semibold tabular-nums whitespace-nowrap border transition-all ${
                  upTriggered
                    ? 'bg-emerald-500/20 text-emerald-200 border-emerald-400 ring-1 ring-emerald-400/60 shadow-[0_0_12px_rgba(16,185,129,0.45)] animate-pulse'
                    : 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
                }`}
              >
                UP 买一 {orderbook.upBid}¢ / 卖一 {orderbook.upAsk}¢ · {upOdds}x
              </span>

              <span
                data-testid="down-quote-capsule"
                className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-mono font-semibold tabular-nums whitespace-nowrap border transition-all ${
                  downTriggered
                    ? 'bg-rose-500/20 text-rose-200 border-rose-400 ring-1 ring-rose-400/60 shadow-[0_0_12px_rgba(244,63,94,0.45)] animate-pulse'
                    : 'bg-rose-500/10 text-rose-300 border-rose-500/30'
                }`}
              >
                DOWN 买一 {orderbook.downBid}¢ / 卖一 {orderbook.downAsk}¢ · {downOdds}x
              </span>
            </div>

            <span className="text-[11px] font-mono whitespace-nowrap shrink-0 text-slate-400">
              {hoveredPoint
                ? `T+${hoveredPoint.elapsedSec}s · ${hoveredPoint.upAsk}¢/${hoveredPoint.downAsk}¢`
                : orderbook.isLiveClob
                ? 'CLOB 实盘'
                : '实时定价'}
            </span>
          </div>
        </div>

        {renderOrderbookSvg()}
      </div>
    </section>
  );
};
