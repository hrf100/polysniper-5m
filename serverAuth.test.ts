import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_AUTH_PASSWORD,
  LoginRateLimiter,
  createAuthConfig,
  issueSessionToken,
  verifyPassword,
  verifySessionToken,
} from './serverAuth';

test('createAuthConfig defaults to qq111111 and verifies password exactly', () => {
  const cfg = createAuthConfig(DEFAULT_AUTH_PASSWORD, '');
  assert.equal(cfg.password, 'qq111111');
  assert.equal(verifyPassword(cfg, 'qq111111'), true);
  assert.equal(verifyPassword(cfg, 'qq1111111'), false);
  assert.equal(verifyPassword(cfg, undefined), false);
});

test('session token verifies, expires, and is revoked by password change', () => {
  const cfg = createAuthConfig('pw-a', '');
  const now = 1_700_000_000;
  const token = issueSessionToken(cfg, now);
  assert.equal(verifySessionToken(cfg, token, now + 60), true);
  assert.equal(verifySessionToken(cfg, token, now + 8 * 24 * 3600), false);
  assert.equal(verifySessionToken(createAuthConfig('pw-b', ''), token, now + 60), false);

  const [exp, sig] = token.split('.');
  assert.equal(verifySessionToken(cfg, `${Number(exp) + 999}.${sig}`, now + 60), false);
  assert.equal(verifySessionToken(cfg, 'garbage', now), false);
  assert.equal(verifySessionToken(cfg, undefined, now), false);
});

test('LoginRateLimiter blocks after 5 failures and resets after window', () => {
  const limiter = new LoginRateLimiter();
  const t0 = 1_000_000;
  for (let i = 0; i < 5; i++) limiter.recordFailure('1.2.3.4', t0);
  assert.equal(limiter.isBlocked('1.2.3.4', t0), true);
  assert.equal(limiter.isBlocked('5.6.7.8', t0), false);
  assert.equal(limiter.isBlocked('1.2.3.4', t0 + 10 * 60 * 1000 + 1), false);

  limiter.recordFailure('9.9.9.9', t0);
  limiter.reset('9.9.9.9');
  assert.equal(limiter.isBlocked('9.9.9.9', t0), false);
});
