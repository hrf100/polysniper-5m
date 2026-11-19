import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';

export const AUTH_COOKIE_NAME = 'pbtc_auth';
export const DEFAULT_AUTH_PASSWORD = 'qq111111';
const SESSION_TTL_SEC = 7 * 24 * 3600;
const MAX_FAILS_PER_WINDOW = 5;
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const MAX_TRACKED_IPS = 1000;

export interface AuthConfig {
  password: string;
  signingKey: Buffer;
}

/**
 * Signing key is derived from the password (+ optional AUTH_SECRET), so
 * sessions survive restarts and changing the password revokes all sessions.
 */
export function createAuthConfig(
  password = process.env.AUTH_PASSWORD || DEFAULT_AUTH_PASSWORD,
  secret = process.env.AUTH_SECRET || ''
): AuthConfig {
  const signingKey = crypto
    .createHash('sha256')
    .update(`pbtc5-auth:${secret}:${password}`)
    .digest();
  return { password, signingKey };
}

function sign(cfg: AuthConfig, payload: string): string {
  return crypto.createHmac('sha256', cfg.signingKey).update(payload).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function verifyPassword(cfg: AuthConfig, input: unknown): boolean {
  return typeof input === 'string' && safeEqual(input, cfg.password);
}

export function issueSessionToken(cfg: AuthConfig, nowSec = Math.floor(Date.now() / 1000)): string {
  const exp = String(nowSec + SESSION_TTL_SEC);
  return `${exp}.${sign(cfg, exp)}`;
}

export function verifySessionToken(
  cfg: AuthConfig,
  token: string | undefined,
  nowSec = Math.floor(Date.now() / 1000)
): boolean {
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const exp = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expSec = Number(exp);
  if (!Number.isInteger(expSec) || expSec <= nowSec) return false;
  return safeEqual(sig, sign(cfg, exp));
}

export function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** Fixed-window per-IP failure counter; bounded so it cannot grow without limit. */
export class LoginRateLimiter {
  private fails = new Map<string, { count: number; resetAt: number }>();

  isBlocked(ip: string, nowMs = Date.now()): boolean {
    const entry = this.fails.get(ip);
    if (!entry) return false;
    if (entry.resetAt <= nowMs) {
      this.fails.delete(ip);
      return false;
    }
    return entry.count >= MAX_FAILS_PER_WINDOW;
  }

  recordFailure(ip: string, nowMs = Date.now()): void {
    const entry = this.fails.get(ip);
    if (entry && entry.resetAt > nowMs) {
      entry.count += 1;
      return;
    }
    if (this.fails.size >= MAX_TRACKED_IPS) {
      for (const [key, val] of this.fails) {
        if (val.resetAt <= nowMs) this.fails.delete(key);
      }
      if (this.fails.size >= MAX_TRACKED_IPS) {
        const oldest = this.fails.keys().next().value;
        if (oldest !== undefined) this.fails.delete(oldest);
      }
    }
    this.fails.set(ip, { count: 1, resetAt: nowMs + FAIL_WINDOW_MS });
  }

  reset(ip: string): void {
    this.fails.delete(ip);
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  );
}

export function renderLoginPage(errorText = ''): string {
  const errorHtml = errorText
    ? `<p style="color:#fb7185;font-size:12px;margin:0 0 12px">${escapeHtml(errorText)}</p>`
    : '';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="robots" content="noindex" />
<title>PolySniper 5m · 登录</title>
</head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#070B12;color:#e2e8f0;font-family:system-ui,sans-serif">
<form method="post" action="/login" style="width:280px;background:#0E1420;border:1px solid #1e293b;border-radius:12px;padding:24px">
<h1 style="font-size:16px;margin:0 0 16px">PolySniper 5m</h1>
${errorHtml}<input type="password" name="password" placeholder="访问密码" autofocus required autocomplete="current-password"
 style="box-sizing:border-box;width:100%;padding:10px;margin-bottom:12px;border-radius:8px;border:1px solid #334155;background:#070B12;color:#e2e8f0" />
<button type="submit" style="width:100%;padding:10px;border:0;border-radius:8px;background:#4f46e5;color:#fff;font-weight:600;cursor:pointer">登录</button>
</form>
</body>
</html>`;
}

function setSessionCookie(req: Request, res: Response, value: string, maxAgeSec: number): void {
  res.cookie(AUTH_COOKIE_NAME, value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    maxAge: maxAgeSec * 1000,
    path: '/',
  });
}

export function handleLoginPost(cfg: AuthConfig, limiter: LoginRateLimiter) {
  return (req: Request, res: Response) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (limiter.isBlocked(ip)) {
      return res.status(429).type('html').send(renderLoginPage('失败次数过多，请 10 分钟后再试'));
    }
    if (!verifyPassword(cfg, req.body?.password)) {
      limiter.recordFailure(ip);
      return res.status(401).type('html').send(renderLoginPage('密码错误'));
    }
    limiter.reset(ip);
    setSessionCookie(req, res, issueSessionToken(cfg), SESSION_TTL_SEC);
    return res.redirect(303, '/');
  };
}

export function handleLogout(req: Request, res: Response): void {
  setSessionCookie(req, res, '', 0);
  res.redirect(303, '/login');
}

export function requireAuth(cfg: AuthConfig) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (verifySessionToken(cfg, readCookie(req, AUTH_COOKIE_NAME))) return next();
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return res.redirect(302, '/login');
  };
}
