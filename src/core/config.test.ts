import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const TOUCHED = [
  'BEACON_PORT',
  'PORT',
  'BEACON_DVLA_VES_API_KEY',
  'DVLA_VES_API_KEY',
  'BEACON_PLATE_TIMEOUT_MS',
  'BEACON_HOST',
];

describe('loadConfig', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of TOUCHED) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of TOUCHED) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('applies safe defaults with no environment', () => {
    const config = loadConfig();
    expect(config.port).toBe(7700);
    expect(config.plate.timeoutMs).toBe(12_000);
    expect(config.plate.dvlaVesApiKey).toBeUndefined();
    expect(config.tor.enabled).toBe(true);
    expect(config.tor.socksUrl).toBe('socks5h://127.0.0.1:9050');
  });

  it('trims string env values', () => {
    process.env.BEACON_HOST = '  127.0.0.1  ';
    expect(loadConfig().host).toBe('127.0.0.1');
  });

  it('accepts plate provider vars with or without the BEACON_ prefix', () => {
    process.env.DVLA_VES_API_KEY = 'bare-key';
    expect(loadConfig().plate.dvlaVesApiKey).toBe('bare-key');
    process.env.BEACON_DVLA_VES_API_KEY = 'prefixed-key';
    expect(loadConfig().plate.dvlaVesApiKey).toBe('prefixed-key');
  });

  it('merges a partial `plate` override instead of replacing it', () => {
    process.env.DVLA_VES_API_KEY = 'from-env';
    const config = loadConfig({ plate: { indexResults: true } });
    expect(config.plate.indexResults).toBe(true);
    expect(config.plate.dvlaVesApiKey).toBe('from-env');
    expect(config.plate.timeoutMs).toBe(12_000);
  });
});
