import compression from 'compression';
import express from 'express';
import type { Request, Response } from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  DEFAULT_AUTH_PASSWORD,
  LoginRateLimiter,
  createAuthConfig,
  handleLoginPost,
  handleLogout,
  renderLoginPage,
  requireAuth,
} from './serverAuth';
import { setDisplayTimeZone } from './src/utils/sniperEngine';
import { StrategyService } from './strategyService';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
// `npm run build` bundles this file into ./server.js, which always serves dist/.
const isProduction = process.env.NODE_ENV === 'production' || !__filename.endsWith('.ts');
const distDir = path.resolve(__dirname, 'dist');
setDisplayTimeZone(process.env.DISPLAY_TZ || 'Asia/Shanghai');

const proxyTraffic = {
  reqCount: 0,
  rxBytes: 0,
  txBytes: 0,
};

interface SysCpuSample {
  total: number;
  idle: number;
}

interface SysNetSample {
  rxBytes: number;
  txBytes: number;
  atMs: number;
}

function readSystemCpuSample(): SysCpuSample {
  try {
    const stat = fs.readFileSync('/proc/stat', 'utf8');
    const firstLine = stat.split('\n')[0] || '';
    if (firstLine.startsWith('cpu ')) {
      const parts = firstLine.trim().split(/\s+/).slice(1).map(Number);
      const idle = (parts[3] || 0) + (parts[4] || 0); // idle + iowait
      const total = parts.slice(0, 8).reduce((acc, n) => acc + (Number.isFinite(n) ? n : 0), 0);
      if (total > 0) return { total, idle };
    }
  } catch {
    // fallback to os.cpus()
  }
  const cpus = os.cpus();
  let total = 0;
  let idle = 0;
  for (const cpu of cpus) {
    const t = cpu.times;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
    idle += t.idle;
  }
  return { total, idle };
}

function readSystemMemoryInfo(): { totalMb: number; usedMb: number; percent: number } {
  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
    const totalMatch = meminfo.match(/^MemTotal:\s+(\d+)\s+kB/m);
    const availMatch = meminfo.match(/^MemAvailable:\s+(\d+)\s+kB/m);
    const freeMatch = meminfo.match(/^MemFree:\s+(\d+)\s+kB/m);
    if (totalMatch) {
      const totalKb = Number(totalMatch[1]);
      const availKb = Number((availMatch || freeMatch)?.[1] ?? 0);
      const usedKb = Math.max(0, totalKb - availKb);
      const totalMb = Math.round(totalKb / 1024);
      const usedMb = Math.round(usedKb / 1024);
      const percent = Number(((usedKb / Math.max(1, totalKb)) * 100).toFixed(1));
      return { totalMb, usedMb, percent };
    }
  } catch {
    // fallback to os module
  }
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const usedBytes = Math.max(0, totalBytes - freeBytes);
  return {
    totalMb: Math.round(totalBytes / 1024 / 1024),
    usedMb: Math.round(usedBytes / 1024 / 1024),
    percent: Number(((usedBytes / Math.max(1, totalBytes)) * 100).toFixed(1)),
  };
}

function readSystemNetSample(): SysNetSample {
  const atMs = Date.now();
  try {
    const raw = fs.readFileSync('/proc/net/dev', 'utf8');
    let rxBytes = 0;
    let txBytes = 0;
    for (const line of raw.split('\n').slice(2)) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.includes(':')) continue;
      const [iface, stats] = trimmed.split(':');
      if (iface.trim() === 'lo') continue;
      const cols = stats.trim().split(/\s+/).map(Number);
      if (cols.length >= 9) {
        rxBytes += Number.isFinite(cols[0]) ? cols[0] : 0;
        txBytes += Number.isFinite(cols[8]) ? cols[8] : 0;
      }
    }
    return { rxBytes, txBytes, atMs };
  } catch {
    return { rxBytes: proxyTraffic.rxBytes, txBytes: proxyTraffic.txBytes, atMs };
  }
}

let lastCpuUsage = process.cpuUsage();
let lastCpuSampleHr = process.hrtime.bigint();
let lastSysCpu = readSystemCpuSample();
let lastSysNet = readSystemNetSample();

interface UpstreamResult {
  status: number;
  contentType: string;
  body: string;
}

