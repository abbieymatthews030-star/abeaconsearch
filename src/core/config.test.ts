import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const TOUCHED = [
  'BEACON_PORT',
  'PORT',
  'BEACON_DVLA_VES_API_KEY',
  'DVLA_VES_API_KEY',
  'BEACON_PLATE_TIMEOUT_MS',
  'BEACON_HOST',
  'BEACON_SITE_NAME',
  'BEACON_SITE_URL',
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
    expect(config.site.name).toBe('Beacon Search');
    expect(config.site.url).toBe('');
    expect(config.answer.searchBudgetMs).toBe(2_500);
  });

  it('reads public site identity from the environment', () => {
    process.env.BEACON_SITE_NAME = '  My Beacon  ';
    process.env.BEACON_SITE_URL = ' https://search.example.com ';
    const config = loadConfig();
    expect(config.site.name).toBe('My Beacon');
    expect(config.site.url).toBe('https://search.example.com');
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
