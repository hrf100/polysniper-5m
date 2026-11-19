import type {
  Kline1m,
  OrderbookSnapshot,
  SimTradeRecord,
  SniperMetrics,
  StrategyRuntimeStatus,
  TradeTick,
} from '../types/sniper';

export const WINDOW_DURATION_SEC = 300;
export const BET_UNIT_USD = 5.0;
export const INITIAL_SIM_BANKROLL = 100.0;

/**
 * Standard normal CDF approximation for binary option pricing.
 */
export function normCDF(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const prob =
    d *
    t *
    (0.3193815 +
      t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - prob : prob;
}

export function calcAtr1m(klines: Kline1m[], fallback = 35): number {
  if (klines.length < 5) return fallback;
  const recent = klines.slice(-10);
  const total = recent.reduce((acc, k) => acc + Math.max(k.high - k.low, 8), 0);
  return total / recent.length;
}

export const TRADE_RING_SIZE = 60;
export const CLOB_SNIPER_POLL_MS = 1000;
export const CLOB_IDLE_POLL_MS = 1000;

export interface TradeBucketRing {
  secEpochs: Float64Array;
  buyVols: Float64Array;
  sellVols: Float64Array;
}

export function createTradeBucketRing(): TradeBucketRing {
  return {
    secEpochs: new Float64Array(TRADE_RING_SIZE),
    buyVols: new Float64Array(TRADE_RING_SIZE),
    sellVols: new Float64Array(TRADE_RING_SIZE),
  };
}

export function pushTradeToRing(
  ring: TradeBucketRing,
  timeMs: number,
  qty: number,
  isBuyerMaker: boolean
): void {
  if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(timeMs)) return;
  const sec = Math.floor(timeMs / 1000);
  const idx = ((sec % TRADE_RING_SIZE) + TRADE_RING_SIZE) % TRADE_RING_SIZE;
  if (ring.secEpochs[idx] !== sec) {
    ring.secEpochs[idx] = sec;
    ring.buyVols[idx] = 0;
    ring.sellVols[idx] = 0;
  }
  if (isBuyerMaker) {
    ring.sellVols[idx] += qty;
  } else {
    ring.buyVols[idx] += qty;
  }
}

export function calcTirFromRing(
  ring: TradeBucketRing,
  nowMs: number,
  windowSec: number
): number {
  const nowSec = Math.floor(nowMs / 1000);
  const clampedWindow = Math.max(1, Math.min(TRADE_RING_SIZE, Math.floor(windowSec)));
  const minSec = nowSec - clampedWindow + 1;
  const expiryCutoff = nowSec - TRADE_RING_SIZE;
  let buy = 0;
  let sell = 0;

  for (let i = 0; i < TRADE_RING_SIZE; i++) {
    const bucketSec = ring.secEpochs[i];
    if (bucketSec >= minSec && bucketSec <= nowSec) {
      buy += ring.buyVols[i];
      sell += ring.sellVols[i];
    } else if (bucketSec > 0 && bucketSec <= expiryCutoff) {
      // Clear expired bucket in-place to avoid stale accumulation across wraps
      ring.secEpochs[i] = 0;
      ring.buyVols[i] = 0;
      ring.sellVols[i] = 0;
    }
  }
  return buy + sell > 0.001 ? (buy - sell) / (buy + sell) : 0;
}

export function getClobPollIntervalMs(remainSec: number): number {
  return remainSec >= 65 && remainSec <= 245
    ? CLOB_SNIPER_POLL_MS
    : CLOB_IDLE_POLL_MS;
}

export function computeReconnectDelayMs(
  attempt: number,
  baseMs = 1000,
  maxMs = 30000
): number {
  const safeAttempt = Math.max(0, Math.floor(attempt));
  return Math.min(maxMs, baseMs * Math.pow(2, safeAttempt));
}

export function calcTIR(trades: TradeTick[], sinceMs: number): number {
  let buy = 0;
  let sell = 0;
  for (const t of trades) {
    if (t.time >= sinceMs) {
      if (t.isBuyerMaker) sell += t.qty;
      else buy += t.qty;
    }
  }
  return buy + sell > 0.001 ? (buy - sell) / (buy + sell) : 0;
}

