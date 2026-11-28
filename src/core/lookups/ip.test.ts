import { reverse } from 'node:dns/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchRdap } from './rdap.js';
import { lookupIp } from './ip.js';

vi.mock('node:dns/promises', () => ({ reverse: vi.fn() }));
vi.mock('./rdap.js', () => ({
  entityWithRole: vi.fn(
    (entities: Array<{ roles?: string[]; vcardArray?: unknown }> | undefined, role: string) =>
      entities?.find((entity) => entity.roles?.includes(role)),
  ),
  eventDate: vi.fn(
    (events: Array<{ eventAction?: string; eventDate?: string }> | undefined, action: string) =>
      events?.find((event) => event.eventAction === action)?.eventDate,
  ),
  fetchRdap: vi.fn(),
  vcardField: vi.fn(() => 'Example Network'),
}));

describe('lookupIp', () => {
  beforeEach(() => {
    vi.mocked(reverse).mockResolvedValue(['host.example.net']);
    vi.mocked(fetchRdap).mockResolvedValue({
      name: 'Example Network',
      handle: 'NET-203-0-113-0-1',
      country: 'US',
      startAddress: '203.0.113.0',
      endAddress: '203.0.113.255',
      type: 'ALLOCATED PORTABLE',
      parentHandle: 'NET-203-0-112-0-1',
      cidr0_cidrs: [
        { v4prefix: '203.0.113.0', length: 24 },
        { v6prefix: '2001:db8::', length: 32 },
      ],
      events: [
        { eventAction: 'registration', eventDate: '2020-01-01T00:00:00Z' },
        { eventAction: 'last changed', eventDate: '2024-01-01T00:00:00Z' },
      ],
      entities: [{ roles: ['registrant'], vcardArray: [] }],
    });
  });

  it('returns reverse DNS and expanded network allocation details', async () => {
    const result = await lookupIp('203.0.113.10');

    expect(result).toMatchObject({
      ip: '203.0.113.10',
      reverseDns: ['host.example.net'],
      network: 'Example Network',
      organization: 'Example Network',
      networkType: 'ALLOCATED PORTABLE',
      networkRange: '203.0.113.0 – 203.0.113.255',
      cidrBlocks: ['203.0.113.0/24', '2001:db8::/32'],
      parentHandle: 'NET-203-0-112-0-1',
      registeredDate: '2020-01-01T00:00:00Z',
      updatedDate: '2024-01-01T00:00:00Z',
    });
  });
});
