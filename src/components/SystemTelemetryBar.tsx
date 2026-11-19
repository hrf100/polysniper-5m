import React from 'react';
import type { SystemMetricsSnapshot } from '../types/sniper';

interface SystemTelemetryBarProps {
  systemMetrics: SystemMetricsSnapshot | null;
}

function formatCompactBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0B';
  if (bytes < 1024) return `${Math.round(bytes)}B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb >= 100 ? Math.round(kb) : kb.toFixed(1)}K`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb >= 100 ? Math.round(mb) : mb.toFixed(1)}M`;
  const gb = mb / 1024;
  return `${gb >= 100 ? Math.round(gb) : gb.toFixed(1)}G`;
}

function formatCompactRate(bps: number): string {
  return `${formatCompactBytes(bps)}/s`;
}

const RING_RADIUS = 14.5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS; // ~91.11

function getDashArray(percent: number): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const arc = clamped > 0 ? Math.max(3, (clamped / 100) * RING_CIRCUMFERENCE) : 0;
  return `${arc.toFixed(1)}, ${RING_CIRCUMFERENCE.toFixed(1)}`;
}

export const SystemTelemetryBar: React.FC<SystemTelemetryBarProps> = ({
  systemMetrics,
}) => {
  const cpuPct = systemMetrics?.cpuPercent ?? 0;
  const memPct = systemMetrics?.sysMemPercent ?? 0;

  const cpuStroke =
    !systemMetrics
      ? '#475569'
      : cpuPct >= 80
      ? '#fb7185'
      : cpuPct >= 50
      ? '#f59e0b'
      : '#34d399';

  const memStroke =
    !systemMetrics
      ? '#475569'
      : memPct >= 85
      ? '#fb7185'
      : memPct >= 70
      ? '#f59e0b'
      : '#38bdf8';

  const netRxBytes = systemMetrics?.netRxBytes ?? 0;
  const netTxBytes = systemMetrics?.netTxBytes ?? 0;
  const netTotalBytes = netRxBytes + netTxBytes;
  const netRxRateBps = systemMetrics?.netRxRateBps ?? 0;
  const netTxRateBps = systemMetrics?.netTxRateBps ?? 0;

  const cpuText = !systemMetrics
    ? '--'
    : cpuPct > 0 && cpuPct < 10
    ? `${cpuPct.toFixed(1)}%`
    : `${Math.round(cpuPct)}%`;

  const memText = !systemMetrics ? '--' : `${Math.round(memPct)}%`;

  return (
    <section
      data-testid="system-telemetry-bar"
      aria-label="整机 CPU 内存与流量监控"
      className="inline-flex flex-wrap sm:flex-nowrap items-center justify-center min-h-[44px] sm:h-[44px] max-w-full gap-x-4 gap-y-2 px-4 py-2 sm:py-0 bg-[#0E1420] text-slate-100 rounded-xl border border-slate-800/90 tabular-nums"
    >
      {/* 整机 CPU 圆环 */}
      <div
        className="flex items-center gap-2 shrink-0"
        title={
          systemMetrics
            ? `整机 CPU ${cpuPct.toFixed(1)}% · Load ${systemMetrics.systemLoad1m.toFixed(2)} · ${systemMetrics.cpuCores} 核`
            : '等待整机 CPU 采样'
        }
      >
        <svg
          width="26"
          height="26"
          viewBox="0 0 36 36"
          aria-hidden="true"
          className="-rotate-90 shrink-0"
        >
          <circle
            cx="18"
            cy="18"
            r={RING_RADIUS}
            fill="none"
            stroke="#1e293b"
            strokeWidth="3.6"
          />
          <circle
            cx="18"
            cy="18"
            r={RING_RADIUS}
            fill="none"
            stroke={cpuStroke}
            strokeWidth="3.6"
            strokeDasharray={getDashArray(cpuPct)}
            strokeLinecap="round"
          />
        </svg>
        <span className="text-[13px] font-bold font-mono text-white">{cpuText}</span>
        <span className="text-[10px] font-semibold text-slate-400">CPU</span>
      </div>

      <span className="w-px h-4 bg-slate-800 shrink-0" aria-hidden="true" />

      {/* 整机 MEM 圆环 */}
      <div
        className="flex items-center gap-2 shrink-0"
        title={
          systemMetrics
            ? `整机内存 ${systemMetrics.sysUsedMb}/${systemMetrics.sysTotalMb} MB (${memPct.toFixed(1)}%)`
            : '等待整机内存采样'
        }
      >
        <svg
          width="26"
          height="26"
          viewBox="0 0 36 36"
          aria-hidden="true"
          className="-rotate-90 shrink-0"
        >
          <circle
            cx="18"
            cy="18"
            r={RING_RADIUS}
            fill="none"
            stroke="#1e293b"
            strokeWidth="3.6"
          />
          <circle
            cx="18"
            cy="18"
            r={RING_RADIUS}
            fill="none"
            stroke={memStroke}
            strokeWidth="3.6"
            strokeDasharray={getDashArray(memPct)}
            strokeLinecap="round"
          />
        </svg>
        <span className="text-[13px] font-bold font-mono text-white">{memText}</span>
        <span className="text-[10px] font-semibold text-slate-400">MEM</span>
      </div>

      <span
        className="hidden sm:inline-block w-px h-4 bg-slate-800 shrink-0"
        aria-hidden="true"
      />

      {/* 整机实时速率 (↓ / ↑) 与整机累计总流量 (Σ) */}
      <div
        className="flex items-center gap-2.5 text-xs font-mono shrink-0"
        title={
          systemMetrics
            ? `整机累计下行 ${formatCompactBytes(netRxBytes)} · 累计上行 ${formatCompactBytes(netTxBytes)} · 实时 ↓${formatCompactRate(netRxRateBps)} ↑${formatCompactRate(netTxRateBps)}`
            : '等待整机流量采样'
        }
      >
        <span className="text-emerald-400">
          ↓ {systemMetrics ? formatCompactRate(netRxRateBps) : '--'}
        </span>
        <span className="text-sky-400">
          ↑ {systemMetrics ? formatCompactRate(netTxRateBps) : '--'}
        </span>
        <span
          data-testid="cumulative-traffic-cell"
          className="text-[11px] text-slate-300 bg-slate-800/80 border border-slate-700/60 px-2 py-0.5 rounded-md"
        >
          Σ {systemMetrics ? formatCompactBytes(netTotalBytes) : '--'}
        </span>
      </div>
    </section>
  );
};
