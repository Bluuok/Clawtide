/**
 * Two-layer login rate limiter (spec §6.1 item 7 必备测试): fake-timer driven
 * windows, layer-1 exhaustion, global layer 4× boundary, success clearing
 * only layer 1.
 */
import { describe, expect, it } from 'vitest';
import { LoginRateLimiter } from '../rate-limit.js';

describe('LoginRateLimiter', () => {
  const THRESHOLD = 5;
  const WINDOW = 15 * 60_000; // 15 min
  const T0 = 1_700_000_000_000;

  function make() {
    return new LoginRateLimiter(THRESHOLD, WINDOW);
  }

  it('allows under the threshold and blocks at layer 1 after N failures', () => {
    const rl = make();
    const now = T0;
    for (let i = 0; i < THRESHOLD; i++) {
      expect(rl.check('alice', '1.1.1.1', now).allowed).toBe(true);
      rl.failure('alice', '1.1.1.1', now);
    }
    // Threshold reached: layer 1 blocks.
    const verdict = rl.check('alice', '1.1.1.1', now);
    expect(verdict.allowed).toBe(false);
    expect(verdict.layer).toBe(1);
    rl.stop();
  });

  it('layer 1 unblocks after its window passes', () => {
    const rl = make();
    for (let i = 0; i < THRESHOLD; i++) rl.failure('alice', '1.1.1.1', T0);
    expect(rl.check('alice', '1.1.1.1', T0 + 1000).allowed).toBe(false);
    // Window elapsed: the layer-1 record expired.
    expect(rl.check('alice', '1.1.1.1', T0 + WINDOW + 1).allowed).toBe(true);
    rl.stop();
  });

  it('global layer blocks at 4× threshold even from a different IP', () => {
    const rl = make();
    let now = T0;
    // 4× threshold failures spread across rotating IPs so layer 1 never trips.
    for (let i = 0; i < THRESHOLD * 4; i++) {
      const ip = `10.0.0.${i + 1}`;
      rl.failure('alice', ip, now);
      now += (WINDOW / (THRESHOLD * 4)) * 2; // stay inside each window fresh per IP
    }
    const verdict = rl.check('alice', '99.9.9.9', now);
    expect(verdict.allowed).toBe(false);
    expect(verdict.layer).toBe(2);
    rl.stop();
  });

  it('successful login clears layer 1 but NOT the global layer', () => {
    const rl = make();
    let now = T0;
    // Exhaust layer 1 with 3 failures, then log in successfully.
    for (let i = 0; i < 3; i++) rl.failure('alice', '1.1.1.1', now);
    rl.success('alice', '1.1.1.1');
    // Layer 1 is clean again.
    expect(rl.check('alice', '1.1.1.1', now).allowed).toBe(true);
    // Now push the global layer over the line: 4× failures total already, so
    // one more failure from anywhere trips layer 2.
    for (let i = 0; i < THRESHOLD * 4; i++) {
      rl.failure('alice', `10.0.1.${i + 1}`, now);
    }
    const verdict = rl.check('alice', '99.9.9.9', now);
    expect(verdict.allowed).toBe(false);
    expect(verdict.layer).toBe(2);
    // Even a successful login does not reset the global layer...
    rl.success('alice', '99.9.9.9');
    expect(rl.check('alice', '99.9.9.9', now).allowed).toBe(false);
    // ...until the fixed 1h global window decays.
    expect(rl.check('alice', '99.9.9.9', now + 60 * 60_000 + 1).allowed).toBe(true);
    rl.stop();
  });

  it('keys are per-username: other accounts unaffected', () => {
    const rl = make();
    for (let i = 0; i < THRESHOLD; i++) rl.failure('alice', '1.1.1.1', T0);
    expect(rl.check('alice', '1.1.1.1', T0).allowed).toBe(false);
    expect(rl.check('bob', '1.1.1.1', T0).allowed).toBe(true);
    rl.stop();
  });
});