// Short-lived GET cache + in-flight dedupe: N open tabs polling the same
// orderbook/market cost one upstream request instead of N.
const UPSTREAM_CACHE_MAX = 300;
const upstreamCache = new Map<string, { expiresAt: number; result: UpstreamResult }>();
const upstreamInflight = new Map<string, Promise<UpstreamResult>>();

function pruneUpstreamCache(nowMs: number) {
  for (const [key, entry] of upstreamCache) {
    if (entry.expiresAt <= nowMs) upstreamCache.delete(key);
  }
  while (upstreamCache.size >= UPSTREAM_CACHE_MAX) {
    const oldest = upstreamCache.keys().next().value;
    if (oldest === undefined) break;
    upstreamCache.delete(oldest);
  }
}

async function fetchUpstream(
  targetUrl: string,
  method: string,
  headers: Record<string, string>,
  bodyText?: string
): Promise<UpstreamResult> {
  proxyTraffic.reqCount += 1;
  proxyTraffic.txBytes +=
    Buffer.byteLength(targetUrl, 'utf8') +
    (bodyText ? Buffer.byteLength(bodyText, 'utf8') : 0);

  const upstream = await fetch(targetUrl, {
    method,
    headers,
    body: bodyText,
    signal: AbortSignal.timeout(8000),
  });
  const body = await upstream.text();
  proxyTraffic.rxBytes += Buffer.byteLength(body, 'utf8');
  return {
    status: upstream.status,
    contentType: upstream.headers.get('content-type') || 'application/json',
    body,
  };
}

async function fetchUpstreamCached(targetUrl: string, ttlMs: number): Promise<UpstreamResult> {
  const nowMs = Date.now();
  const cached = upstreamCache.get(targetUrl);
  if (cached && cached.expiresAt > nowMs) return cached.result;

  const pending = upstreamInflight.get(targetUrl);
  if (pending) return pending;

  const task = fetchUpstream(targetUrl, 'GET', { Accept: 'application/json' })
    .then((result) => {
      if (result.status >= 200 && result.status < 300) {
        if (upstreamCache.size >= UPSTREAM_CACHE_MAX) pruneUpstreamCache(Date.now());
        upstreamCache.set(targetUrl, { expiresAt: Date.now() + ttlMs, result });
      }
      return result;
    })
    .finally(() => {
      upstreamInflight.delete(targetUrl);
    });
  upstreamInflight.set(targetUrl, task);
  return task;
}

function sendUpstream(res: Response, result: UpstreamResult) {
  res.status(result.status);
  res.setHeader('Content-Type', result.contentType);
  res.send(result.body);
}

function sendUpstreamError(res: Response, err: unknown) {
  const message = err instanceof Error ? err.message : 'Upstream proxy error';
  res.status(502).json({ error: message });
}

async function forwardCachedGet(targetUrl: string, ttlMs: number, res: Response) {
  try {
    sendUpstream(res, await fetchUpstreamCached(targetUrl, ttlMs));
  } catch (err) {
    sendUpstreamError(res, err);
  }
}

async function forwardJson(
  targetUrl: string,
  req: Request,
  res: Response,
  forwardHeaders: string[] = []
) {
  try {
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      headers['Content-Type'] = 'application/json';
    }
    for (const h of forwardHeaders) {
      const val = req.header(h);
      if (val) headers[h] = val;
    }

    const bodyText =
      req.method !== 'GET' && req.method !== 'HEAD' && req.body
        ? JSON.stringify(req.body)
        : undefined;
    sendUpstream(res, await fetchUpstream(targetUrl, req.method, headers, bodyText));
  } catch (err) {
    sendUpstreamError(res, err);
  }
}

