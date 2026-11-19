import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calcAtr1m,
  calcTIR,
  calcTirFromRing,
  computeReconnectDelayMs,
  computeSniperMetrics,
  createFiveDollarSnipe,
  createTradeBucketRing,
  deriveStrategyRuntimeStatus,
  estimateBinaryOrderbook,
  evaluateStage1FreeRoll,
  extractMarketWindowBadge,
  formatByteRate,
  formatBytes,
  formatMemoryMb,
  getClobPollIntervalMs,
  normCDF,
  expireOrphanTrades,
  expireTradesWhere,
  buildLiveOrderbook,
  parseBestBidAsk,
  pushTradeToRing,
  settleExpiredTrades,
  stage1TriggerCents,
  TRADE_RING_SIZE,
} from './sniperEngine';
import type { Kline1m, TradeTick } from '../types/sniper';

test('normCDF returns 0.5 at 0 and bounds probabilities cleanly', () => {
  assert.ok(Math.abs(normCDF(0) - 0.5) < 1e-5);
  assert.ok(normCDF(3) > 0.99);
  assert.ok(normCDF(-3) < 0.01);
});

test('calcAtr1m computes average high-low range over trailing 10 klines', () => {
  const klines: Kline1m[] = Array.from({ length: 12 }, (_, idx) => ({
    time: idx * 60000,
    open: 90000,
    high: 90040,
    low: 90000,
    close: 90020,
  }));
  assert.equal(calcAtr1m(klines), 40);
  assert.equal(calcAtr1m(klines.slice(0, 3), 35), 35);
});

test('calcTIR calculates directional taker imbalance correctly', () => {
  const now = 1_700_000_000_000;
  const ticks: TradeTick[] = [
    { time: now - 2000, price: 90000, qty: 3, isBuyerMaker: false }, // taker buy 3
    { time: now - 1000, price: 90005, qty: 1, isBuyerMaker: true }, // taker sell 1
    { time: now - 10000, price: 89900, qty: 10, isBuyerMaker: true }, // outside window
  ];
  const tir = calcTIR(ticks, now - 5000);
  assert.equal(tir, 0.5);
});

test('estimateBinaryOrderbook keeps up + down mid equal to 100 cents', () => {
  const ob = estimateBinaryOrderbook(-70, 35, 160, 0.2);
  assert.ok(ob.upAsk <= 15);
  assert.ok(ob.downBid >= 84);
  assert.equal(ob.isLiveClob, false);
});

test('computeSniperMetrics triggers canSnipe on strong reversal signal <=10c', () => {
  const metrics = computeSniperMetrics({
    remainSec: 180,
    spot: 89945,
    chainlink: 89960,
    debiasedSpotAsOracle: 89945,
    activeStrike: 90000,
    windowHigh: 90010,
    windowLow: 89910,
    atr1m: 38,
    tir5s: 0.6,
    tir30s: 0.2,
    orderbook: { upBid: 6, upAsk: 8, downBid: 91, downAsk: 93, isLiveClob: true },
    alreadyTradedThisWindow: false,
    maxEntryCents: 10,
    minReversalScore: 62,
  });

  assert.equal(metrics.targetSide, 'UP');
  assert.equal(metrics.targetAskCents, 8);
  assert.ok(metrics.reversalScore >= 62);
  assert.equal(metrics.canSnipe, true);
});

test('two-stage Free-Roll and settlement compute exact PnL without double counting', () => {
  const metrics = computeSniperMetrics({
    remainSec: 180,
    spot: 89945,
    chainlink: 89960,
    debiasedSpotAsOracle: 89945,
    activeStrike: 90000,
    windowHigh: 90010,
    windowLow: 89910,
    atr1m: 38,
    tir5s: 0.6,
    tir30s: 0.2,
    orderbook: { upBid: 6, upAsk: 8, downBid: 91, downAsk: 93, isLiveClob: true },
    alreadyTradedThisWindow: false,
    maxEntryCents: 10,
    minReversalScore: 62,
  });

  const trade = createFiveDollarSnipe(metrics, '12:00:00 - 12:05:00', 90000, 89945, 1_700_000_000_000);
  assert.equal(trade.initialShares, 62.5);
  assert.equal(trade.betAmountUsd, 5.0);

  // Trigger Stage 1 at 20 cents (>= 8 * 2.5 = 20)
  const { updatedLedger: afterStage1, cashRecovered } = evaluateStage1FreeRoll([trade], 20, 80);
  assert.equal(cashRecovered, 6.25); // 31.25 shares * $0.20 = $6.25
  assert.equal(afterStage1[0].status, 'STAGE1_FREEROLL');
  assert.equal(afterStage1[0].remainingShares, 31.25);

  // Win settlement at 90025 (>= 90000 strike)
  const { updatedLedger: afterWin, cashSettled } = settleExpiredTrades(afterStage1, 90025);
  assert.equal(cashSettled, 31.25);
  assert.equal(afterWin[0].status, 'WON_FULL');
  assert.equal(afterWin[0].finalPayoutUsd, 37.5);
  assert.equal(afterWin[0].netPnL, 32.5);

  // Alternative: Freeroll expired OTM at 89990 (< 90000 strike) -> still net profit +$1.25!
  const { updatedLedger: afterExpire, cashSettled: zeroSettle } = settleExpiredTrades(
    afterStage1,
    89990
  );
  assert.equal(zeroSettle, 0);
  assert.equal(afterExpire[0].status, 'FREEROLL_EXPIRED');
  assert.equal(afterExpire[0].netPnL, 1.25);
});