export function estimateBinaryOrderbook(
  dollarGap: number,
  atr1m: number,
  remainSec: number,
  tir5s: number
): OrderbookSnapshot {
  const timeFactor = Math.sqrt(Math.max(remainSec, 4) / 60);
  const denom = Math.max(atr1m * 0.85 * timeFactor, 1e-6);
  const signedZ = dollarGap / denom;
  const fairProbUp = normCDF(signedZ + tir5s * 0.18);
  const upMid = Math.max(2, Math.min(98, Math.round(fairProbUp * 100)));
  const downMid = 100 - upMid;

  return {
    upBid: Math.max(1, upMid - 1),
    upAsk: Math.min(99, upMid + 1),
    downBid: Math.max(1, downMid - 1),
    downAsk: Math.min(99, downMid + 1),
    isLiveClob: false,
  };
}

export interface ComputeSniperParams {
  remainSec: number;
  spot: number;
  chainlink: number;
  debiasedSpotAsOracle: number;
  activeStrike: number;
  windowHigh: number;
  windowLow: number;
  atr1m: number;
  tir5s: number;
  tir30s: number;
  orderbook: OrderbookSnapshot;
  alreadyTradedThisWindow: boolean;
  maxEntryCents: number;
  minReversalScore: number;
  strikeReliable?: boolean;
}

export function computeSniperMetrics(params: ComputeSniperParams): SniperMetrics {
  const {
    remainSec,
    spot,
    chainlink,
    debiasedSpotAsOracle,
    activeStrike,
    windowHigh,
    windowLow,
    atr1m,
    tir5s,
    tir30s,
    orderbook,
    alreadyTradedThisWindow,
    maxEntryCents,
    minReversalScore,
    strikeReliable = true,
  } = params;

  const effectivePrice =
    chainlink > 0 ? 0.65 * debiasedSpotAsOracle + 0.35 * chainlink : spot;
  const dollarGap = effectivePrice - activeStrike;
  const oracleGap = (chainlink || spot) - activeStrike;
  const timeFactor = Math.sqrt(Math.max(remainSec, 4) / 60);

  const targetSide: 'UP' | 'DOWN' = orderbook.upAsk <= orderbook.downAsk ? 'UP' : 'DOWN';
  const targetAskCents = targetSide === 'UP' ? orderbook.upAsk : orderbook.downAsk;
  const targetBidCents = targetSide === 'UP' ? orderbook.upBid : orderbook.downBid;
  const normalizedGapR = Math.abs(dollarGap) / Math.max(atr1m * timeFactor, 1e-6);

  const bounceFromExtreme =
    targetSide === 'UP'
      ? Math.max(0, spot - windowLow)
      : Math.max(0, windowHigh - spot);

  const oracleCushionAdvantage = Math.max(
    0,
    Math.abs(dollarGap) - Math.abs(oracleGap)
  );

  // (A) Time & R_gap score (0-30)
  let timeGapScore = 0;
  if (remainSec >= 70 && remainSec <= 240) {
    timeGapScore += 15;
    if (normalizedGapR >= 0.65 && normalizedGapR <= 1.65) timeGapScore += 15;
    else if (normalizedGapR <= 2.0) timeGapScore += 7;
  }

  // (B) 5s order flow reversal score (0-35)
  const directionalTIR5s = targetSide === 'UP' ? tir5s : -tir5s;
  const orderFlowReversalScore = Math.max(
    0,
    Math.min(35, Math.round((directionalTIR5s + 0.15) * 55))
  );

  // (C) Pin-bar bounce from window extreme (0-20)
  const bounceRatio = bounceFromExtreme / Math.max(atr1m, 10);
  const wickBounceScore = Math.max(
    0,
    Math.min(20, Math.round(bounceRatio * 45))
  );

  // (D) Chainlink oracle lag cushion (0-15)
  const oracleCushionScore = Math.max(
    0,
    Math.min(15, Math.round((oracleCushionAdvantage / Math.max(atr1m, 10)) * 35))
  );

  const reversalScore = Math.min(
    99,
    timeGapScore + orderFlowReversalScore + wickBounceScore + oracleCushionScore
  );

  // Model-estimated quotes are not fillable prices; never auto-fill against them.
  const canSnipe =
    orderbook.isLiveClob &&
    strikeReliable &&
    !alreadyTradedThisWindow &&
    remainSec >= 65 &&
    remainSec <= 245 &&
    targetAskCents >= 2 &&
    targetAskCents <= maxEntryCents &&
    reversalScore >= minReversalScore;

  const triggerReason = `5s订单流反转: ${(directionalTIR5s * 100).toFixed(0)}% · 极值收回: $${bounceFromExtreme.toFixed(1)} · 标准化差值 R: ${normalizedGapR.toFixed(2)}`;

  return {
    remainSec,
    targetSide,
    targetAskCents,
    targetBidCents,
    dollarGap,
    oracleGap,
    atr1m,
    normalizedGapR,
    tir5s,
    tir30s,
    bounceFromExtreme,
    oracleCushionAdvantage,
    timeGapScore,
    orderFlowReversalScore,
    wickBounceScore,
    oracleCushionScore,
    reversalScore,
    strikeReliable,
    canSnipe,
    triggerReason,
  };
}

