import React from 'react';
import { Activity, RotateCcw } from 'lucide-react';
import type {
  LedgerFilter,
  SimTradeRecord,
  StrategyRuntimeStatus,
  TradeStatus,
} from '../types/sniper';

interface TradeLedgerTableProps {
  tradeLedger: SimTradeRecord[];
  filter: LedgerFilter;
  maxEntryCents: number;
  minReversalScore: number;
  autoSimEnabled: boolean;
  strategyStatus: StrategyRuntimeStatus;
  onFilterChange: (filter: LedgerFilter) => void;
  onResetLedger: () => void;
  onManualTestSnipe: () => void;
  canPlaceSimOrder: boolean;
}

function getStatusMeta(status: TradeStatus): { label: string; className: string } {
  switch (status) {
    case 'WON_FULL':
      return { label: '绝地翻盘 (+10x)', className: 'text-emerald-400' };
    case 'STAGE1_FREEROLL':
      return { label: '已翻倍抽本 (博弈中)', className: 'text-indigo-300' };
    case 'FREEROLL_EXPIRED':
      return { label: '抽本锁利 (尾仓归零)', className: 'text-indigo-300' };
    case 'HOLDING':
      return { label: '持仓等待反弹', className: 'text-amber-300' };
    case 'LOSS_STOPPED':
      return { label: '未翻转止损', className: 'text-rose-400' };
  }
}

