import fs from 'fs';
import path from 'path';
import type {
  ChartPoint,
  Kline1m,
  OrderbookSnapshot,
  SimTradeRecord,
  SniperMetrics,
  StrategyLedgerUpdate,
  StrategySettings,
  StrategySnapshot,
  StrategyTick,
  WsConnectionStatus,
} from './src/types/sniper';
import {
  BET_UNIT_USD,
  INITIAL_SIM_BANKROLL,
  WINDOW_DURATION_SEC,
  calcAtr1m,
  calcTirFromRing,
  computeReconnectDelayMs,
  computeSniperMetrics,
  createFiveDollarSnipe,
  createTradeBucketRing,
  deriveStrategyRuntimeStatus,
  estimateBinaryOrderbook,
  evaluateStage1FreeRoll,
  expireTradesWhere,
  formatWindowLabel,
  getClobPollIntervalMs,
  buildLiveOrderbook,
  parseBestBidAsk,
  pushTradeToRing,
  settleExpiredTrades,
} from './src/utils/sniperEngine';

const BASIS_RING_SIZE = 180;
const MAX_CHART_POINTS = 150;
const MAX_LEDGER_RECORDS = 500;
const MAX_KLINES = 40;
// Strike/settlement = Chainlink report stamped exactly at the window boundary,
// identical to Polymarket's crypto-price openPrice/closePrice. RTDS delivers it
// ~1s late; the official endpoint is the fallback (mid-window start, feed gaps).
const CHAINLINK_HISTORY_SEC = 900;
const OFFICIAL_PRICE_DELAY_SEC = 2;
const OFFICIAL_RETRY_MS = 5000;
const OFFICIAL_CACHE_MAX = 50;
const SETTLE_GIVE_UP_SEC = 900;
const CLOB_STALE_MS = 5000;
const FETCH_TIMEOUT_MS = 6000;
const PERSIST_DEBOUNCE_MS = 1000;
// Half-open sockets are common on VPS links; reconnect if a feed goes silent.
const FEED_SILENCE_RECONNECT_MS = 30000;
const RTDS_PING_INTERVAL_MS = 5000;
const DEFAULT_MARKET_TITLE = 'BTC Up or Down (5m)';

const DEFAULT_SETTINGS: StrategySettings = {
  autoSimEnabled: true,
  maxEntryCents: 10,
  minReversalScore: 62,
};

interface PersistedState {
  version: 1;
  tradeLedger: SimTradeRecord[];
  simVirtualBankroll: number;
  settings: StrategySettings;
}

export type StrategyEvent =
  | { type: 'tick'; data: StrategyTick }
  | { type: 'ledger'; data: StrategyLedgerUpdate };

type Listener = (event: StrategyEvent) => void;

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function sanitizeSettings(raw: Partial<StrategySettings> | undefined, base: StrategySettings) {
  return {
    autoSimEnabled:
      typeof raw?.autoSimEnabled === 'boolean' ? raw.autoSimEnabled : base.autoSimEnabled,
    maxEntryCents: clampInt(raw?.maxEntryCents, 3, 25, base.maxEntryCents),
    minReversalScore: clampInt(raw?.minReversalScore, 35, 90, base.minReversalScore),
  };
}

export interface TrafficCounter {
  reqCount: number;
  rxBytes: number;
  txBytes: number;
}

/**
 * Runs the BTC 5m reversal sniper continuously on the server. Browsers only
 * observe it (via subscribe) and adjust settings.
 */
export class StrategyService {
  private readonly stateFile: string;
  private listeners = new Set<Listener>();
  private stopped = true;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private loopTimer: ReturnType<typeof setInterval> | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  private settings: StrategySettings = { ...DEFAULT_SETTINGS };
  private tradeLedger: SimTradeRecord[] = [];
  private bankroll = INITIAL_SIM_BANKROLL;