let displayTimeZone: string | undefined;

/** Labels are rendered on the server, whose local zone may differ from the viewer's. */
export function setDisplayTimeZone(timeZone: string | undefined): void {
  displayTimeZone = timeZone || undefined;
}

function formatClockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false, timeZone: displayTimeZone });
}

export function formatWindowLabel(winStartSec: number): string {
  const start = formatClockTime(winStartSec * 1000);
  const end = formatClockTime((winStartSec + WINDOW_DURATION_SEC) * 1000);
  return `${start} - ${end}`;
}

/** Polymarket quotes down to 0.1¢ ticks (e.g. 0.001 / 0.999); keep that precision. */
export function toQuoteCents(price: number): number {
  return Math.round(price * 1000) / 10;
}

/** Stage 1 half-position exit bid: 2.5x entry, at least 18¢, on the 0.1¢ grid. */
export function stage1TriggerCents(entryPriceCents: number): number {
  // Epsilon guards binary float error (7.3 * 25 = 182.49999…) at .5 boundaries.
  return Math.max(18, Math.round(entryPriceCents * 25 + 1e-9) / 10);
}

export function parseBestBidAsk(
  bids: Array<{ price: string }> | undefined,
  asks: Array<{ price: string }> | undefined
): { bestBid: number; bestAsk: number } {
  let bestBid = 0;
  if (Array.isArray(bids) && bids.length > 0) {
    let maxBid = 0;
    for (const b of bids) {
      const p = parseFloat(b.price);
      if (Number.isFinite(p) && p > maxBid) maxBid = p;
    }
    if (maxBid > 0) bestBid = toQuoteCents(maxBid);
  }

  let bestAsk = 0;
  if (Array.isArray(asks) && asks.length > 0) {
    let minAsk = Infinity;
    for (const a of asks) {
      const p = parseFloat(a.price);
      if (Number.isFinite(p) && p > 0 && p < minAsk) minAsk = p;
    }
    if (Number.isFinite(minAsk)) bestAsk = toQuoteCents(minAsk);
  }

  return { bestBid, bestAsk };
}

/**
 * Near resolution the near-certain side often has no sellers at all. Treat a
 * missing ask as 100¢ (not buyable) so the underdog's real ask still counts as
 * a live quote; only when neither side has an ask is the book unusable.
 */
export function buildLiveOrderbook(
  up: { bestBid: number; bestAsk: number },
  down: { bestBid: number; bestAsk: number }
): OrderbookSnapshot | null {
  if (up.bestAsk <= 0 && down.bestAsk <= 0) return null;
  return {
    upBid: up.bestBid,
    upAsk: up.bestAsk > 0 ? up.bestAsk : 100,
    downBid: down.bestBid,
    downAsk: down.bestAsk > 0 ? down.bestAsk : 100,
    isLiveClob: true,
  };
}

export function createFiveDollarSnipe(
  metrics: SniperMetrics,
  windowLabel: string,
  activeStrike: number,
  currentSpot: number,
  nowMs = Date.now(),
  windowStartSec?: number
): SimTradeRecord {
  const betUsd = BET_UNIT_USD;
  const entryCents = Math.max(2, metrics.targetAskCents);
  const shares = Number(((betUsd * 100) / entryCents).toFixed(2));

  return {
    id: `SNIPE-${nowMs}-${Math.floor(Math.random() * 1000)}`,
    windowLabel,
    windowStartSec,
    entryTime: formatClockTime(nowMs),
    side: metrics.targetSide,
    entryPriceCents: entryCents,
    betAmountUsd: betUsd,
    initialShares: shares,
    remainingShares: shares,
    strikePrice: activeStrike,
    entrySpotPrice: currentSpot,
    reversalScoreAtEntry: metrics.reversalScore,
    stage1Triggered: false,
    stage1PayoutUsd: 0,
    settlementPrice: null,
    finalPayoutUsd: 0,
    netPnL: -betUsd,
    status: 'HOLDING',
    notes: `以 ${entryCents}¢ 狙击买入 ${shares} 份 ${metrics.targetSide} (${metrics.triggerReason})`,
  };
}

