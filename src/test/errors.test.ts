import { describe, expect, it } from 'vitest';
import { WebError, apiErrorBody } from '../errors.js';
import { nowIso } from '../time.js';
import { appVersion } from '../version.js';

describe('errors.ts taxonomy', () => {
  it('maps codes to correct HTTP statuses', () => {
    expect(new WebError('bad_request', '').status).toBe(400);
    expect(new WebError('validation_failed', '').status).toBe(400);
    expect(new WebError('unauthorized', '').status).toBe(401);
    expect(new WebError('forbidden', '').status).toBe(403);
    expect(new WebError('not_found', '').status).toBe(404);
    expect(new WebError('conflict', '').status).toBe(409);
    expect(new WebError('payload_too_large', '').status).toBe(413);
    expect(new WebError('rate_limited', '').status).toBe(429);
    expect(new WebError('internal_error', '').status).toBe(500);
  });

  it('builds the shared ApiErrorBody shape', () => {
    expect(apiErrorBody('not_found', 'gone', 'req-1')).toEqual({
      error: { code: 'not_found', message: 'gone', requestId: 'req-1' },
    });
    expect(apiErrorBody('not_found', 'gone')).toEqual({
      error: { code: 'not_found', message: 'gone' },
    });
  });
});

describe('time + version helpers', () => {
  it('nowIso is UTC ISO with Z suffix', () => {
    const ts = nowIso();
    expect(ts.endsWith('Z')).toBe(true);
    expect(new Date(ts).toISOString()).toBe(ts);
  });

  it('appVersion reads the package version', () => {
    expect(appVersion()).toBe('0.1.0');
  });
});