test('parseBestBidAsk extracts highest bid and lowest ask from Polymarket CLOB book arrays', () => {
  const bids = [{ price: '0.01' }, { price: '0.12' }, { price: '0.43' }];
  const asks = [{ price: '0.99' }, { price: '0.88' }, { price: '0.45' }];
  const { bestBid, bestAsk } = parseBestBidAsk(bids, asks);
  assert.equal(bestBid, 43);
  assert.equal(bestAsk, 45);

  // 0.1¢ ticks are preserved
  const extreme = parseBestBidAsk([{ price: '0.999' }], [{ price: '0.001' }]);
  assert.equal(extreme.bestBid, 99.9);
  assert.equal(extreme.bestAsk, 0.1);
  const fractional = parseBestBidAsk([{ price: '0.065' }], [{ price: '0.073' }]);
  assert.equal(fractional.bestBid, 6.5);
  assert.equal(fractional.bestAsk, 7.3);
  assert.deepEqual(parseBestBidAsk([], undefined), { bestBid: 0, bestAsk: 0 });
});

test('buildLiveOrderbook keeps underdog ask live when the favourite has no sellers', () => {
  const ob = buildLiveOrderbook({ bestBid: 0, bestAsk: 7 }, { bestBid: 93, bestAsk: 0 });
  assert.deepEqual(ob, { upBid: 0, upAsk: 7, downBid: 93, downAsk: 100, isLiveClob: true });

  const normal = buildLiveOrderbook({ bestBid: 68, bestAsk: 69 }, { bestBid: 31, bestAsk: 32 });
  assert.deepEqual(normal, { upBid: 68, upAsk: 69, downBid: 31, downAsk: 32, isLiveClob: true });

  assert.equal(buildLiveOrderbook({ bestBid: 50, bestAsk: 0 }, { bestBid: 50, bestAsk: 0 }), null);
});

test('fractional-cent entry: shares, 2.5x trigger, and Stage 1 payout stay exact', () => {
  assert.equal(stage1TriggerCents(7.3), 18.3);
  assert.equal(stage1TriggerCents(3.1), 18);

  const metrics = computeSniperMetrics({
    ...strongSignalParams,
    orderbook: { upBid: 6.5, upAsk: 7.3, downBid: 92.7, downAsk: 93.5, isLiveClob: true },
  });
  assert.equal(metrics.canSnipe, true);
  const trade = createFiveDollarSnipe(metrics, 'A', 90000, 89945, 1, 1_700_000_100);
  assert.equal(trade.entryPriceCents, 7.3);
  assert.equal(trade.initialShares, 68.49);

  assert.equal(evaluateStage1FreeRoll([trade], 18.2, 81).updatedLedger[0].status, 'HOLDING');
  const { updatedLedger, cashRecovered } = evaluateStage1FreeRoll([trade], 18.3, 81);
  assert.equal(updatedLedger[0].status, 'STAGE1_FREEROLL');
  assert.equal(cashRecovered, 6.27);
});