export function evaluateStage1FreeRoll(
  ledger: SimTradeRecord[],
  upBid: number,
  downBid: number,
  windowStartSec?: number
): { updatedLedger: SimTradeRecord[]; cashRecovered: number } {
  let cashRecovered = 0;
  let changed = false;

  const updatedLedger = ledger.map((tr) => {
    if (tr.status !== 'HOLDING') return tr;
    // Quotes belong to one market; never apply them to another window's position.
    if (windowStartSec !== undefined && tr.windowStartSec !== windowStartSec) return tr;
    const currentSideBidCents = tr.side === 'UP' ? upBid : downBid;
    const targetBidTrigger = stage1TriggerCents(tr.entryPriceCents);

    if (currentSideBidCents >= targetBidTrigger) {
      changed = true;
      const halfShares = Number((tr.initialShares / 2).toFixed(2));
      const payoutUsd = Number(((halfShares * currentSideBidCents) / 100).toFixed(2));
      cashRecovered = Number((cashRecovered + payoutUsd).toFixed(2));
      const remainingShares = Number((tr.initialShares - halfShares).toFixed(2));
      const currentNetPnL = Number((payoutUsd - tr.betAmountUsd).toFixed(2));

      return {
        ...tr,
        remainingShares,
        stage1Triggered: true,
        stage1PayoutUsd: payoutUsd,
        finalPayoutUsd: payoutUsd,
        netPnL: currentNetPnL,
        status: 'STAGE1_FREEROLL' as const,
        notes: `盘中反弹至 ${currentSideBidCents}¢，已平半仓收回 $${payoutUsd.toFixed(2)}，余下半仓零风险博 $1.00 结算`,
      };
    }
    return tr;
  });

  return { updatedLedger: changed ? updatedLedger : ledger, cashRecovered };
}

function isActiveTrade(tr: SimTradeRecord): boolean {
  return tr.status === 'HOLDING' || tr.status === 'STAGE1_FREEROLL';
}

function markTradeUnsettleable(tr: SimTradeRecord, reason: string): SimTradeRecord {
  return {
    ...tr,
    settlementPrice: null,
    finalPayoutUsd: tr.stage1PayoutUsd,
    netPnL: Number((tr.stage1PayoutUsd - tr.betAmountUsd).toFixed(2)),
    status: tr.stage1Triggered ? 'FREEROLL_EXPIRED' : 'LOSS_STOPPED',
    notes: `${reason}，无法确认结算价，按未翻转保守记账`,
  };
}

/**
 * Settles active trades belonging to `settledWindowStartSec` against each
 * trade's own strike; trades of other windows are left untouched.
 * Omitting `settledWindowStartSec` settles every active trade.
 */
export function settleExpiredTrades(
  ledger: SimTradeRecord[],
  settlePrice: number,
  settledWindowStartSec?: number
): { updatedLedger: SimTradeRecord[]; cashSettled: number } {
  let cashSettled = 0;
  let changed = false;

  const updatedLedger = ledger.map((tr) => {
    if (!isActiveTrade(tr)) return tr;
    if (settledWindowStartSec !== undefined && tr.windowStartSec !== settledWindowStartSec) {
      return tr;
    }
    changed = true;
    const actualWinner: 'UP' | 'DOWN' = settlePrice >= tr.strikePrice ? 'UP' : 'DOWN';
    const prevStrike = tr.strikePrice;
    const isWin = tr.side === actualWinner;
    const finalSettlementPayout = isWin ? tr.remainingShares * 1.0 : 0;
    cashSettled = Number((cashSettled + finalSettlementPayout).toFixed(2));

    const totalPayout = Number((tr.stage1PayoutUsd + finalSettlementPayout).toFixed(2));
    const netPnL = Number((totalPayout - tr.betAmountUsd).toFixed(2));

    return {
      ...tr,
      settlementPrice: settlePrice,
      finalPayoutUsd: totalPayout,
      netPnL,
      status: isWin
        ? ('WON_FULL' as const)
        : tr.stage1Triggered
        ? ('FREEROLL_EXPIRED' as const)
        : ('LOSS_STOPPED' as const),
      notes: isWin
        ? `绝地翻盘成功，收盘 $${settlePrice.toFixed(2)} 跨越 Strike ($${prevStrike.toFixed(2)})，尾仓按 $1.00 结算`
        : tr.stage1Triggered
        ? `尾盘未过 Strike ($${settlePrice.toFixed(2)})，第1阶段翻倍抽本已锁定净盈亏 ${netPnL >= 0 ? '+' : ''}$${netPnL.toFixed(2)}`
        : `未能翻转，收盘 $${settlePrice.toFixed(2)} 低于目标阈值`,
    };
  });

  return { updatedLedger: changed ? updatedLedger : ledger, cashSettled };
}

