import { useCallback, useEffect, useState } from 'react';
import { DualTrajectoryCharts } from './components/DualTrajectoryCharts';
import { SniperRadarPanel } from './components/SniperRadarPanel';
import { TopHeader } from './components/TopHeader';
import { TradeLedgerTable } from './components/TradeLedgerTable';
import { WalletAuthModal } from './components/WalletAuthModal';
import type {
  ChartPoint,
  LedgerFilter,
  OrderbookSnapshot,
  SimTradeRecord,
  SniperMetrics,
  StrategyLedgerUpdate,
  StrategyRuntimeStatus,
  StrategySettings,
  StrategySnapshot,
  StrategyTick,
  SystemMetricsSnapshot,
  WalletAuthState,
  WsConnectionStatus,
} from './types/sniper';
import {
  authenticatePolymarketWallet,
  fetchWalletBalances,
  validatePrivateKeyInput,
} from './utils/polymarketApi';
import { INITIAL_SIM_BANKROLL } from './utils/sniperEngine';

const MAX_CHART_POINTS = 150;

const INITIAL_STATUS: StrategyRuntimeStatus = {
  phaseLabel: '正在连接策略服务',
  detailText: '策略在服务器常驻运行，本页面仅用于观察与调参',
  tone: 'slate',
  activeHoldCount: 0,
  winRatePct: null,
};

async function redirectIfUnauthorized(): Promise<void> {
  try {
    const res = await fetch('/api/strategy/state', { method: 'HEAD' });
    if (res.status === 401) window.location.href = '/login';
  } catch {
    // server unreachable; EventSource keeps retrying
  }
}

async function postStrategy(path: string, body?: unknown): Promise<Response | null> {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401) window.location.href = '/login';
    return res;
  } catch {
    return null;
  }
}