async function createServer() {
  const app = express();
  app.disable('x-powered-by');
  // Only honour X-Forwarded-* from a reverse proxy on the same host (nginx/caddy),
  // otherwise clients could spoof their IP past the login rate limiter.
  app.set('trust proxy', process.env.TRUST_PROXY || 'loopback');
  app.use(
    compression({
      threshold: 1024,
      // SSE must flush every event immediately; compression would buffer it.
      filter: (req, res) =>
        req.path !== '/api/strategy/stream' && compression.filter(req, res),
    })
  );

  const strategy = new StrategyService(
    path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data')),
    proxyTraffic
  );
  strategy.start();
  const shutdown = (signal: string) => {
    console.log(`[server] ${signal} received, flushing strategy state`);
    strategy.stop();
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  const authConfig = createAuthConfig();
  if (authConfig.password === DEFAULT_AUTH_PASSWORD) {
    console.warn('[auth] Using default password; set AUTH_PASSWORD to change it.');
  }
  const loginLimiter = new LoginRateLimiter();
  app.get('/login', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(renderLoginPage());
  });
  app.post(
    '/login',
    express.urlencoded({ extended: false, limit: '4kb' }),
    handleLoginPost(authConfig, loginLimiter)
  );
  app.get('/logout', handleLogout);
  app.use(requireAuth(authConfig));

  app.use(express.json({ limit: '64kb' }));

  // Polymarket Gamma API proxy (public profile & 5m market discovery)
  app.get('/api/poly/gamma/public-profile', (req, res) => {
    const address = String(req.query.address || '');
    if (!address) return res.status(400).json({ error: 'Missing address parameter' });
    return forwardCachedGet(
      `https://gamma-api.polymarket.com/public-profile?address=${encodeURIComponent(address)}`,
      60_000,
      res
    );
  });

  // Server-resident strategy: browsers observe via SSE and send control commands.
  app.get('/api/strategy/state', (_req, res) => {
    res.json(strategy.getSnapshot());
  });

  app.get('/api/strategy/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: snapshot\ndata: ${JSON.stringify(strategy.getSnapshot())}\n\n`);
    const unsubscribe = strategy.subscribe((event) => {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
    });
    req.on('close', unsubscribe);
  });

  app.post('/api/strategy/settings', (req, res) => {
    res.json(strategy.updateSettings(req.body || {}));
  });

  app.post('/api/strategy/manual-snipe', (_req, res) => {
    const result = strategy.manualSnipe();
    res.status(result.ok ? 200 : 409).json(result);
  });

  app.post('/api/strategy/reset-ledger', (_req, res) => {
    strategy.resetLedger();
    res.json({ ok: true });
  });

  // Polymarket CLOB API proxy (L2 API key derivation)
  app.get('/api/poly/clob/auth/derive-api-key', (req, res) => {
    return forwardJson('https://clob.polymarket.com/auth/derive-api-key', req, res, [
      'POLY_ADDRESS',
      'POLY_SIGNATURE',
      'POLY_TIMESTAMP',
      'POLY_NONCE',
    ]);
  });

  app.post('/api/poly/clob/auth/api-key', (req, res) => {
    return forwardJson('https://clob.polymarket.com/auth/api-key', req, res, [
      'POLY_ADDRESS',
      'POLY_SIGNATURE',
      'POLY_TIMESTAMP',
      'POLY_NONCE',
    ]);
  });

  // Polymarket Data API proxy (portfolio value via positions or value endpoint)
  app.get('/api/poly/data/value', async (req, res) => {
    const user = String(req.query.user || '');
    if (!user) return res.status(400).json({ error: 'Missing user parameter' });
    proxyTraffic.reqCount += 1;
    proxyTraffic.txBytes += Buffer.byteLength(user, 'utf8');
    try {
      const posRes = await fetch(
        `https://data-api.polymarket.com/positions?user=${encodeURIComponent(user)}`,
        { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(6000) }
      );
      if (posRes.ok) {
        const text = await posRes.text();
        proxyTraffic.rxBytes += Buffer.byteLength(text, 'utf8');
        const positions = JSON.parse(text);
        if (Array.isArray(positions)) {
          const total = positions.reduce(
            (sum, p) => sum + (Number(p?.currentValue) || 0),
            0
          );
          return res.json({ value: Number(total.toFixed(2)) });
        }
      }
      return res.json({ value: 0 });
    } catch {
      return res.json({ value: 0 });
    }
  });

  // Polygon JSON-RPC proxy with resilient public RPC fallbacks
  app.post('/api/polygon/rpc', async (req, res) => {
    const bodyText = JSON.stringify(req.body || {});
    proxyTraffic.reqCount += 1;
    proxyTraffic.txBytes += Buffer.byteLength(bodyText, 'utf8');
    const rpcEndpoints = [
      'https://polygon-bor-rpc.publicnode.com',
      'https://1rpc.io/matic',
      'https://polygon.drpc.org',
    ];
    for (const rpcUrl of rpcEndpoints) {
      try {
        const upstream = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: bodyText,
          signal: AbortSignal.timeout(5000),
        });
        if (upstream.ok) {
          const text = await upstream.text();
          proxyTraffic.rxBytes += Buffer.byteLength(text, 'utf8');
          const data = JSON.parse(text);
          if (data && !data.error) {
            return res.json(data);
          }
        }
      } catch {
        // Try next Polygon RPC endpoint
      }
    }
    return res.json({ jsonrpc: '2.0', id: req.body?.id ?? 1, result: '0x0' });
  });

  // Real whole-machine CPU, memory, and network traffic metrics
  // Shared snapshot: concurrent pollers must not shrink the CPU/net delta windows.
  let metricsSnapshot: { atMs: number; data: Record<string, number> } | null = null;
  app.get('/api/system/metrics', (_req, res) => {
    if (metricsSnapshot && Date.now() - metricsSnapshot.atMs < 1500) {
      return res.json(metricsSnapshot.data);
    }
    const nowHr = process.hrtime.bigint();
    const elapsedMicros = Number(nowHr - lastCpuSampleHr) / 1000;
    const cpuDelta = process.cpuUsage(lastCpuUsage);
    lastCpuUsage = process.cpuUsage();
    lastCpuSampleHr = nowHr;

    const cpuCores = Math.max(1, os.cpus().length);
    const rawProcessCpuPct =
      elapsedMicros > 0
        ? ((cpuDelta.user + cpuDelta.system) / (elapsedMicros * cpuCores)) * 100
        : 0;
    const processCpuPercent = Number(Math.max(0, Math.min(100, rawProcessCpuPct)).toFixed(1));

    const currSysCpu = readSystemCpuSample();
    const sysCpuTotalDelta = currSysCpu.total - lastSysCpu.total;
    const sysCpuIdleDelta = currSysCpu.idle - lastSysCpu.idle;
    lastSysCpu = currSysCpu;
    const rawSysCpuPct =
      sysCpuTotalDelta > 0
        ? ((sysCpuTotalDelta - sysCpuIdleDelta) / sysCpuTotalDelta) * 100
        : processCpuPercent;
    const cpuPercent = Number(Math.max(0, Math.min(100, rawSysCpuPct)).toFixed(1));

    const mem = process.memoryUsage();
    const sysMem = readSystemMemoryInfo();

    const currSysNet = readSystemNetSample();
    const netDtSec = Math.max(0.25, (currSysNet.atMs - lastSysNet.atMs) / 1000);
    const netRxRateBps = Math.max(
      0,
      Math.round((currSysNet.rxBytes - lastSysNet.rxBytes) / netDtSec)
    );
    const netTxRateBps = Math.max(
      0,
      Math.round((currSysNet.txBytes - lastSysNet.txBytes) / netDtSec)
    );
    lastSysNet = currSysNet;

    const data = {
      cpuPercent,
      processCpuPercent,
      systemLoad1m: Number(os.loadavg()[0].toFixed(2)),
      cpuCores,
      processRssMb: Number((mem.rss / 1024 / 1024).toFixed(1)),
      processHeapUsedMb: Number((mem.heapUsed / 1024 / 1024).toFixed(1)),
      processHeapTotalMb: Number((mem.heapTotal / 1024 / 1024).toFixed(1)),
      sysUsedMb: sysMem.usedMb,
      sysTotalMb: sysMem.totalMb,
      sysMemPercent: sysMem.percent,
      netRxBytes: currSysNet.rxBytes,
      netTxBytes: currSysNet.txBytes,
      netRxRateBps,
      netTxRateBps,
      proxyReqCount: proxyTraffic.reqCount,
      proxyRxBytes: proxyTraffic.rxBytes,
      proxyTxBytes: proxyTraffic.txBytes,
      uptimeSec: Math.floor(process.uptime()),
    };
    metricsSnapshot = { atMs: Date.now(), data };
    return res.json(data);
  });

  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(
      express.static(distDir, {
        index: false,
        setHeaders: (res, filePath) => {
          // Vite emits content-hashed files under /assets; safe to cache forever.
          if (filePath.includes(`${path.sep}assets${path.sep}`)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          }
        },
      })
    );
    app.get('*', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Polymarket Sniper Terminal server listening on http://0.0.0.0:${PORT}`);
  });
}

// Keep the resident strategy alive on stray async errors; log instead of crashing.
process.on('unhandledRejection', (reason) => {
  console.error('[server] Unhandled rejection:', reason);
});

createServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
