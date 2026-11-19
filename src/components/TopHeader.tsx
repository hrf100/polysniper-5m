import React from 'react';
import { KeyRound, LogOut, Radio } from 'lucide-react';
import type {
  FeedConnectionState,
  SystemMetricsSnapshot,
  WalletAuthState,
  WsConnectionStatus,
} from '../types/sniper';
import { extractMarketWindowBadge } from '../utils/sniperEngine';
import { SystemTelemetryBar } from './SystemTelemetryBar';

interface TopHeaderProps {
  activeMarketTitle: string;
  wsStatus: WsConnectionStatus;
  walletState: WalletAuthState;
  systemMetrics: SystemMetricsSnapshot | null;
  onOpenWalletModal: () => void;
}

const DOT_CLASSES: Record<FeedConnectionState, string> = {
  connected: 'bg-emerald-400',
  connecting: 'bg-amber-400 animate-pulse',
  disconnected: 'bg-rose-400',
};

function getFeedTitle(name: string, state: FeedConnectionState, detail: string): string {
  const statusText =
    state === 'connected' ? '实时已连接' : state === 'connecting' ? '正在连接中' : '连接已断开';
  return `${name}: ${statusText} (${detail})`;
}

export const TopHeader: React.FC<TopHeaderProps> = ({
  activeMarketTitle,
  wsStatus,
  walletState,
  systemMetrics,
  onOpenWalletModal,
}) => {
  const shortWindow = extractMarketWindowBadge(activeMarketTitle);
  const isWalletLinked = Boolean(walletState.eoaAddress);

  return (
    <div className="space-y-3">
      {/* Row 1: Brand Title + Whole-Machine 44px Monitor */}
      <header className="flex flex-wrap sm:flex-nowrap items-center justify-between gap-3 border-b border-slate-800/80 pb-3">
        <a
          href="#top"
          className="font-display text-lg font-bold tracking-tight text-white whitespace-nowrap shrink-0"
        >
          PolySniper 5m
        </a>

        <div className="w-full sm:w-auto flex justify-end overflow-x-auto">
          <SystemTelemetryBar systemMetrics={systemMetrics} />
        </div>
      </header>

      {/* Row 2: Compact 3-Section Single-Line Status Bar (44px-48px desktop height) */}
      <div
        data-testid="compact-status-bar"
        className="bg-[#0E1420] border border-slate-800/90 rounded-xl px-4 py-2 min-h-[44px] lg:h-[46px] flex flex-wrap lg:flex-nowrap items-center justify-between gap-x-4 gap-y-1.5"
      >
        {/* Left: Core Title + Short Market Window Badge + $5 Unit Badge */}
        <div className="flex items-center gap-2 min-w-0 shrink-0">
          <h1 className="font-display text-sm font-bold text-white tracking-tight whitespace-nowrap">
            BTC 5m 反转狙击
          </h1>
          <span
            data-testid="market-window-badge"
            title={activeMarketTitle}
            className="inline-flex items-center px-2 py-0.5 rounded-md bg-amber-500/10 border border-amber-500/25 text-[11px] font-mono font-semibold text-amber-300 whitespace-nowrap"
          >
            {shortWindow}
          </span>
          <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-rose-500/10 border border-rose-500/25 text-[11px] font-medium text-rose-300 whitespace-nowrap">
            $5 单元
          </span>
        </div>

        {/* Center: Minimal 3-Dot Feed Indicators */}
        <div
          data-testid="feed-status-dots"
          className="flex items-center gap-3.5 text-xs text-slate-300 shrink-0"
        >
          <span
            data-status={wsStatus.chainlink}
            title={getFeedTitle('Chainlink RTDS', wsStatus.chainlink, 'BTC/USD 预言机参考源')}
            className="inline-flex items-center gap-1.5 whitespace-nowrap cursor-default"
          >
            <span
              className={`w-2 h-2 rounded-full ${DOT_CLASSES[wsStatus.chainlink]}`}
              aria-hidden="true"
            />
            <span>Chainlink</span>
          </span>
          <span
            data-status={wsStatus.binance}
            title={getFeedTitle('Binance Spot WS', wsStatus.binance, 'BTCUSDT aggTrade & 1m Kline')}
            className="inline-flex items-center gap-1.5 whitespace-nowrap cursor-default"
          >
            <span
              className={`w-2 h-2 rounded-full ${DOT_CLASSES[wsStatus.binance]}`}
              aria-hidden="true"
            />
            <span>Binance</span>
          </span>
          <span
            data-status={wsStatus.polyClob}
            title={getFeedTitle('Polymarket CLOB', wsStatus.polyClob, '5m 二元盘口实时买一/卖一')}
            className="inline-flex items-center gap-1.5 whitespace-nowrap cursor-default"
          >
            <span
              className={`w-2 h-2 rounded-full ${DOT_CLASSES[wsStatus.polyClob]}`}
              aria-hidden="true"
            />
            <span>CLOB</span>
          </span>
        </div>

        {/* Right: Cash | Equity + Mode Capsule + Compact Wallet Settings Icon */}
        <div className="flex items-center gap-2.5 text-xs shrink-0 ml-auto lg:ml-0">
          <div className="flex items-center gap-1.5 font-mono tabular-nums whitespace-nowrap">
            <span className="text-slate-400">现金</span>
            <span className="font-semibold text-emerald-400">
              ${walletState.usdcCashBalance.toFixed(2)}
            </span>
            <span className="text-slate-600 px-0.5" aria-hidden="true">
              |
            </span>
            <span className="text-slate-400">净值</span>
            <span className="font-semibold text-indigo-300">
              ${walletState.portfolioValue.toFixed(2)}
            </span>
          </div>

          <div
            data-testid="live-feed-mode-label"
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-500/10 border border-emerald-500/25 text-[11px] font-medium text-emerald-300 whitespace-nowrap"
          >
            <Radio className="w-3 h-3 text-emerald-400" aria-hidden="true" />
            <span>实盘行情·模拟</span>
          </div>

          <button
            type="button"
            onClick={onOpenWalletModal}
            aria-label="设置私钥 / API Key"
            title={
              isWalletLinked
                ? `钱包已配置: ${walletState.eoaAddress.slice(0, 6)}...${walletState.eoaAddress.slice(-4)}`
                : '设置私钥 / API Key'
            }
            className={`relative inline-flex items-center justify-center w-7 h-7 rounded-lg border transition-colors shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400 ${
              isWalletLinked
                ? 'bg-emerald-500/15 border-emerald-500/35 text-emerald-300 hover:bg-emerald-500/25'
                : 'bg-slate-800/80 border-slate-700/80 text-slate-300 hover:bg-indigo-600 hover:border-indigo-500 hover:text-white'
            }`}
          >
            <KeyRound className="w-3.5 h-3.5" aria-hidden="true" />
            {isWalletLinked && (
              <span
                className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-emerald-400 ring-2 ring-[#0E1420]"
                aria-hidden="true"
              />
            )}
          </button>

          <a
            href="/logout"
            aria-label="退出登录"
            title="退出登录"
            className="inline-flex items-center justify-center w-7 h-7 rounded-lg border bg-slate-800/80 border-slate-700/80 text-slate-300 hover:bg-rose-600 hover:border-rose-500 hover:text-white transition-colors shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400"
          >
            <LogOut className="w-3.5 h-3.5" aria-hidden="true" />
          </a>
        </div>
      </div>
    </div>
  );
};