test('deriveStrategyRuntimeStatus reports active HOLDING, STAGE1_FREEROLL, scanning, and paused states', () => {
  const baseOrderbook = { upBid: 12, upAsk: 14, downBid: 85, downAsk: 87, isLiveClob: false };
  const sampleMetrics = computeSniperMetrics({
    remainSec: 150,
    spot: 89960,
    chainlink: 89965,
    debiasedSpotAsOracle: 89960,
    activeStrike: 90000,
    windowHigh: 90010,
    windowLow: 89920,
    atr1m: 38,
    tir5s: 0.25,
    tir30s: 0.1,
    orderbook: baseOrderbook,
    alreadyTradedThisWindow: false,
    maxEntryCents: 10,
    minReversalScore: 62,
  });

  // 1. Scanning when price > maxEntryCents
  const scanning = deriveStrategyRuntimeStatus({
    tradeLedger: [],
    sniperMetrics: sampleMetrics,
    orderbook: baseOrderbook,
    autoSimEnabled: true,
    maxEntryCents: 10,
    minReversalScore: 62,
    alreadyTradedThisWindow: false,
  });
  assert.equal(scanning.tone, 'amber');
  assert.ok(scanning.phaseLabel.includes('等待跌入'));

  // 2. Paused when autoSimEnabled is false
  const paused = deriveStrategyRuntimeStatus({
    tradeLedger: [],
    sniperMetrics: sampleMetrics,
    orderbook: baseOrderbook,
    autoSimEnabled: false,
    maxEntryCents: 10,
    minReversalScore: 62,
    alreadyTradedThisWindow: false,
  });
  assert.equal(paused.tone, 'slate');
  assert.ok(paused.phaseLabel.includes('已暂停'));

  // 3. Holding monitoring 2.5x Free-Roll target
  const holdingTrade = createFiveDollarSnipe(sampleMetrics, '12:00:00 - 12:05:00', 90000, 89960, 1_700_000_000_000);
  const holdingStatus = deriveStrategyRuntimeStatus({
    tradeLedger: [holdingTrade],
    sniperMetrics: sampleMetrics,
    orderbook: baseOrderbook,
    autoSimEnabled: true,
    maxEntryCents: 10,
    minReversalScore: 62,
    alreadyTradedThisWindow: true,
  });
  assert.equal(holdingStatus.tone, 'amber');
  assert.equal(holdingStatus.activeHoldCount, 1);
  assert.ok(holdingStatus.phaseLabel.includes('等待 2.5x 半仓抽本'));

  // 4. Stage1 Free-Roll active
  const { updatedLedger: freerollLedger } = evaluateStage1FreeRoll([holdingTrade], 36, 62);
  const freerollStatus = deriveStrategyRuntimeStatus({
    tradeLedger: freerollLedger,
    sniperMetrics: sampleMetrics,
    orderbook: { upBid: 42, upAsk: 44, downBid: 56, downAsk: 58, isLiveClob: false },
    autoSimEnabled: true,
    maxEntryCents: 10,
    minReversalScore: 62,
    alreadyTradedThisWindow: true,
  });
  assert.equal(freerollStatus.tone, 'indigo');
  assert.ok(freerollStatus.phaseLabel.includes('半仓抽本已锁定'));
});

test('formatBytes, formatByteRate, and formatMemoryMb format units accurately', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(1_572_864), '1.50 MB');
  assert.equal(formatByteRate(3072), '3.0 KB/s');
  assert.equal(formatMemoryMb(142.4), '142 MB');
  assert.equal(formatMemoryMb(2048), '2.00 GB');
});

test('extractMarketWindowBadge extracts short time range and falls back cleanly', () => {
  assert.equal(
    extractMarketWindowBadge('Bitcoin Up or Down - November 18, 5:45PM-5:50PM ET'),
    '5:45–5:50 ET'
  );
  assert.equal(
    extractMarketWindowBadge('Bitcoin Up or Down - November 17, 12:00PM-12:05PM ET'),
    '12:00–12:05 ET'
  );
  assert.equal(extractMarketWindowBadge('BTC Up or Down (5m)'), '5m 实时盘');
});

test('TradeBucketRing maintains fixed 60s buckets, computes 5s/30s/60s TIR, and prunes stale slots', () => {
  const ring = createTradeBucketRing();
  assert.equal(ring.secEpochs.length, TRADE_RING_SIZE);

  const nowMs = 1_700_000_100_500; // sec = 1_700_000_100
  // Stale trade 70 seconds ago (same slot modulo 60 as nowSec - 10, should be overwritten or pruned)
  pushTradeToRing(ring, nowMs - 70_000, 50, true);
  // 25s ago -> outside 5s window, inside 30s & 60s
  pushTradeToRing(ring, nowMs - 25_000, 4, true);
  // 2s ago -> inside 5s, 30s, 60s
  pushTradeToRing(ring, nowMs - 2_000, 3, false);
  // 1s ago -> inside 5s, 30s, 60s
  pushTradeToRing(ring, nowMs - 1_000, 1, true);

  // 5s TIR: buy=3, sell=1 -> (3 - 1) / 4 = 0.5
  assert.equal(calcTirFromRing(ring, nowMs, 5), 0.5);
  // 30s TIR: buy=3, sell=5 -> (3 - 5) / 8 = -0.25
  assert.equal(calcTirFromRing(ring, nowMs, 30), -0.25);
  // 60s TIR: stale 70s trade ignored and pruned -> still -0.25
  assert.equal(calcTirFromRing(ring, nowMs, 60), -0.25);

  const staleIdx = ((Math.floor((nowMs - 70_000) / 1000) % 60) + 60) % 60;
  assert.equal(ring.secEpochs[staleIdx], 0);
  assert.equal(ring.sellVols[staleIdx], 0);
});

