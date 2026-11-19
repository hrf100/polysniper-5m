export interface TradeTick {
  time: number;
  price: number;
  qty: number;
  isBuyerMaker: boolean; // false = Taker Buy, true = Taker Sell
}

export interface Kline1m {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface ChartPoint {
  elapsedSec: number;
  spot: number;
  chainlink: number;
  strike: number;
  upBid: number; // cents (0-100)
  upAsk: number; // cents (0-100)
  downBid: number; // cents (0-100)
  downAsk: number; // cents (0-100)
}

export interface OrderbookSnapshot {
  upBid: number;
  upAsk: number;
  downBid: number;
  downAsk: number;
  isLiveClob: boolean;
}

export interface SniperMetrics {
  remainSec: number;
  targetSide: 'UP' | 'DOWN';
  targetAskCents: number;
  targetBidCents: number;
  dollarGap: number; // Spot - Strike ($)
  oracleGap: number; // Chainlink - Strike ($)
  atr1m: number; // 1m ATR ($)
  normalizedGapR: number; // Standardized gap R_gap
  tir5s: number; // 5s Trade Imbalance Ratio [-1, 1]
  tir30s: number; // 30s Trade Imbalance Ratio [-1, 1]
  bounceFromExtreme: number; // Bounce from window extreme ($)
  oracleCushionAdvantage: number; // Chainlink lag cushion ($)
  timeGapScore: number; // 0-30
  orderFlowReversalScore: number; // 0-35
  wickBounceScore: number; // 0-20
  oracleCushionScore: number; // 0-15
  reversalScore: number; // Composite reversal score (0-99)
  strikeReliable: boolean; // Strike captured at an observed window open
  canSnipe: boolean;
  triggerReason: string;
}

export type TradeStatus =
  | 'HOLDING'
  | 'STAGE1_FREEROLL'
  | 'WON_FULL'
  | 'LOSS_STOPPED'
  | 'FREEROLL_EXPIRED';

export interface SimTradeRecord {
  id: string;
  windowLabel: string;
  windowStartSec?: number; // Unix sec of the 5m window open; absent on legacy records
  entryTime: string;
  side: 'UP' | 'DOWN';
  entryPriceCents: number;
  betAmountUsd: number;
  initialShares: number;
  remainingShares: number;
  strikePrice: number;
  entrySpotPrice: number;
  reversalScoreAtEntry: number;
  stage1Triggered: boolean;
  stage1PayoutUsd: number;
  settlementPrice: number | null;
  finalPayoutUsd: number;
  netPnL: number;
  status: TradeStatus;
  notes: string;
}

export interface WalletAuthState {
  eoaPrivateKey: string;
  eoaAddress: string;
  proxyWalletAddress: string;
  apiKey: string;
  apiSecret: string;
  apiPassphrase: string;
  usdcCashBalance: number;
  portfolioValue: number;
  maticBalance: number;
  authStatus: string;
  authTone: 'idle' | 'success' | 'warning' | 'error';
  isLoading: boolean;
}

export type FeedConnectionState = 'connecting' | 'connected' | 'disconnected';

export interface WsConnectionStatus {
  chainlink: FeedConnectionState;
  binance: FeedConnectionState;
  polyClob: FeedConnectionState;
}

export type LedgerFilter = 'all' | 'active' | 'settled';

export interface StrategyRuntimeStatus {
  phaseLabel: string;
  detailText: string;
  tone: 'emerald' | 'indigo' | 'amber' | 'slate';
  activeHoldCount: number;
  winRatePct: number | null;
}

export interface StrategySettings {
  autoSimEnabled: boolean;
  maxEntryCents: number;
  minReversalScore: number;
}

/** Pushed by the server strategy service every second over SSE. */
export interface StrategyTick {
  serverTimeMs: number;
  wsStatus: WsConnectionStatus;
  activeMarketTitle: string;
  spotPrice: number;
  alignedSpotPrice: number;
  strikePrice: number;
  orderbook: OrderbookSnapshot;
  sniperMetrics: SniperMetrics | null;
  simVirtualBankroll: number;
  settings: StrategySettings;
  strategyStatus: StrategyRuntimeStatus;
  chartPoint: ChartPoint | null;
  chartReset: boolean;
}

export interface StrategyLedgerUpdate {
  tradeLedger: SimTradeRecord[];
  simVirtualBankroll: number;
}

export interface StrategySnapshot
  extends Omit<StrategyTick, 'chartPoint' | 'chartReset'>,
    StrategyLedgerUpdate {
  chartSeries: ChartPoint[];
}

export interface ClientTrafficStats {
  wsRxBytes: number;
  wsTxBytes: number;
  wsMsgCount: number;
  wsRxRateBps: number;
  wsMsgPerSec: number;
}

export interface SystemMetricsSnapshot {
  cpuPercent: number;
  processCpuPercent: number;
  systemLoad1m: number;
  cpuCores: number;
  processRssMb: number;
  processHeapUsedMb: number;
  processHeapTotalMb: number;
  sysUsedMb: number;
  sysTotalMb: number;
  sysMemPercent: number;
  netRxBytes: number;
  netTxBytes: number;
  netRxRateBps: number;
  netTxRateBps: number;
  proxyReqCount: number;
  proxyRxBytes: number;
  proxyTxBytes: number;
  uptimeSec: number;
}