export const TradeLedgerTable: React.FC<TradeLedgerTableProps> = ({
  tradeLedger,
  filter,
  maxEntryCents,
  minReversalScore,
  autoSimEnabled,
  strategyStatus,
  onFilterChange,
  onResetLedger,
  onManualTestSnipe,
  canPlaceSimOrder,
}) => {
  const totalTrades = tradeLedger.length;
  const totalNetPnL = tradeLedger.reduce((acc, t) => acc + t.netPnL, 0);
  const profitableCount = tradeLedger.filter((t) => t.netPnL > 0).length;

  const statusToneClass =
    strategyStatus.tone === 'emerald'
      ? 'text-emerald-400'
      : strategyStatus.tone === 'indigo'
      ? 'text-indigo-300'
      : strategyStatus.tone === 'amber'
      ? 'text-amber-300'
      : 'text-slate-300';

  const filteredRows = tradeLedger.filter((tr) => {
    if (filter === 'active') {
      return tr.status === 'HOLDING' || tr.status === 'STAGE1_FREEROLL';
    }
    if (filter === 'settled') {
      return (
        tr.status === 'WON_FULL' ||
        tr.status === 'FREEROLL_EXPIRED' ||
        tr.status === 'LOSS_STOPPED'
      );
    }
    return true;
  });

  return (
    <section
      id="trade-ledger"
      aria-label="$5.00 单元实盘模拟交易记录"
      className="bg-[#0E1420] border border-slate-800/90 rounded-xl p-5 space-y-4"
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-1">
            <h2 className="font-display text-base font-bold text-white">
              $5.00 单元实盘模拟交易记录
            </h2>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
              <span>
                累计交易:{' '}
                <strong data-testid="ledger-total-count" className="text-white font-mono">
                  {totalTrades}
                </strong>{' '}
                笔
              </span>
              <span aria-hidden="true" className="text-slate-600">
                ·
              </span>
              <span>
                盈利 / 保本:{' '}
                <strong className="text-emerald-400 font-mono">{profitableCount}</strong> 笔
              </span>
              {strategyStatus.winRatePct !== null && (
                <>
                  <span aria-hidden="true" className="text-slate-600">
                    ·
                  </span>
                  <span>
                    已结算胜率:{' '}
                    <strong className="text-slate-200 font-mono">
                      {strategyStatus.winRatePct}%
                    </strong>
                  </span>
                </>
              )}
              <span aria-hidden="true" className="text-slate-600">
                ·
              </span>
              <span>
                累计净盈亏 (Net P&amp;L):{' '}
                <strong
                  className={`font-mono ${
                    totalNetPnL >= 0 ? 'text-emerald-400' : 'text-rose-400'
                  }`}
                >
                  {totalNetPnL >= 0 ? '+' : ''}${totalNetPnL.toFixed(2)} USDC
                </strong>
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div
              role="group"
              aria-label="交易状态筛选"
              className="inline-flex items-center p-1 bg-[#070B12] border border-slate-800 rounded-lg"
            >
              {(
                [
                  { id: 'all', label: '全部' },
                  { id: 'active', label: '持仓 / 抽本中' },
                  { id: 'settled', label: '已结算' },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => onFilterChange(tab.id)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                    filter === tab.id
                      ? 'bg-slate-800 text-white'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {tradeLedger.length > 0 && (
              <button
                type="button"
                onClick={onResetLedger}
                className="inline-flex items-center gap-1.5 px-3 py-2 bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0"
              >
                <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                <span>重置 $100 模拟金</span>
              </button>
            )}
          </div>
        </div>

        {/* Real-Time Strategy Status Strip in Ledger Top Bar */}
        <div
          data-testid="ledger-strategy-status"
          className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 border-y border-slate-800/80 py-2.5 text-xs"
        >
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <span className="inline-flex items-center gap-1.5 text-slate-400 font-medium">
              <Activity className="w-3.5 h-3.5 text-indigo-400" aria-hidden="true" />
              <span>策略实时状况:</span>
            </span>
            <span className={`font-semibold ${statusToneClass}`}>
              {strategyStatus.phaseLabel}
            </span>
            <span aria-hidden="true" className="hidden sm:inline text-slate-600">
              ·
            </span>
            <span className="font-mono text-slate-300">{strategyStatus.detailText}</span>
          </div>

          <div className="flex items-center gap-3 text-slate-400 font-mono shrink-0">
            <span>
              自动执行:{' '}
              <strong className={autoSimEnabled ? 'text-emerald-400' : 'text-slate-300'}>
                {autoSimEnabled ? '开启' : '暂停'}
              </strong>
            </span>
            <span aria-hidden="true" className="text-slate-600">
              ·
            </span>
            <span>
              阈值: ≤{maxEntryCents}¢ / ≥{minReversalScore}分
            </span>
          </div>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse text-xs">
          <thead>
            <tr className="border-b border-slate-800 text-slate-400 font-medium">
              <th className="py-2.5 px-3">盘口时段 / 建仓时间</th>
              <th className="py-2.5 px-3">方向</th>
              <th className="py-2.5 px-3 text-right">买入价 / 投入</th>
              <th className="py-2.5 px-3 text-right">份额 (剩余)</th>
              <th className="py-2.5 px-3 text-right">Strike / 结算价</th>
              <th className="py-2.5 px-3 text-right">翻转分</th>
              <th className="py-2.5 px-3 text-right">收回 / 净盈亏</th>
              <th className="py-2.5 px-3">状态与两段式止盈明细</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/70">
            {filteredRows.length === 0 ? (
              <tr>
                <td colSpan={8} className="text-center py-10 text-slate-400">
                  <p className="text-sm text-slate-300">
                    {tradeLedger.length === 0
                      ? '暂无狙击记录'
                      : '当前筛选条件下暂无订单'}
                  </p>
                  <p className="text-xs text-slate-500 mt-1">
                    当盘中 UP 或 DOWN 跌至 ≤{maxEntryCents}¢ 且翻转评分 ≥{minReversalScore}{' '}
                    时将自动以 $5.00 建仓。
                  </p>
                  {tradeLedger.length === 0 && (
                    <button
                      type="button"
                      disabled={!canPlaceSimOrder}
                      onClick={onManualTestSnipe}
                      className={`mt-3 px-4 py-2 text-xs font-semibold rounded-lg transition-colors ${
                        canPlaceSimOrder
                          ? 'bg-slate-800 hover:bg-slate-700 text-white'
                          : 'bg-slate-900 text-slate-500 border border-slate-800 cursor-not-allowed'
                      }`}
                    >
                      {canPlaceSimOrder
                        ? '立即测试一笔 $5.00 模拟建仓'
                        : '等待实盘行情接入后可模拟下单'}
                    </button>
                  )}
                </td>
              </tr>
            ) : (
              filteredRows.map((tr) => {
                const statusMeta = getStatusMeta(tr.status);
                return (
                  <tr key={tr.id} className="hover:bg-[#070B12]/60 transition-colors">
                    <td className="py-3 px-3 font-mono whitespace-nowrap">
                      <div className="text-slate-200">{tr.windowLabel}</div>
                      <div className="text-slate-500 text-[11px]">建仓 @ {tr.entryTime}</div>
                    </td>
                    <td className="py-3 px-3 font-mono font-bold whitespace-nowrap">
                      <span
                        className={
                          tr.side === 'UP' ? 'text-emerald-400' : 'text-rose-400'
                        }
                      >
                        {tr.side}
                      </span>
                    </td>
                    <td className="py-3 px-3 font-mono text-right whitespace-nowrap">
                      <span className="text-amber-400 font-bold">{tr.entryPriceCents}¢</span>{' '}
                      <span className="text-slate-400">/ ${tr.betAmountUsd.toFixed(2)}</span>
                    </td>
                    <td className="py-3 px-3 font-mono text-right whitespace-nowrap">
                      <span className="text-slate-200">{tr.initialShares}</span>{' '}
                      <span className="text-slate-500">(余 {tr.remainingShares})</span>
                    </td>
                    <td className="py-3 px-3 font-mono text-right whitespace-nowrap">
                      <div className="text-slate-200">${tr.strikePrice.toFixed(2)}</div>
                      <div className="text-slate-500 text-[11px]">
                        {tr.settlementPrice
                          ? `结算 $${tr.settlementPrice.toFixed(2)}`
                          : '进行中'}
                      </div>
                    </td>
                    <td className="py-3 px-3 font-mono text-right font-semibold text-indigo-300 whitespace-nowrap">
                      {tr.reversalScoreAtEntry} 分
                    </td>
                    <td className="py-3 px-3 font-mono text-right whitespace-nowrap">
                      <div className="text-slate-300">${tr.finalPayoutUsd.toFixed(2)}</div>
                      <div
                        className={`font-bold ${
                          tr.netPnL >= 0 ? 'text-emerald-400' : 'text-rose-400'
                        }`}
                      >
                        {tr.netPnL >= 0 ? '+' : ''}${tr.netPnL.toFixed(2)}
                      </div>
                    </td>
                    <td className="py-3 px-3 max-w-xs">
                      <div className={`font-semibold text-[11px] ${statusMeta.className}`}>
                        {statusMeta.label}
                      </div>
                      <div className="text-slate-400 text-[11px] leading-snug mt-0.5">
                        {tr.notes}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
};