test('getClobPollIntervalMs polls at 1s inside and outside sniper window', () => {
  assert.equal(getClobPollIntervalMs(245), 1000);
  assert.equal(getClobPollIntervalMs(150), 1000);
  assert.equal(getClobPollIntervalMs(65), 1000);
  assert.equal(getClobPollIntervalMs(246), 1000);
  assert.equal(getClobPollIntervalMs(64), 1000);
  assert.equal(getClobPollIntervalMs(0), 1000);
});

const strongSignalParams = {
  remainSec: 180,
  spot: 89945,
  chainlink: 89960,
  debiasedSpotAsOracle: 89945,
  activeStrike: 90000,
  windowHigh: 90010,
  windowLow: 89910,
  atr1m: 38,
  tir5s: 0.6,
  tir30s: 0.2,
  orderbook: { upBid: 6, upAsk: 8, downBid: 91, downAsk: 93, isLiveClob: true },
  alreadyTradedThisWindow: false,
  maxEntryCents: 10,
  minReversalScore: 62,
};

test('computeSniperMetrics refuses to snipe on estimated quotes or unreliable strike', () => {
  const estimated = computeSniperMetrics({
    ...strongSignalParams,
    orderbook: { ...strongSignalParams.orderbook, isLiveClob: false },
  });
  assert.equal(estimated.canSnipe, false);

  const midWindowJoin = computeSniperMetrics({ ...strongSignalParams, strikeReliable: false });
  assert.equal(midWindowJoin.canSnipe, false);
  assert.equal(midWindowJoin.strikeReliable, false);

  const status = deriveStrategyRuntimeStatus({
    tradeLedger: [],
    sniperMetrics: midWindowJoin,
    orderbook: strongSignalParams.orderbook,
    autoSimEnabled: true,
    maxEntryCents: 10,
    minReversalScore: 62,
    alreadyTradedThisWindow: false,
  });
  assert.ok(status.phaseLabel.includes('等待本周期开盘价确认'));
});

test('settleExpiredTrades settles only the given window against each trade strike', () => {
  const metrics = computeSniperMetrics(strongSignalParams);
  const winA = 1_700_000_100;
  const winB = winA + 300;
  const closing = createFiveDollarSnipe(metrics, 'A', 90000, 89945, 1, winA);
  const nextWindow = createFiveDollarSnipe(metrics, 'B', 95000, 94945, 2, winB);

  const { updatedLedger, cashSettled } = settleExpiredTrades([closing, nextWindow], 90010, winA);
  assert.equal(updatedLedger[0].status, 'WON_FULL');
  assert.equal(cashSettled, 62.5);
  assert.equal(updatedLedger[1], nextWindow);

  const expired = expireTradesWhere([closing], (tr) => tr.windowStartSec === winA, '无收盘价');
  assert.equal(expired[0].status, 'LOSS_STOPPED');
  assert.equal(expired[0].settlementPrice, null);
  assert.equal(expired[0].netPnL, -5);
});

test('evaluateStage1FreeRoll ignores positions from other windows', () => {
  const metrics = computeSniperMetrics(strongSignalParams);
  const prevWindowTrade = createFiveDollarSnipe(metrics, 'A', 90000, 89945, 1, 1_700_000_100);
  const ledger = [prevWindowTrade];
  assert.equal(evaluateStage1FreeRoll(ledger, 50, 50, 1_700_000_400).updatedLedger, ledger);
  assert.equal(
    evaluateStage1FreeRoll(ledger, 50, 50, 1_700_000_100).updatedLedger[0].status,
    'STAGE1_FREEROLL'
  );
});

test('expireOrphanTrades keeps current-window trades and expires the rest', () => {
  const metrics = computeSniperMetrics(strongSignalParams);
  const winA = 1_700_000_100;
  const current = createFiveDollarSnipe(metrics, 'A', 90000, 89945, 1, winA);
  const legacy = createFiveDollarSnipe(metrics, 'legacy', 90000, 89945, 2);
  const { updatedLedger: freeroll } = evaluateStage1FreeRoll([legacy], 20, 80);

  const result = expireOrphanTrades([current, freeroll[0]], winA);
  assert.equal(result[0], current);
  assert.equal(result[1].status, 'FREEROLL_EXPIRED');
  assert.equal(result[1].netPnL, 1.25);

  const untouched = [current];
  assert.equal(expireOrphanTrades(untouched, winA), untouched);
});

test('computeReconnectDelayMs doubles exponentially and caps at maxMs', () => {
  assert.equal(computeReconnectDelayMs(0), 1000);
  assert.equal(computeReconnectDelayMs(1), 2000);
  assert.equal(computeReconnectDelayMs(2), 4000);
  assert.equal(computeReconnectDelayMs(4), 16000);
  assert.equal(computeReconnectDelayMs(5), 30000);
  assert.equal(computeReconnectDelayMs(10), 30000);
});




