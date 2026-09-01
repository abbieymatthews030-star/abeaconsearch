import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../core/config.js';
import { createLogger } from '../core/logger.js';
import { PersistentEngine } from '../core/store.js';
import { buildApp } from './app.js';

describe('HTTP API', () => {
  let app: FastifyInstance;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'beacon-test-'));
    const config = loadConfig({
      indexFile: path.join(dir, 'index.json'),
      webDir: path.join(dir, 'nonexistent-web'),
      logLevel: 'silent',
      persistDebounceMs: 0,
    });
    const logger = createLogger(config);
    const engine = new PersistentEngine({ indexFile: config.indexFile, debounceMs: 0, logger });
    await engine.load();
    app = await buildApp({ config, engine, logger });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('reports health identically on /health and /api/health', async () => {
    const api = await app.inject({ method: 'GET', url: '/api/health' });
    const bare = await app.inject({ method: 'GET', url: '/health' });
    expect(api.statusCode).toBe(200);
    expect(api.json()).toMatchObject({
      status: 'ok',
      documents: 0,
      plateChecks: expect.any(Object),
    });
    expect(Object.keys(bare.json()).sort()).toEqual(Object.keys(api.json()).sort());
  });

  it('returns error:"not_found" for both unknown routes and missing resources', async () => {
    const route = await app.inject({ method: 'GET', url: '/api/nope' });
    const doc = await app.inject({ method: 'GET', url: '/api/documents/missing-id' });
    expect(route.statusCode).toBe(404);
    expect(doc.statusCode).toBe(404);
    expect(route.json().error).toBe('not_found');
    expect(doc.json().error).toBe('not_found');
  });

  it('creates, fetches, searches and deletes a document', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/documents',
      payload: {
        title: 'Fastify guide',
        body: 'Learn how to build APIs with Fastify.',
        tags: ['web'],
      },
    });
    expect(create.statusCode).toBe(201);
    const id = create.json().id as string;

    const get = await app.inject({ method: 'GET', url: `/api/documents/${id}` });
    expect(get.statusCode).toBe(200);
    expect(get.json().title).toBe('Fastify guide');

    const search = await app.inject({ method: 'GET', url: '/api/search?q=fastify' });
    expect(search.statusCode).toBe(200);
    expect(search.json().total).toBe(1);
    expect(search.json().hits[0].snippet).toContain('<mark>');

    const del = await app.inject({ method: 'DELETE', url: `/api/documents/${id}` });
    expect(del.statusCode).toBe(204);

    const missing = await app.inject({ method: 'GET', url: `/api/documents/${id}` });
    expect(missing.statusCode).toBe(404);
  });

  it('rejects invalid input with 400 and issue details', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/documents',
      payload: { body: 'no title' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
    expect(Array.isArray(res.json().issues)).toBe(true);
  });

  it('bulk indexes documents', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/documents/bulk',
      payload: {
        documents: [
          { title: 'Alpha', body: 'first', tags: ['x'] },
          { title: 'Beta', body: 'second', tags: ['x'] },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().indexed).toBe(2);

    const stats = await app.inject({ method: 'GET', url: '/api/stats' });
    expect(stats.json().documents).toBe(2);
  });

  it('persists the index across engine restarts', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/documents',
      payload: { title: 'Persisted', body: 'still here', tags: [] },
    });
    await app.close();

    const config = loadConfig({
      indexFile: path.join(dir, 'index.json'),
      webDir: path.join(dir, 'nonexistent-web'),
      logLevel: 'silent',
      persistDebounceMs: 0,
    });
    const engine = new PersistentEngine({ indexFile: config.indexFile, debounceMs: 0 });
    await engine.load();
    expect(engine.size).toBe(1);
    app = await buildApp({ config, engine });
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/search?q=persisted' });
    expect(res.json().total).toBe(1);
  });

  it('serves the API placeholder page when no web build exists', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Beacon Search API is running');
  });

  it('honours ?fuzzy=false in the query string (not a truthy string)', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/documents',
      payload: { title: 'Performance tuning', body: 'about performance', tags: [] },
    });
    // "perfrmance" only matches "performance" via fuzzy search.
    const fuzzy = await app.inject({ method: 'GET', url: '/api/search?q=perfrmance' });
    expect(fuzzy.json().total).toBe(1);
    const exact = await app.inject({ method: 'GET', url: '/api/search?q=perfrmance&fuzzy=false' });
    expect(exact.json().total).toBe(0);
  });

  it('runs offline plate checks and honours ?vehicle=false / ?mot=false', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/plate/LA51ABC?vehicle=false&mot=false',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.valid).toBe(true);
    expect(body.format).toBe('current');
    expect(body.region.office).toBe('Wimbledon');
    expect(body.summary.status).toBe('ok');
    const vehicleCheck = body.checks.find((c: { id: string }) => c.id === 'dvla-record');
    expect(vehicleCheck.status).toBe('skipped');
  });

  it('rejects a malformed plate as invalid, not "fail"', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/plate/check',
      payload: { plate: 'NOT-A-PLATE', vehicle: false, mot: false },
    });
    expect(res.json().valid).toBe(false);
    expect(res.json().summary.status).toBe('invalid');
  });
});

describe('write auth (BEACON_WRITE_TOKEN)', () => {
  let app: FastifyInstance;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'beacon-auth-'));
    const config = loadConfig({
      indexFile: path.join(dir, 'index.json'),
      webDir: path.join(dir, 'nonexistent-web'),
      logLevel: 'silent',
      persistDebounceMs: 0,
      writeToken: 's3cret-token',
    });
    const engine = new PersistentEngine({ indexFile: config.indexFile, debounceMs: 0 });
    await engine.load();
    app = await buildApp({ config, engine });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  const doc = { title: 'Guarded', body: 'needs a token', tags: [] };

  it('leaves reads open', async () => {
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    const search = await app.inject({ method: 'GET', url: '/api/search?q=anything' });
    expect(health.statusCode).toBe(200);
    expect(search.statusCode).toBe(200);
  });

  it('rejects a write with no / wrong token as 401', async () => {
    const none = await app.inject({ method: 'POST', url: '/api/documents', payload: doc });
    const wrong = await app.inject({
      method: 'POST',
      url: '/api/documents',
      payload: doc,
      headers: { authorization: 'Bearer nope' },
    });
    expect(none.statusCode).toBe(401);
    expect(none.json().error).toBe('unauthorized');
    expect(wrong.statusCode).toBe(401);
  });

  it('accepts a write with the token via bearer or X-Beacon-Token', async () => {
    const bearer = await app.inject({
      method: 'POST',
      url: '/api/documents',
      payload: doc,
      headers: { authorization: 'Bearer s3cret-token' },
    });
    const header = await app.inject({
      method: 'DELETE',
      url: `/api/documents/${bearer.json().id}`,
      headers: { 'x-beacon-token': 's3cret-token' },
    });
    expect(bearer.statusCode).toBe(201);
    expect(header.statusCode).toBe(204);
  });
});