  private clockOffsetMs = 0;
  private clockSynced = false;
  private tradeRing = createTradeBucketRing();
  private klines: Kline1m[] = [];
  private basisRing = { buf: new Float64Array(BASIS_RING_SIZE), idx: 0, count: 0, sum: 0 };
  private prices = {
    spot: 0,
    chainlink: 0,
    hasRealChainlink: false,
    strikeBootstrappedFromSpot: false,
    strikeReliable: false,
    strikeResolved: false,
    needsChartReset: false,
    strike: 0,
    windowStartSec: 0,
    windowHigh: 0,
    windowLow: Infinity,
  };
  private wsStatus: WsConnectionStatus = {
    chainlink: 'connecting',
    binance: 'connecting',
    polyClob: 'connecting',
  };
  private activeMarketTitle = DEFAULT_MARKET_TITLE;
  private orderbook: OrderbookSnapshot = {
    upBid: 49,
    upAsk: 51,
    downBid: 49,
    downAsk: 51,
    isLiveClob: false,
  };
  private orderbookMeta = { windowStartSec: 0, fetchedAtMs: 0 };
  private clobTokens = { upTokenId: '', downTokenId: '', windowStartSec: 0 };

  private chartSeries: ChartPoint[] = [];
  private lastChartSampleSec = -2;
  private alignedSpot = 0;
  private sniperMetrics: SniperMetrics | null = null;

  private chainlinkBySec = new Map<number, number>();
  private officialPrices = new Map<number, { open: number | null; close: number | null }>();
  private officialLastTryMs = new Map<number, number>();
  private chainlinkWs: WebSocket | null = null;
  private binanceWs: WebSocket | null = null;
  private chainlinkLastMsgMs = 0;
  private binanceLastMsgMs = 0;

  constructor(
    dataDir: string,
    private readonly traffic: TrafficCounter = { reqCount: 0, rxBytes: 0, txBytes: 0 }
  ) {
    this.stateFile = path.join(dataDir, 'strategy-state.json');
    this.loadState();
  }

  private async fetchJson(url: string): Promise<unknown> {
    this.traffic.reqCount += 1;
    this.traffic.txBytes += url.length;
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const text = await res.text();
    this.traffic.rxBytes += text.length;
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return JSON.parse(text);
  }

  private wsSend(ws: WebSocket, payload: string): void {
    this.traffic.txBytes += payload.length;
    ws.send(payload);
  }

