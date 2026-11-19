import React from 'react';
import { Crosshair } from 'lucide-react';
import type { SniperMetrics } from '../types/sniper';

interface SniperRadarPanelProps {
  sniperMetrics: SniperMetrics | null;
  maxEntryCents: number;
  minReversalScore: number;
  autoSimEnabled: boolean;
  onMaxEntryCentsChange: (val: number) => void;
  onMinReversalScoreChange: (val: number) => void;
  onAutoSimToggle: (enabled: boolean) => void;
  onManualSnipe: () => void;
}

export const SniperRadarPanel: React.FC<SniperRadarPanelProps> = ({
  sniperMetrics,
  maxEntryCents,
  minReversalScore,
  autoSimEnabled,
  onMaxEntryCentsChange,
  onMinReversalScoreChange,
  onAutoSimToggle,
  onManualSnipe,
}) => {
  if (!sniperMetrics) {
    return (
      <section
        id="sniper-radar"
        aria-label="翻转几率雷达与控制台"
        className="bg-[#0E1420] border border-slate-800/90 rounded-xl p-5 text-xs text-slate-400"
      >
        正在初始化 ≤10¢ 翻转几率雷达，等待首帧实盘市场行情...
      </section>
    );
  }

  const scorePassed = sniperMetrics.reversalScore >= minReversalScore;

  return (
    <section
      id="sniper-radar"
      aria-label="翻转几率雷达与控制台"
      className="bg-[#0E1420] border border-indigo-500/35 rounded-xl p-5 space-y-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div className="space-y-1">
          <h2 className="font-display text-base font-bold text-white flex flex-wrap items-center gap-2">
            <span>雷达锁定劣势方:</span>
            <span
              className={
                sniperMetrics.targetSide === 'UP' ? 'text-emerald-400' : 'text-rose-400'
              }
            >
              {sniperMetrics.targetSide}
            </span>
            <span className="font-mono text-sm font-semibold text-slate-300">
              (卖一 {sniperMetrics.targetAskCents}¢ / 买一 {sniperMetrics.targetBidCents}¢)
            </span>
          </h2>
          <p className="text-xs text-slate-400 font-mono">{sniperMetrics.triggerReason}</p>
        </div>

        <div className="flex flex-wrap items-center gap-4 text-xs">
          <label className="inline-flex items-center gap-2 text-slate-300">
            <span>触发上限 (¢)</span>
            <input
              type="number"
              min={3}
              max={25}
              value={maxEntryCents}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (!Number.isNaN(n)) onMaxEntryCentsChange(Math.max(3, Math.min(25, n)));
              }}
              className="w-16 bg-[#070B12] border border-slate-700 rounded-md px-2.5 py-1.5 font-mono text-amber-400 focus:outline-none focus:border-indigo-500"
            />
          </label>

          <label className="inline-flex items-center gap-2 text-slate-300">
            <span>最低翻转分</span>
            <input
              type="number"
              min={35}
              max={90}
              value={minReversalScore}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (!Number.isNaN(n)) onMinReversalScoreChange(Math.max(35, Math.min(90, n)));
              }}
              className="w-16 bg-[#070B12] border border-slate-700 rounded-md px-2.5 py-1.5 font-mono text-indigo-300 focus:outline-none focus:border-indigo-500"
            />
          </label>

          <label className="inline-flex items-center gap-2 text-slate-200 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={autoSimEnabled}
              onChange={(e) => onAutoSimToggle(e.target.checked)}
              className="w-4 h-4 rounded border-slate-700 bg-[#070B12] accent-indigo-500"
            />
            <span>达标自动 $5 狙击</span>
          </label>

          <button
            type="button"
            onClick={onManualSnipe}
            className="inline-flex items-center gap-2 px-4 py-2 bg-rose-600 hover:bg-rose-500 font-semibold text-white rounded-lg transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-400"
          >
            <Crosshair className="w-3.5 h-3.5" aria-hidden="true" />
            <span>
              以 $5.00 模拟买入 {sniperMetrics.targetSide} ({sniperMetrics.targetAskCents}¢)
            </span>
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-xs">
        <div className="bg-[#070B12] p-3.5 rounded-lg border border-slate-800/80 space-y-2">
          <div className="flex items-center justify-between text-slate-400">
            <span>综合翻转几率评分</span>
            <span className="font-mono font-bold text-white">
              {sniperMetrics.reversalScore} / 100
            </span>
          </div>
          <div className="w-full bg-slate-800 h-2 rounded-full overflow-hidden">
            <div
              className={`h-full transition-all duration-300 ${
                scorePassed ? 'bg-emerald-500' : 'bg-amber-500'
              }`}
              style={{ width: `${sniperMetrics.reversalScore}%` }}
            />
          </div>
          <div className="text-[11px] text-slate-500 font-mono">
            时间窗口分 {sniperMetrics.timeGapScore}/30 · 阈值 ≥{minReversalScore}
          </div>
        </div>

        <div className="bg-[#070B12] p-3.5 rounded-lg border border-slate-800/80 space-y-1.5">
          <span className="text-slate-400 block">5秒订单流脉冲 (TIR_5s)</span>
          <span className="text-base font-mono font-bold text-indigo-300 block">
            {(sniperMetrics.tir5s * 100).toFixed(1)}%
          </span>
          <span className="text-[11px] text-slate-500 font-mono block">
            30s 均值: {(sniperMetrics.tir30s * 100).toFixed(1)}% · 得分 {sniperMetrics.orderFlowReversalScore}/35
          </span>
        </div>

        <div className="bg-[#070B12] p-3.5 rounded-lg border border-slate-800/80 space-y-1.5">
          <span className="text-slate-400 block">本盘极值 Pin-bar 反弹幅度</span>
          <span className="text-base font-mono font-bold text-emerald-400 block">
            +${sniperMetrics.bounceFromExtreme.toFixed(2)} USD
          </span>
          <span className="text-[11px] text-slate-500 font-mono block">
            插针收回得分: {sniperMetrics.wickBounceScore}/20
          </span>
        </div>

        <div className="bg-[#070B12] p-3.5 rounded-lg border border-slate-800/80 space-y-1.5">
          <span className="text-slate-400 block">Chainlink 预言机缓冲垫优势</span>
          <span className="text-base font-mono font-bold text-amber-400 block">
            +${sniperMetrics.oracleCushionAdvantage.toFixed(2)} USD
          </span>
          <span className="text-[11px] text-slate-500 font-mono block">
            滞后缓冲得分: {sniperMetrics.oracleCushionScore}/15
          </span>
        </div>
      </div>
    </section>
  );
};
