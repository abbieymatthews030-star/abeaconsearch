import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../core/config.js';
import { buildMcpServer } from './server.js';

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function textOf(result: unknown): string {
  return (result as ToolResult).content.map((c) => c.text ?? '').join('\n');
}

describe('Beacon MCP server', () => {
  let client: Client;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/stats')) {
        return new Response(JSON.stringify({ documents: 7, tags: 3 }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/api/search')) {
        return new Response(JSON.stringify({ total: 1, hits: [{ id: 'x', title: 'Hit' }] }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    });

    const server = buildMcpServer({
      config: loadConfig({ plate: { indexResults: false } }),
      beaconApiUrl: 'http://beacon.test',
      version: '0.0.0-test',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
  });

  it('exposes the plate and beacon tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'beacon_index_document',
        'beacon_search',
        'beacon_stats',
        'check_number_plate',
        'decode_plate',
        'dvla_vehicle_enquiry',
        'list_plate_countries',
        'mot_history',
        'validate_plate_format',
      ].sort(),
    );
  });

  it('decodes a plate offline', async () => {
    const result = await client.callTool({
      name: 'decode_plate',
      arguments: { plate: 'LA51 XYZ' },
    });
    const data = JSON.parse(textOf(result));
    expect(data.format).toBe('current');
    expect(data.region.office).toBe('Wimbledon');
    expect(data.age.approxYear).toBe(2001);
  });

  it('runs the full automatic check and returns structured content', async () => {
    const result = await client.callTool({
      name: 'check_number_plate',
      arguments: { plate: 'AB12 CDE', includeVehicleData: false, includeMotHistory: false },
    });
    expect((result as ToolResult).isError).toBeFalsy();
    const report = (result as ToolResult).structuredContent as Record<string, unknown>;
    expect(report.valid).toBe(true);
    expect((report.summary as { status: string }).status).toBe('ok');
  });

  it('reports a helpful error when DVLA is not configured', async () => {
    const result = await client.callTool({
      name: 'dvla_vehicle_enquiry',
      arguments: { plate: 'AB12 CDE' },
    });
    expect((result as ToolResult).isError).toBe(true);
    expect(textOf(result)).toContain('DVLA_VES_API_KEY');
  });

  it('proxies beacon_search to the HTTP API', async () => {
    const result = await client.callTool({
      name: 'beacon_search',
      arguments: { query: 'hello', limit: 5 },
    });
    const data = JSON.parse(textOf(result));
    expect(data.total).toBe(1);
    expect(fetchMock).toHaveBeenCalled();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/search?q=hello');
  });

  it('proxies beacon_stats to the HTTP API', async () => {
    const result = await client.callTool({ name: 'beacon_stats', arguments: {} });
    expect(JSON.parse(textOf(result)).documents).toBe(7);
  });
});
