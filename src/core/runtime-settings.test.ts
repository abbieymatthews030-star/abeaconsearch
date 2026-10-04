import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { RuntimeSettingsStore } from './runtime-settings.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'beacon-settings-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('RuntimeSettingsStore', () => {
  it('lists every setting as a default when no overlay exists', async () => {
    const config = loadConfig();
    const store = new RuntimeSettingsStore({ file: path.join(dir, 'settings.json'), config });
    await store.load();
    const list = store.list();
    expect(list.length).toBeGreaterThan(10);
    expect(list.every((s) => s.isDefault)).toBe(true);
  });

  it('applies a valid update, mutates the live config, and marks it non-default', async () => {
    const config = loadConfig();
    const store = new RuntimeSettingsStore({ file: path.join(dir, 'settings.json'), config });
    await store.load();

    const { applied, errors } = await store.update({ lookupsEnabled: false, answerMaxSources: 5 });
    expect(applied.sort()).toEqual(['answerMaxSources', 'lookupsEnabled']);
    expect(errors).toEqual({});
    expect(config.lookups.enabled).toBe(false);
    expect(config.answer.maxSources).toBe(5);

    const entry = store.list().find((s) => s.id === 'lookupsEnabled');
    expect(entry?.isDefault).toBe(false);
    expect(entry?.value).toBe(false);
  });

  it('rejects an unknown id and an out-of-range value without applying either', async () => {
    const config = loadConfig();
    const store = new RuntimeSettingsStore({ file: path.join(dir, 'settings.json'), config });
    await store.load();

    const { applied, errors } = await store.update({
      nonsense: true,
      answerMaxSources: 999,
    });
    expect(applied).toEqual([]);
    expect(errors.nonsense).toBe('unknown setting');
    expect(errors.answerMaxSources).toMatch(/<= 50/);
  });

  it('persists across a reload', async () => {
    const file = path.join(dir, 'settings.json');
    const config1 = loadConfig();
    const store1 = new RuntimeSettingsStore({ file, config: config1 });
    await store1.load();
    await store1.update({ crawlMaxPages: 7 });

    const config2 = loadConfig();
    const store2 = new RuntimeSettingsStore({ file, config: config2 });
    await store2.load();
    expect(config2.crawlMaxPages).toBe(7);
  });

  it('resets a setting back to its environment-derived default', async () => {
    const config = loadConfig();
    const store = new RuntimeSettingsStore({ file: path.join(dir, 'settings.json'), config });
    await store.load();
    await store.update({ crawlMaxPages: 7 });
    expect(config.crawlMaxPages).toBe(7);

    await store.reset(['crawlMaxPages']);
    expect(config.crawlMaxPages).toBe(50);
    expect(store.list().find((s) => s.id === 'crawlMaxPages')?.isDefault).toBe(true);
  });
});
