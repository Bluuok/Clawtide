import { describe, expect, it } from 'vitest';
import { loadConfig, ConfigValidationError } from '../config.js';

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...overrides } as NodeJS.ProcessEnv;
}

describe('loadConfig', () => {
  it('applies code defaults with no environment', () => {
    const cfg = loadConfig(env());
    expect(cfg.PORT).toBe(3000);
    expect(cfg.HOST).toBe('127.0.0.1');
    expect(cfg.TRUST_PROXY).toBe(false);
    expect(cfg.corsOrigins).toEqual([]);
    expect(cfg.SESSION_TTL_DAYS).toBe(30);
    expect(cfg.isProd).toBe(false);
  });

  it('parses env overrides with coercion', () => {
    const cfg = loadConfig(
      env({
        PORT: '8080',
        TRUST_PROXY: 'true',
        CORS_ALLOWED_ORIGINS: 'https://a.example.com/,https://b.example.com',
      }),
    );
    expect(cfg.PORT).toBe(8080);
    expect(cfg.TRUST_PROXY).toBe(true);
    expect(cfg.corsOrigins).toEqual(['https://a.example.com', 'https://b.example.com']);
  });

  it('rejects invalid values with named issues', () => {
    expect(() => loadConfig(env({ PORT: 'not-a-port' }))).toThrowError(ConfigValidationError);
    try {
      loadConfig(env({ LOG_LEVEL: 'loud' }));
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      expect((err as ConfigValidationError).issues.join('\n')).toContain('LOG_LEVEL');
    }
  });

  it('resolves DATA_DIR to an absolute path', () => {
    const cfg = loadConfig(env({ DATA_DIR: 'relative-dir' }));
    expect(cfg.dataDir).not.toContain('relative-dir/relative-dir');
    expect(cfg.dataDir.endsWith('relative-dir') || cfg.dataDir.endsWith('relative-dir\\')).toBe(
      true,
    );
  });
});