  // ---------- lifecycle ----------

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.loadInitialKlines();
    this.connectChainlink(0);
    this.connectBinance(0);
    void this.clobLoop();
    this.loopTimer = setInterval(() => this.tick(), 1000);
    this.schedule(() => this.watchFeeds(), 5000);
  }

  stop(): void {
    this.stopped = true;
    if (this.loopTimer) clearInterval(this.loopTimer);
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.chainlinkWs?.close();
    this.binanceWs?.close();
    this.flushStateSync();
  }

  private schedule(fn: () => void, delayMs: number): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (!this.stopped) fn();
    }, delayMs);
    this.timers.add(t);
  }

  private syncedNowMs(): number {
    return Date.now() + this.clockOffsetMs;
  }

  private currentWindowStartSec(nowMs = this.syncedNowMs()): number {
    const nowSec = Math.floor(nowMs / 1000);
    return Math.floor(nowSec / WINDOW_DURATION_SEC) * WINDOW_DURATION_SEC;
  }

  // ---------- public API ----------

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): StrategySnapshot {
    return {
      ...this.buildTickBase(),
      chartSeries: this.chartSeries,
      tradeLedger: this.tradeLedger,
    };
  }

  updateSettings(patch: Partial<StrategySettings>): StrategySettings {
    this.settings = sanitizeSettings(patch, this.settings);
    this.schedulePersist();
    return this.settings;
  }

  manualSnipe(): { ok: boolean; error?: string } {
    const m = this.sniperMetrics;
    if (!m || this.prices.strike <= 0 || this.prices.spot <= 0) {
      return { ok: false, error: '行情尚未就绪' };
    }
    const winStart = this.currentWindowStartSec();
    const ok = this.executeSnipe(m, winStart, this.prices.strike, this.prices.spot);
    return ok ? { ok } : { ok, error: '模拟资金不足' };
  }

  resetLedger(): void {
    this.tradeLedger = [];
    this.bankroll = INITIAL_SIM_BANKROLL;
    this.onLedgerChanged();
  }

  // ---------- persistence ----------

  private loadState(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as Partial<PersistedState>;
      if (Array.isArray(raw.tradeLedger)) this.tradeLedger = raw.tradeLedger.slice(0, MAX_LEDGER_RECORDS);
      if (Number.isFinite(raw.simVirtualBankroll)) this.bankroll = Number(raw.simVirtualBankroll);
      this.settings = sanitizeSettings(raw.settings, DEFAULT_SETTINGS);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        console.error('[strategy] Failed to load state, starting fresh:', err);
      }
    }
  }

  private serializeState(): string {
    const state: PersistedState = {
      version: 1,
      tradeLedger: this.tradeLedger,
      simVirtualBankroll: this.bankroll,
      settings: this.settings,
    };
    return JSON.stringify(state);
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      const tmp = `${this.stateFile}.tmp`;
      fs.promises
        .mkdir(path.dirname(this.stateFile), { recursive: true })
        .then(() => fs.promises.writeFile(tmp, this.serializeState()))
        .then(() => fs.promises.rename(tmp, this.stateFile))
        .catch((err) => console.error('[strategy] Failed to persist state:', err));
    }, PERSIST_DEBOUNCE_MS);
  }

  private flushStateSync(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      const tmp = `${this.stateFile}.tmp`;
      fs.writeFileSync(tmp, this.serializeState());
      fs.renameSync(tmp, this.stateFile);
    } catch (err) {
      console.error('[strategy] Failed to flush state:', err);
    }
  }

  // ---------- market feeds ----------

  private async loadInitialKlines(): Promise<void> {
    try {
      const data = await this.fetchJson(
        'https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=25'
      );
      if (!Array.isArray(data) || this.klines.length > 0) return;
      this.klines = data.map((d: (string | number)[]) => ({
        time: Number(d[0]),
        open: parseFloat(String(d[1])),
        high: parseFloat(String(d[2])),
        low: parseFloat(String(d[3])),
        close: parseFloat(String(d[4])),
      }));
    } catch (err) {
      console.warn('[strategy] Initial klines unavailable:', (err as Error).message);
    }
  }

  private connectChainlink(attempt: number): void {
    if (this.stopped) return;
    this.wsStatus.chainlink = 'connecting';
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let ws: WebSocket;
    try {
      ws = new WebSocket('wss://ws-live-data.polymarket.com');
    } catch {
      this.wsStatus.chainlink = 'disconnected';
      this.schedule(() => this.connectChainlink(attempt + 1), computeReconnectDelayMs(attempt));
      return;
    }
    this.chainlinkWs = ws;
    let opened = false;

    ws.onopen = () => {
      if (this.chainlinkWs !== ws) return;
      opened = true;
      this.chainlinkLastMsgMs = Date.now();
      this.wsStatus.chainlink = 'connected';
      this.wsSend(
        ws,
        JSON.stringify({
          action: 'subscribe',
          subscriptions: [
            { topic: 'crypto_prices_chainlink', type: '*', filters: '{"symbol":"btc/usd"}' },
          ],
        })
      );
      pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) this.wsSend(ws, 'PING');
      }, RTDS_PING_INTERVAL_MS);
    };

    ws.onmessage = (ev) => {
      this.chainlinkLastMsgMs = Date.now();
      if (typeof ev.data === 'string') this.traffic.rxBytes += ev.data.length;
      if (typeof ev.data !== 'string' || ev.data.charCodeAt(0) !== 123) return; // '{'
      try {
        const msg = JSON.parse(ev.data);
        const payload = msg?.payload;
        // Updates carry {timestamp, value}; the connect snapshot carries data[] history.
        const rows: Array<{ timestamp?: number; value?: number }> = Array.isArray(payload?.data)
          ? payload.data
          : payload
          ? [payload]
          : [];
        let latestTs = 0;
        let latestVal = 0;
        for (const row of rows) {
          const ts = Number(row?.timestamp);
          const v = Number(row?.value);
          if (!Number.isFinite(ts) || !Number.isFinite(v) || v <= 0) continue;
          this.recordChainlink(Math.floor(ts / 1000), v);
          if (ts >= latestTs) {
            latestTs = ts;
            latestVal = v;
          }
        }
        const p = latestVal;
        if (!(p > 0)) return;
        const firstRealChainlink = !this.prices.hasRealChainlink;
        this.prices.chainlink = p;
        this.prices.hasRealChainlink = true;
        if (
          this.prices.strike === 0 ||
          (firstRealChainlink && this.prices.strikeBootstrappedFromSpot)
        ) {
          this.prices.strike = p;
          this.prices.strikeBootstrappedFromSpot = false;
          this.prices.needsChartReset = true;
          this.basisRing.idx = 0;
          this.basisRing.count = 0;
          this.basisRing.sum = 0;
        }
      } catch {
        // ignore malformed frames
      }
    };

    ws.onerror = () => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    };

    ws.onclose = () => {
      if (pingTimer) clearInterval(pingTimer);
      if (this.chainlinkWs !== ws || this.stopped) return;
      this.chainlinkWs = null;
      this.wsStatus.chainlink = 'disconnected';
      const nextAttempt = opened ? 0 : attempt + 1;
      this.schedule(() => this.connectChainlink(nextAttempt), computeReconnectDelayMs(nextAttempt));
    };
  }

  private recordChainlink(sec: number, value: number): void {
    this.chainlinkBySec.set(sec, value);
    if (this.chainlinkBySec.size > CHAINLINK_HISTORY_SEC + 60) {
      const cutoff = sec - CHAINLINK_HISTORY_SEC;
      for (const key of this.chainlinkBySec.keys()) {
        if (key < cutoff) this.chainlinkBySec.delete(key);
      }
    }
  }

  private windowOpenPrice(win: number): number | null {
    return (
      this.chainlinkBySec.get(win) ??
      this.officialPrices.get(win)?.open ??
      this.officialPrices.get(win - WINDOW_DURATION_SEC)?.close ??
      null
    );
  }

  private windowClosePrice(win: number): number | null {
    return (
      this.chainlinkBySec.get(win + WINDOW_DURATION_SEC) ??
      this.officialPrices.get(win)?.close ??
      this.officialPrices.get(win + WINDOW_DURATION_SEC)?.open ??
      null
    );
  }

  /** Throttled background fetch of Polymarket's official open/close for a window. */
  private requestOfficialPrices(win: number): void {
    const nowMs = Date.now();
    if (nowMs - (this.officialLastTryMs.get(win) ?? 0) < OFFICIAL_RETRY_MS) return;
    this.officialLastTryMs.set(win, nowMs);
    const iso = (s: number) => new Date(s * 1000).toISOString().replace('.000Z', 'Z');
    const url =
      `https://polymarket.com/api/crypto/crypto-price?symbol=BTC&variant=fiveminute` +
      `&eventStartTime=${iso(win)}&endDate=${iso(win + WINDOW_DURATION_SEC)}`;
    this.fetchJson(url)
      .then((raw) => {
        const data = raw as { openPrice?: unknown; closePrice?: unknown };
        const num = (v: unknown) => (typeof v === 'number' && v > 0 ? v : null);
        this.officialPrices.set(win, { open: num(data.openPrice), close: num(data.closePrice) });
        while (this.officialPrices.size > OFFICIAL_CACHE_MAX) {
          const oldest = this.officialPrices.keys().next().value;
          if (oldest === undefined) break;
          this.officialPrices.delete(oldest);
          this.officialLastTryMs.delete(oldest);
        }
      })
      .catch(() => {
        // retried on a later tick
      });
  }

  private connectBinance(attempt: number): void {
    if (this.stopped) return;
    this.wsStatus.binance = 'connecting';
    let ws: WebSocket;
    try {
      ws = new WebSocket(
        'wss://stream.binance.com:9443/stream?streams=btcusdt@aggTrade/btcusdt@kline_1m'
      );
    } catch {
      this.wsStatus.binance = 'disconnected';
      this.schedule(() => this.connectBinance(attempt + 1), computeReconnectDelayMs(attempt));
      return;
    }
    this.binanceWs = ws;
    let opened = false;

    ws.onopen = () => {
      if (this.binanceWs !== ws) return;
      opened = true;
      this.binanceLastMsgMs = Date.now();
      this.wsStatus.binance = 'connected';
    };

    ws.onmessage = (ev) => {
      this.binanceLastMsgMs = Date.now();
      if (typeof ev.data !== 'string') return;
      this.traffic.rxBytes += ev.data.length;
      try {
        const msg = JSON.parse(ev.data);
        if (msg.stream === 'btcusdt@aggTrade') {
          const d = msg.data;
          const p = parseFloat(d.p);
          if (!Number.isFinite(p) || p <= 0) return;
          this.prices.spot = p;

          const eventMs = Number(d.E);
          if (Number.isFinite(eventMs) && eventMs > 0) {
            const sample = eventMs - Date.now();
            this.clockOffsetMs = this.clockSynced
              ? this.clockOffsetMs + (sample - this.clockOffsetMs) * 0.05
              : sample;
            this.clockSynced = true;
          }

          if (p > this.prices.windowHigh) this.prices.windowHigh = p;
          if (p < this.prices.windowLow) this.prices.windowLow = p;

          if (this.prices.strike === 0) {
            this.prices.strike = this.prices.hasRealChainlink ? this.prices.chainlink : p;
            this.prices.strikeBootstrappedFromSpot = !this.prices.hasRealChainlink;
          }

          pushTradeToRing(this.tradeRing, d.T, parseFloat(d.q), Boolean(d.m));
        } else if (msg.stream === 'btcusdt@kline_1m') {
          const k = msg.data.k;
          const kline: Kline1m = {
            time: k.t,
            open: parseFloat(k.o),
            high: parseFloat(k.h),
            low: parseFloat(k.l),
            close: parseFloat(k.c),
          };
          const arr = this.klines;
          if (arr.length > 0 && arr[arr.length - 1].time === kline.time) {
            arr[arr.length - 1] = kline;
          } else {
            arr.push(kline);
            if (arr.length > MAX_KLINES) arr.shift();
          }
        }
      } catch {
        // ignore malformed frames
      }
    };

    ws.onerror = () => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    };

    ws.onclose = () => {
      if (this.binanceWs !== ws || this.stopped) return;
      this.binanceWs = null;
      this.wsStatus.binance = 'disconnected';
      const nextAttempt = opened ? 0 : attempt + 1;
      this.schedule(() => this.connectBinance(nextAttempt), computeReconnectDelayMs(nextAttempt));
    };
  }

  private watchFeeds(): void {
    const now = Date.now();
    const cl = this.chainlinkWs;
    if (cl?.readyState === WebSocket.OPEN && now - this.chainlinkLastMsgMs > FEED_SILENCE_RECONNECT_MS) {
      console.warn('[strategy] Chainlink feed silent, reconnecting');
      cl.close();
    }
    const bn = this.binanceWs;
    if (bn?.readyState === WebSocket.OPEN && now - this.binanceLastMsgMs > FEED_SILENCE_RECONNECT_MS) {
      console.warn('[strategy] Binance feed silent, reconnecting');
      bn.close();
    }
    this.schedule(() => this.watchFeeds(), 5000);
  }

  private async fetchMarketTokens(winStart: number): Promise<boolean> {
    const slug = `btc-updown-5m-${winStart}`;
    try {
      const evs = (await this.fetchJson(
        `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`
      )) as Array<{ markets?: Array<{ clobTokenIds?: string; question?: string }> }>;
      const m = evs?.[0]?.markets?.[0];
      if (!m?.clobTokenIds) return false;
      const ids = JSON.parse(m.clobTokenIds);
      if (!Array.isArray(ids) || ids.length < 2) return false;
      this.clobTokens = {
        upTokenId: String(ids[0]),
        downTokenId: String(ids[1]),
        windowStartSec: winStart,
      };
      this.activeMarketTitle = String(m.question || `BTC Up or Down (${slug})`);
      return true;
    } catch {
      return false;
    }
  }

  private async fetchClobBook(upTokenId: string, downTokenId: string): Promise<OrderbookSnapshot | null> {
    try {
      type Book = { bids?: Array<{ price: string }>; asks?: Array<{ price: string }> };
      const [upBook, downBook] = (await Promise.all([
        this.fetchJson(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(upTokenId)}`),
        this.fetchJson(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(downTokenId)}`),
      ])) as [Book, Book];
      return buildLiveOrderbook(
        parseBestBidAsk(upBook.bids, upBook.asks),
        parseBestBidAsk(downBook.bids, downBook.asks)
      );
    } catch {
      // fall back to model estimate
    }
    return null;
  }

  private async clobLoop(): Promise<void> {
    if (this.stopped) return;
    try {
      const winStart = this.currentWindowStartSec();
      if (this.clobTokens.windowStartSec !== winStart) {
        this.clobTokens = { upTokenId: '', downTokenId: '', windowStartSec: 0 };
        await this.fetchMarketTokens(winStart);
      }
      const { upTokenId, downTokenId, windowStartSec } = this.clobTokens;
      let live: OrderbookSnapshot | null = null;
      if (upTokenId && downTokenId && windowStartSec === winStart) {
        live = await this.fetchClobBook(upTokenId, downTokenId);
      }
      if (live && this.currentWindowStartSec() === winStart) {
        this.orderbook = live;
        this.orderbookMeta = { windowStartSec: winStart, fetchedAtMs: Date.now() };
        this.wsStatus.polyClob = 'connected';
      } else {
        this.orderbook = { ...this.orderbook, isLiveClob: false };
        this.wsStatus.polyClob = 'disconnected';
      }
    } catch (err) {
      console.error('[strategy] CLOB loop error:', err);
    }
    if (this.stopped) return;
    const nowMs = this.syncedNowMs();
    const remainMs = (this.currentWindowStartSec(nowMs) + WINDOW_DURATION_SEC) * 1000 - nowMs;
    const delayMs = Math.min(
      getClobPollIntervalMs(Math.ceil(remainMs / 1000)),
      Math.max(500, remainMs + 500)
    );
    this.schedule(() => void this.clobLoop(), delayMs);
  }

  // ---------- strategy ----------

  private executeSnipe(
    metrics: SniperMetrics,
    windowStartSec: number,
    activeStrike: number,
    currentSpot: number
  ): boolean {
    if (this.bankroll < BET_UNIT_USD) return false;
    const record = createFiveDollarSnipe(
      metrics,
      formatWindowLabel(windowStartSec),
      activeStrike,
      currentSpot,
      Date.now(),
      windowStartSec
    );
    this.bankroll = Number((this.bankroll - BET_UNIT_USD).toFixed(2));
    this.tradeLedger = [record, ...this.tradeLedger].slice(0, MAX_LEDGER_RECORDS);
    console.log(`[strategy] Snipe ${record.side} @ ${record.entryPriceCents}¢ (${record.windowLabel})`);
    this.onLedgerChanged();
    return true;
  }

  private applyLedger(updated: SimTradeRecord[], cashDelta: number): void {
    if (updated === this.tradeLedger) return;
    this.tradeLedger = updated;
    this.bankroll = Number((this.bankroll + cashDelta).toFixed(2));
    this.onLedgerChanged();
  }

  private onLedgerChanged(): void {
    this.schedulePersist();
    this.emit({
      type: 'ledger',
      data: { tradeLedger: this.tradeLedger, simVirtualBankroll: this.bankroll },
    });
  }

  private emit(event: StrategyEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('[strategy] Listener error:', err);
      }
    }
  }

  private buildTickBase(): Omit<StrategyTick, 'chartPoint' | 'chartReset'> {
    const winStart = this.currentWindowStartSec();
    return {
      serverTimeMs: this.syncedNowMs(),
      wsStatus: { ...this.wsStatus },
      activeMarketTitle: this.activeMarketTitle,
      spotPrice: this.prices.spot,
      alignedSpotPrice: this.alignedSpot,
      strikePrice: this.prices.strike,
      orderbook: this.orderbook,
      sniperMetrics: this.sniperMetrics,
      simVirtualBankroll: this.bankroll,
      settings: this.settings,
      strategyStatus: deriveStrategyRuntimeStatus({
        tradeLedger: this.tradeLedger,
        sniperMetrics: this.sniperMetrics,
        orderbook: this.orderbook,
        autoSimEnabled: this.settings.autoSimEnabled,
        maxEntryCents: this.settings.maxEntryCents,
        minReversalScore: this.settings.minReversalScore,
        alreadyTradedThisWindow: this.tradeLedger.some((t) => t.windowStartSec === winStart),
      }),
    };
  }

  private tick(): void {
    try {
      this.evaluate();
    } catch (err) {
      console.error('[strategy] Tick error:', err);
    }
  }

  private evaluate(): void {
    const now = this.syncedNowMs();
    const nowSec = Math.floor(now / 1000);
    const currentWinStart = this.currentWindowStartSec(now);
    const elapsedSec = nowSec - currentWinStart;
    const remainSec = WINDOW_DURATION_SEC - elapsedSec;
    const prices = this.prices;

    const { spot, chainlink, hasRealChainlink } = prices;
    if (spot === 0) {
      this.emitTick(null, false);
      return;
    }

    let debiasedSpotAsOracle = spot;
    if (hasRealChainlink && chainlink > 0) {
      const ring = this.basisRing;
      const rawBasis = spot - chainlink;
      if (ring.count === BASIS_RING_SIZE) {
        ring.sum -= ring.buf[ring.idx];
      } else {
        ring.count += 1;
      }
      ring.buf[ring.idx] = rawBasis;
      ring.sum += rawBasis;
      ring.idx = (ring.idx + 1) % BASIS_RING_SIZE;
      debiasedSpotAsOracle = spot - ring.sum / ring.count;
    }
    this.alignedSpot = debiasedSpotAsOracle;

    let resetSeries = false;
    if (prices.needsChartReset) {
      prices.needsChartReset = false;
      resetSeries = true;
      this.lastChartSampleSec = -2;
    }

    this.settleDueTrades(nowSec);

    if (prices.windowStartSec !== currentWinStart) {
      // Provisional until the boundary-stamped Chainlink report arrives.
      prices.windowStartSec = currentWinStart;
      prices.strike = hasRealChainlink && chainlink > 0 ? chainlink : spot;
      prices.strikeBootstrappedFromSpot = !hasRealChainlink;
      prices.strikeReliable = false;
      prices.strikeResolved = false;
      prices.windowHigh = spot;
      prices.windowLow = spot;
      resetSeries = true;
      this.lastChartSampleSec = -2;
    }

    if (!prices.strikeResolved) {
      const exactStrike = this.windowOpenPrice(currentWinStart);
      if (exactStrike === null && elapsedSec >= OFFICIAL_PRICE_DELAY_SEC) {
        this.requestOfficialPrices(currentWinStart);
      }
      if (exactStrike !== null) {
        prices.strike = exactStrike;
        prices.strikeBootstrappedFromSpot = false;
        prices.strikeReliable = true;
        prices.strikeResolved = true;
        console.log(`[strategy] Strike ${currentWinStart} = ${exactStrike}`);
        resetSeries = true;
        this.lastChartSampleSec = -2;
      }
    }

    const activeStrike = prices.strike || (hasRealChainlink ? chainlink : spot);
    const atr1m = calcAtr1m(this.klines, 35);
    const tir5s = calcTirFromRing(this.tradeRing, now, 5);
    const tir30s = calcTirFromRing(this.tradeRing, now, 30);

    const effectivePrice = chainlink > 0 ? 0.65 * debiasedSpotAsOracle + 0.35 * chainlink : spot;
    const dollarGap = effectivePrice - activeStrike;

    const clobFresh =
      this.orderbook.isLiveClob &&
      this.orderbookMeta.windowStartSec === currentWinStart &&
      Date.now() - this.orderbookMeta.fetchedAtMs <= CLOB_STALE_MS;
    if (!clobFresh) {
      this.orderbook = estimateBinaryOrderbook(dollarGap, atr1m, remainSec, tir5s);
    }
    const ob = this.orderbook;

    let chartPoint: ChartPoint | null = null;
    if (resetSeries || elapsedSec - this.lastChartSampleSec >= 2) {
      chartPoint = {
        elapsedSec,
        spot: debiasedSpotAsOracle,
        chainlink: chainlink || debiasedSpotAsOracle,
        strike: activeStrike,
        upBid: ob.upBid,
        upAsk: ob.upAsk,
        downBid: ob.downBid,
        downAsk: ob.downAsk,
      };
      this.lastChartSampleSec = elapsedSec;
      const base = resetSeries ? [] : this.chartSeries;
      const next = [...base, chartPoint];
      this.chartSeries = next.length > MAX_CHART_POINTS ? next.slice(-MAX_CHART_POINTS) : next;
    }

    const { autoSimEnabled, maxEntryCents, minReversalScore } = this.settings;
    const metrics = computeSniperMetrics({
      remainSec,
      spot,
      chainlink,
      debiasedSpotAsOracle,
      activeStrike,
      windowHigh: prices.windowHigh,
      windowLow: prices.windowLow,
      atr1m,
      tir5s,
      tir30s,
      orderbook: ob,
      alreadyTradedThisWindow: this.tradeLedger.some((t) => t.windowStartSec === currentWinStart),
      maxEntryCents,
      minReversalScore,
      strikeReliable: prices.strikeReliable,
    });
    this.sniperMetrics = metrics;

    if (autoSimEnabled && metrics.canSnipe) {
      this.executeSnipe(metrics, currentWinStart, activeStrike, spot);
    }

    // Half-position exit only against real CLOB bids, never model estimates.
    if (ob.isLiveClob) {
      const { updatedLedger, cashRecovered } = evaluateStage1FreeRoll(
        this.tradeLedger,
        ob.upBid,
        ob.downBid,
        currentWinStart
      );
      this.applyLedger(updatedLedger, cashRecovered);
    }

    this.emitTick(chartPoint, resetSeries);
  }

  /**
   * Settles each closed window's active trades at its official close price
   * (Chainlink report stamped at the close). Only if neither RTDS nor the
   * official endpoint yields it within SETTLE_GIVE_UP_SEC are they booked
   * conservatively.
   */
  private settleDueTrades(nowSec: number): void {
    const dueWindows = new Set<number>();
    let hasLegacy = false;
    for (const tr of this.tradeLedger) {
      if (tr.status !== 'HOLDING' && tr.status !== 'STAGE1_FREEROLL') continue;
      if (tr.windowStartSec === undefined) hasLegacy = true;
      else if (tr.windowStartSec + WINDOW_DURATION_SEC <= nowSec) dueWindows.add(tr.windowStartSec);
    }
    if (hasLegacy) {
      this.applyLedger(
        expireTradesWhere(this.tradeLedger, (tr) => tr.windowStartSec === undefined, '旧版本遗留持仓'),
        0
      );
    }
    for (const win of dueWindows) {
      const closeSec = win + WINDOW_DURATION_SEC;
      const settlePrice = this.windowClosePrice(win);
      if (settlePrice !== null) {
        const { updatedLedger, cashSettled } = settleExpiredTrades(this.tradeLedger, settlePrice, win);
        this.applyLedger(updatedLedger, cashSettled);
      } else if (nowSec - closeSec > SETTLE_GIVE_UP_SEC) {
        this.applyLedger(
          expireTradesWhere(this.tradeLedger, (tr) => tr.windowStartSec === win, '未取得官方收盘价'),
          0
        );
      } else if (nowSec - closeSec >= OFFICIAL_PRICE_DELAY_SEC) {
        this.requestOfficialPrices(win);
      }
    }
  }

  private emitTick(chartPoint: ChartPoint | null, chartReset: boolean): void {
    if (this.listeners.size === 0) return;
    this.emit({ type: 'tick', data: { ...this.buildTickBase(), chartPoint, chartReset } });
  }
}