export default function App() {
  // 1. Wallet & L2 API Key state
  const [showWalletModal, setShowWalletModal] = useState(false);
  const [walletValidationError, setWalletValidationError] = useState<string | null>(null);
  const [walletState, setWalletState] = useState<WalletAuthState>({
    eoaPrivateKey: '',
    eoaAddress: '',
    proxyWalletAddress: '',
    apiKey: '',
    apiSecret: '',
    apiPassphrase: '',
    usdcCashBalance: 0,
    portfolioValue: 0,
    maticBalance: 0,
    authStatus: '未连接钱包',
    authTone: 'idle',
    isLoading: false,
  });

  // 2. Server strategy state (observed over SSE)
  const [wsStatus, setWsStatus] = useState<WsConnectionStatus>({
    chainlink: 'connecting',
    binance: 'connecting',
    polyClob: 'connecting',
  });
  const [activeMarketTitle, setActiveMarketTitle] = useState('BTC Up or Down (5m)');
  const [spotPrice, setSpotPrice] = useState(0);
  const [alignedSpotPrice, setAlignedSpotPrice] = useState(0);
  const [strikePrice, setStrikePrice] = useState(0);
  const [orderbook, setOrderbook] = useState<OrderbookSnapshot>({
    upBid: 49,
    upAsk: 51,
    downBid: 49,
    downAsk: 51,
    isLiveClob: false,
  });
  const [chartSeries, setChartSeries] = useState<ChartPoint[]>([]);
  const [sniperMetrics, setSniperMetrics] = useState<SniperMetrics | null>(null);
  const [strategyStatus, setStrategyStatus] = useState<StrategyRuntimeStatus>(INITIAL_STATUS);
  const [settings, setSettings] = useState<StrategySettings>({
    autoSimEnabled: true,
    maxEntryCents: 10,
    minReversalScore: 62,
  });
  const [simVirtualBankroll, setSimVirtualBankroll] = useState(INITIAL_SIM_BANKROLL);
  const [tradeLedger, setTradeLedger] = useState<SimTradeRecord[]>([]);
  const [ledgerFilter, setLedgerFilter] = useState<LedgerFilter>('all');
  const [systemMetrics, setSystemMetrics] = useState<SystemMetricsSnapshot | null>(null);

  // Wallet authentication handler
  const handleConnectWallet = useCallback(async () => {
    const err = validatePrivateKeyInput(walletState.eoaPrivateKey);
    if (err) {
      setWalletValidationError(err);
      return;
    }
    setWalletValidationError(null);
    setWalletState((prev) => ({
      ...prev,
      isLoading: true,
      authStatus: '正在执行 EIP-712 签名并查询链上资产...',
      authTone: 'idle',
    }));

    try {
      const auth = await authenticatePolymarketWallet(
        walletState.eoaPrivateKey,
        walletState.proxyWalletAddress
      );
      const balances = await fetchWalletBalances(
        auth.eoaAddress,
        auth.proxyWalletAddress
      );

      setWalletState((prev) => ({
        ...prev,
        ...auth,
        ...balances,
        isLoading: false,
      }));
    } catch (error) {
      const msg = error instanceof Error ? error.message : '私钥格式错误或签名失败';
      setWalletState((prev) => ({
        ...prev,
        isLoading: false,
        authStatus: `鉴权失败: ${msg}`,
        authTone: 'error',
      }));
    }
  }, [walletState.eoaPrivateKey, walletState.proxyWalletAddress]);

  const handleRefreshBalances = useCallback(async () => {
    if (!walletState.eoaAddress) return;
    setWalletState((prev) => ({ ...prev, isLoading: true }));
    try {
      const balances = await fetchWalletBalances(
        walletState.eoaAddress,
        walletState.proxyWalletAddress
      );
      setWalletState((prev) => ({ ...prev, ...balances, isLoading: false }));
    } catch {
      setWalletState((prev) => ({ ...prev, isLoading: false }));
    }
  }, [walletState.eoaAddress, walletState.proxyWalletAddress]);

  // Subscribe to the server-resident strategy (EventSource auto-reconnects)
  useEffect(() => {
    const applyTickBase = (t: Omit<StrategyTick, 'chartPoint' | 'chartReset'>) => {
      setWsStatus((prev) =>
        prev.chainlink === t.wsStatus.chainlink &&
        prev.binance === t.wsStatus.binance &&
        prev.polyClob === t.wsStatus.polyClob
          ? prev
          : t.wsStatus
      );
      setActiveMarketTitle(t.activeMarketTitle);
      setSpotPrice(t.spotPrice);
      setAlignedSpotPrice(t.alignedSpotPrice);
      setStrikePrice(t.strikePrice);
      setOrderbook((prev) =>
        prev.upBid === t.orderbook.upBid &&
        prev.upAsk === t.orderbook.upAsk &&
        prev.downBid === t.orderbook.downBid &&
        prev.downAsk === t.orderbook.downAsk &&
        prev.isLiveClob === t.orderbook.isLiveClob
          ? prev
          : t.orderbook
      );
      setSniperMetrics(t.sniperMetrics);
      setStrategyStatus(t.strategyStatus);
      setSimVirtualBankroll(t.simVirtualBankroll);
      setSettings((prev) =>
        prev.autoSimEnabled === t.settings.autoSimEnabled &&
        prev.maxEntryCents === t.settings.maxEntryCents &&
        prev.minReversalScore === t.settings.minReversalScore
          ? prev
          : t.settings
      );
    };

    const source = new EventSource('/api/strategy/stream');

    source.addEventListener('snapshot', (ev) => {
      const snap: StrategySnapshot = JSON.parse((ev as MessageEvent).data);
      applyTickBase(snap);
      setChartSeries(snap.chartSeries);
      setTradeLedger(snap.tradeLedger);
    });

    source.addEventListener('tick', (ev) => {
      const tick: StrategyTick = JSON.parse((ev as MessageEvent).data);
      applyTickBase(tick);
      if (tick.chartReset || tick.chartPoint) {
        const point = tick.chartPoint;
        setChartSeries((prev) => {
          const base = tick.chartReset ? [] : prev;
          if (!point) return base;
          const next = [...base, point];
          return next.length > MAX_CHART_POINTS ? next.slice(-MAX_CHART_POINTS) : next;
        });
      }
    });

    source.addEventListener('ledger', (ev) => {
      const update: StrategyLedgerUpdate = JSON.parse((ev as MessageEvent).data);
      setTradeLedger(update.tradeLedger);
      setSimVirtualBankroll(update.simVirtualBankroll);
    });

    source.onerror = () => {
      setWsStatus({ chainlink: 'connecting', binance: 'connecting', polyClob: 'connecting' });
      void redirectIfUnauthorized();
    };

    return () => source.close();
  }, []);

  const updateSettings = useCallback((patch: Partial<StrategySettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }));
    void postStrategy('/api/strategy/settings', patch);
  }, []);

  const canPlaceSimOrder = Boolean(sniperMetrics && strikePrice > 0 && spotPrice > 0);

  const handleManualSnipe = useCallback(() => {
    void postStrategy('/api/strategy/manual-snipe');
  }, []);

  const handleResetLedger = useCallback(() => {
    void postStrategy('/api/strategy/reset-ledger');
  }, []);

  // Whole-machine CPU, memory, and network traffic polling
  useEffect(() => {
    let cancelled = false;

    const fetchSysMetrics = async () => {
      try {
        const res = await fetch('/api/system/metrics');
        if (res.status === 401) {
          window.location.href = '/login';
          return;
        }
        if (!res.ok) return;
        const data: SystemMetricsSnapshot = await res.json();
        if (!cancelled) setSystemMetrics(data);
      } catch {
        // ignore transient errors
      }
    };

    fetchSysMetrics();
    const sysTimer = setInterval(fetchSysMetrics, 2000);

    return () => {
      cancelled = true;
      clearInterval(sysTimer);
    };
  }, []);

  return (
    <div id="top" className="min-h-screen bg-[#070B12] text-slate-100">
      <main className="max-w-7xl mx-auto px-4 md:px-6 py-4 space-y-4">
        <TopHeader
          activeMarketTitle={activeMarketTitle}
          wsStatus={wsStatus}
          walletState={walletState}
          systemMetrics={systemMetrics}
          onOpenWalletModal={() => setShowWalletModal(true)}
        />

        <DualTrajectoryCharts
          chartSeries={chartSeries}
          strikePrice={strikePrice}
          alignedSpotPrice={alignedSpotPrice}
          orderbook={orderbook}
          sniperMetrics={sniperMetrics}
          maxEntryCents={settings.maxEntryCents}
          simVirtualBankroll={simVirtualBankroll}
        />

        <SniperRadarPanel
          sniperMetrics={sniperMetrics}
          maxEntryCents={settings.maxEntryCents}
          minReversalScore={settings.minReversalScore}
          autoSimEnabled={settings.autoSimEnabled}
          onMaxEntryCentsChange={(val) => updateSettings({ maxEntryCents: val })}
          onMinReversalScoreChange={(val) => updateSettings({ minReversalScore: val })}
          onAutoSimToggle={(enabled) => updateSettings({ autoSimEnabled: enabled })}
          onManualSnipe={handleManualSnipe}
        />

        <TradeLedgerTable
          tradeLedger={tradeLedger}
          filter={ledgerFilter}
          maxEntryCents={settings.maxEntryCents}
          minReversalScore={settings.minReversalScore}
          autoSimEnabled={settings.autoSimEnabled}
          strategyStatus={strategyStatus}
          onFilterChange={setLedgerFilter}
          onResetLedger={handleResetLedger}
          onManualTestSnipe={handleManualSnipe}
          canPlaceSimOrder={canPlaceSimOrder}
        />
      </main>

      <WalletAuthModal
        isOpen={showWalletModal}
        walletState={walletState}
        validationError={walletValidationError}
        onClose={() => {
          setShowWalletModal(false);
          setWalletValidationError(null);
        }}
        onUpdateField={(field, value) => {
          setWalletValidationError(null);
          setWalletState((prev) => ({ ...prev, [field]: value }));
        }}
        onConnect={handleConnectWallet}
        onRefreshBalances={handleRefreshBalances}
      />
    </div>
  );
}
