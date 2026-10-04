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
      dataDir: dir,
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
      answer: { enabled: true, webSearch: null, llm: [] },
    });
    expect(Object.keys(bare.json()).sort()).toEqual(Object.keys(api.json()).sort());
  });

  it('does not return an unrelated local document for a person-name query', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/documents',
      payload: {
        id: 'minisearch-ranking-explained',
        title: 'MiniSearch Ranking Explained',
        body: 'MiniSearch ranks documents using term frequency and field boosting, with title matches weighted higher than body matches.',
        tags: ['search', 'ranking'],
      },
    });

    const res = await app.inject({ method: 'GET', url: '/api/query?q=abbiey%20matthews' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.intent).toBe('person');
    expect(
      body.results.some((hit: { id: string }) => hit.id === 'minisearch-ranking-explained'),
    ).toBe(false);
    expect(body.outcome).toBe('unconfigured');
    const missing = body.diagnostics
      .flatMap((item: { missingEnv: string[] }) => item.missingEnv)
      .join(' ');
    expect(missing).toContain('BRAVE_SEARCH_API_KEY');
    expect(missing).toContain('TAVILY_API_KEY');
    expect(missing).toContain('SEARXNG_URL');
  });

  it('weaves an answer from the local index and cites its sources', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/documents',
      payload: {
        title: 'Fastify',
        body: 'Fastify is a fast and low-overhead web framework for Node.js. It focuses on developer experience and schema-based validation.',
        tags: [],
        url: 'https://fastify.dev/',
      },
    });

    const bad = await app.inject({ method: 'GET', url: '/api/answer?q=a' });
    expect(bad.statusCode).toBe(400);

    const res = await app.inject({ method: 'GET', url: '/api/answer?q=what%20is%20fastify' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.synthesizer).toBe('extractive');
    expect(body.answer.length).toBeGreaterThan(0);
    expect(body.sources[0].url).toBe('https://fastify.dev/');
    expect(['high', 'medium', 'low', 'none']).toContain(body.confidence);
    expect(body.warnings.join(' ')).toContain('web search is not configured');
  });

  it('returns 404 for /api/answer when answer synthesis is disabled', async () => {
    const config = loadConfig({
      dataDir: dir,
      indexFile: path.join(dir, 'index2.json'),
      webDir: path.join(dir, 'nonexistent-web'),
      logLevel: 'silent',
      persistDebounceMs: 0,
      answer: { enabled: false },
    });
    const engine = new PersistentEngine({ indexFile: config.indexFile, debounceMs: 0 });
    await engine.load();
    const disabled = await buildApp({ config, engine });
    await disabled.ready();
    try {
      const res = await disabled.inject({ method: 'GET', url: '/api/answer?q=anything here' });
      expect(res.statusCode).toBe(404);
      const health = await disabled.inject({ method: 'GET', url: '/api/health' });
      expect(health.json().answer).toEqual({
        enabled: false,
        autoAnswer: false,
        webSearch: null,
        llm: [],
      });
    } finally {
      await disabled.close();
    }
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
      dataDir: dir,
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

  it('lists settings, patches one, and rejects an out-of-range value', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(list.statusCode).toBe(200);
    const before = list.json().settings.find((s: { id: string }) => s.id === 'answerMaxSources');
    expect(before).toMatchObject({ isDefault: true });

    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { answerMaxSources: 4 },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().applied).toEqual(['answerMaxSources']);
    const after = patch.json().settings.find((s: { id: string }) => s.id === 'answerMaxSources');
    expect(after).toMatchObject({ value: 4, isDefault: false });

    const bad = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { answerMaxSources: 999 },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().errors.answerMaxSources).toMatch(/<= 50/);
  });

  it('resets settings back to their defaults', async () => {
    await app.inject({ method: 'PATCH', url: '/api/settings', payload: { crawlMaxPages: 7 } });
    const reset = await app.inject({
      method: 'POST',
      url: '/api/settings/reset',
      payload: { ids: ['crawlMaxPages'] },
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json().reset).toEqual(['crawlMaxPages']);
    const entry = reset.json().settings.find((s: { id: string }) => s.id === 'crawlMaxPages');
    expect(entry).toMatchObject({ value: 50, isDefault: true });
  });

  it('lists providers derived from real config, with no fabricated entries', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/providers' });
    expect(res.statusCode).toBe(200);
    const ids = res.json().providers.map((p: { id: string }) => p.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'local_index',
        'crawler',
        'domain_lookups',
        'dvla_vehicle',
        'dvsa_mot',
        'answer_web_search',
        'answer_llm',
      ]),
    );
    const dvla = res.json().providers.find((p: { id: string }) => p.id === 'dvla_vehicle');
    expect(dvla.status).toBe('not_configured');
    expect(dvla.testable).toBe(false);
  });

  it('404s testing an unknown provider and 400s a non-testable one', async () => {
    const unknown = await app.inject({ method: 'POST', url: '/api/providers/not-a-thing/test' });
    expect(unknown.statusCode).toBe(404);
    const notTestable = await app.inject({
      method: 'POST',
      url: '/api/providers/local_index/test',
    });
    expect(notTestable.statusCode).toBe(400);
  });

  it('reports diagnostics with real counts and the provider list', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/diagnostics' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(typeof body.uptimeSeconds).toBe('number');
    expect(typeof body.checkedAt).toBe('string');
    expect(Array.isArray(body.providers)).toBe(true);
  });
});