/** Books matching active trades as not reversed when no settlement price can be found. */
export function expireTradesWhere(
  ledger: SimTradeRecord[],
  shouldExpire: (tr: SimTradeRecord) => boolean,
  reason: string
): SimTradeRecord[] {
  let changed = false;
  const updatedLedger = ledger.map((tr) => {
    if (!isActiveTrade(tr) || !shouldExpire(tr)) return tr;
    changed = true;
    return markTradeUnsettleable(tr, reason);
  });
  return changed ? updatedLedger : ledger;
}

/** Expires every active trade not belonging to `currentWindowStartSec`. */
export function expireOrphanTrades(
  ledger: SimTradeRecord[],
  currentWindowStartSec: number
): SimTradeRecord[] {
  return expireTradesWhere(
    ledger,
    (tr) => tr.windowStartSec !== currentWindowStartSec,
    '服务离线期间该周期已到期'
  );
}

export interface StrategyStatusParams {
  tradeLedger: SimTradeRecord[];
  sniperMetrics: SniperMetrics | null;
  orderbook: OrderbookSnapshot;
  autoSimEnabled: boolean;
  maxEntryCents: number;
  minReversalScore: number;
  alreadyTradedThisWindow: boolean;
}

export function deriveStrategyRuntimeStatus(
  params: StrategyStatusParams
): StrategyRuntimeStatus {
  const {
    tradeLedger,
    sniperMetrics,
    orderbook,
    autoSimEnabled,
    maxEntryCents,
    minReversalScore,
    alreadyTradedThisWindow,
  } = params;

  const activeHolding = tradeLedger.find((t) => t.status === 'HOLDING');
  const activeFreeroll = tradeLedger.find((t) => t.status === 'STAGE1_FREEROLL');
  const activeHoldCount = tradeLedger.filter(
    (t) => t.status === 'HOLDING' || t.status === 'STAGE1_FREEROLL'
  ).length;

  const settledTrades = tradeLedger.filter(
    (t) =>
      t.status === 'WON_FULL' ||
      t.status === 'FREEROLL_EXPIRED' ||
      t.status === 'LOSS_STOPPED'
  );
  const settledProfitable = settledTrades.filter((t) => t.netPnL > 0).length;
  const winRatePct =
    settledTrades.length > 0
      ? Math.round((settledProfitable / settledTrades.length) * 100)
      : null;

  if (activeHolding) {
    const currentBid =
      activeHolding.side === 'UP' ? orderbook.upBid : orderbook.downBid;
    const triggerBid = stage1TriggerCents(activeHolding.entryPriceCents);
    return {
      phaseLabel: `持仓监控中 · 等待 2.5x 半仓抽本`,
      detailText: `${activeHolding.side} ${activeHolding.entryPriceCents}¢ 建仓 · 买一 ${currentBid}¢ / 目标 ${triggerBid}¢ · 持仓 ${activeHoldCount} 笔`,
      tone: 'amber',
      activeHoldCount,
      winRatePct,
    };
  }

  if (activeFreeroll) {
    const currentBid =
      activeFreeroll.side === 'UP' ? orderbook.upBid : orderbook.downBid;
    return {
      phaseLabel: `半仓抽本已锁定 · 零风险博弈结算`,
      detailText: `${activeFreeroll.side} 已收回 $${activeFreeroll.stage1PayoutUsd.toFixed(
        2
      )} · 剩余 ${activeFreeroll.remainingShares} 份 (现买一 ${currentBid}¢)`,
      tone: 'indigo',
      activeHoldCount,
      winRatePct,
    };
  }

  if (!sniperMetrics) {
    return {
      phaseLabel: `等待实盘行情接入`,
      detailText: `实盘数据 · 自动模拟下单${autoSimEnabled ? '已开启' : '已暂停'}`,
      tone: 'slate',
      activeHoldCount,
      winRatePct,
    };
  }

  if (!autoSimEnabled) {
    return {
      phaseLabel: `自动狙击已暂停 (仅手动)`,
      detailText: `当前劣势方 ${sniperMetrics.targetSide} ${sniperMetrics.targetAskCents}¢ · 翻转分 ${sniperMetrics.reversalScore}/${minReversalScore}`,
      tone: 'slate',
      activeHoldCount,
      winRatePct,
    };
  }

  if (alreadyTradedThisWindow) {
    return {
      phaseLabel: `本周期已完成狙击 · 冷却中`,
      detailText: `单盘限额 1 笔 · 剩余 ${sniperMetrics.remainSec}s 进入下个 5m 周期`,
      tone: 'indigo',
      activeHoldCount,
      winRatePct,
    };
  }

  if (!sniperMetrics.strikeReliable) {
    return {
      phaseLabel: `等待本周期开盘价确认`,
      detailText: `尚未取得官方 Strike（Chainlink 开盘秒报价），确认前不自动狙击 · 剩余 ${sniperMetrics.remainSec}s`,
      tone: 'slate',
      activeHoldCount,
      winRatePct,
    };
  }

  if (sniperMetrics.remainSec < 65 || sniperMetrics.remainSec > 245) {
    return {
      phaseLabel: `观察期 · 等待 65s–245s 狙击窗`,
      detailText: `当前剩余 ${sniperMetrics.remainSec}s · ${sniperMetrics.targetSide} 卖一 ${sniperMetrics.targetAskCents}¢`,
      tone: 'slate',
      activeHoldCount,
      winRatePct,
    };
  }

  if (sniperMetrics.canSnipe) {
    return {
      phaseLabel: `触发条件达成 · 执行 $5.00 狙击`,
      detailText: `${sniperMetrics.targetSide} ${sniperMetrics.targetAskCents}¢ ≤ ${maxEntryCents}¢ · 翻转分 ${sniperMetrics.reversalScore} ≥ ${minReversalScore}`,
      tone: 'emerald',
      activeHoldCount,
      winRatePct,
    };
  }

  if (sniperMetrics.targetAskCents > maxEntryCents) {
    return {
      phaseLabel: `扫描监控中 · 等待跌入 ≤${maxEntryCents}¢`,
      detailText: `劣势方 ${sniperMetrics.targetSide} ${sniperMetrics.targetAskCents}¢ · 翻转分 ${sniperMetrics.reversalScore}/${minReversalScore}`,
      tone: 'amber',
      activeHoldCount,
      winRatePct,
    };
  }

  if (!orderbook.isLiveClob) {
    return {
      phaseLabel: `CLOB 实盘报价不可用 · 暂停自动狙击`,
      detailText: `当前为模型估算报价 ${sniperMetrics.targetSide} ${sniperMetrics.targetAskCents}¢，不作为成交价`,
      tone: 'slate',
      activeHoldCount,
      winRatePct,
    };
  }

  return {
    phaseLabel: `价格已入狙击带 · 等待翻转分达标`,
    detailText: `${sniperMetrics.targetSide} ${sniperMetrics.targetAskCents}¢ ≤ ${maxEntryCents}¢ · 翻转分 ${sniperMetrics.reversalScore}/${minReversalScore}`,
    tone: 'emerald',
    activeHoldCount,
    winRatePct,
  };
}

