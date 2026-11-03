import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RUNTIME_SETTINGS } from './runtime-settings.js';
import {
  ANSWER_FIELDS,
  DISPLAY_HIT_FIELDS,
  ENVELOPE_FIELDS,
  QUERY_FIELDS,
} from '../../web/src/ui-contract.js';
import { CLIENT_SETTINGS, SERVER_ALSO_SHOW } from '../../web/src/settings-registry.js';

describe('ui contract', () => {
  const app = readFileSync(new URL('../../web/src/App.tsx', import.meta.url), 'utf8');
  const registry = readFileSync(
    new URL('../../web/src/settings-registry.ts', import.meta.url),
    'utf8',
  );

  it('keeps server settings on the API instead of a second hand-written list', () => {
    expect(registry).not.toContain('export const SERVER_SETTINGS');
    const clientIds = new Set(CLIENT_SETTINGS.map((setting) => setting.id));
    for (const setting of RUNTIME_SETTINGS) {
      expect(clientIds.has(setting.id)).toBe(false);
    }
    for (const id of Object.keys(SERVER_ALSO_SHOW)) {
      expect(RUNTIME_SETTINGS.some((setting) => setting.id === id)).toBe(true);
    }
  });

  it('mentions every query and answer field in the web UI', () => {
    const fields = [...ENVELOPE_FIELDS, ...QUERY_FIELDS, ...DISPLAY_HIT_FIELDS, ...ANSWER_FIELDS];
    const missing = [...new Set(fields)].filter((field) => !app.includes(field));
    expect(missing).toEqual([]);
  });
});