export function formatBytes(bytes: number): string {
  const safe = Math.max(0, Number.isFinite(bytes) ? bytes : 0);
  if (safe < 1024) return `${Math.round(safe)} B`;
  if (safe < 1024 * 1024) return `${(safe / 1024).toFixed(1)} KB`;
  if (safe < 1024 * 1024 * 1024) return `${(safe / (1024 * 1024)).toFixed(2)} MB`;
  return `${(safe / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatByteRate(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

export function formatMemoryMb(mb: number): string {
  const safe = Math.max(0, Number.isFinite(mb) ? mb : 0);
  if (safe >= 1024) return `${(safe / 1024).toFixed(2)} GB`;
  return `${safe.toFixed(safe >= 100 ? 0 : 1)} MB`;
}

/**
 * Extracts a compact market window badge (e.g. "5:45–5:50 ET") from a full
 * Polymarket market title such as "Bitcoin Up or Down - November 18, 5:45PM-5:50PM ET".
 */
export function extractMarketWindowBadge(title: string): string {
  const match = title.match(
    /(\d{1,2}:\d{2})\s*(?:AM|PM)?\s*[-–]\s*(\d{1,2}:\d{2})\s*(?:AM|PM)?(?:\s*(ET|UTC|EST|EDT))?/i
  );
  if (!match) return '5m 实时盘';
  const tz = match[3] ? ` ${match[3].toUpperCase()}` : '';
  return `${match[1]}–${match[2]}${tz}`;
}


