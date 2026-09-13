import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config } from '../core/config.js';
import { decodeAge } from '../core/plate/age.js';
import { classifyAuPlate, formatAuPlate } from '../core/plate/au-format.js';
import { detectCountry } from '../core/plate/country.js';
import { classifyPlate, formatPlate, normalizePlate } from '../core/plate/format.js';
import { createPlateChecker } from '../core/plate/index.js';
import { lookupMemoryTag } from '../core/plate/regions.js';
import { BeaconClient } from './beacon-client.js';

export interface BuildMcpServerOptions {
  config: Config;
  beaconApiUrl: string;
  version: string;
  fetchImpl?: typeof fetch;
}

type ToolText = {
  [x: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function ok(data: unknown): ToolText {
  const structured =
    data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : { result: data };
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: structured,
  };
}

function fail(message: string): ToolText {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

/**
 * Build the Beacon MCP server: number-plate tools (in-process) plus search-index
 * tools that proxy to a running Beacon Search HTTP API.
 */
export function buildMcpServer(options: BuildMcpServerOptions): McpServer {
  const { config, beaconApiUrl, version, fetchImpl } = options;
  const checker = createPlateChecker(config, fetchImpl);
  // Reuse the checker's provider instances (one MOT OAuth token cache, etc.).
  const { vehicle: vesProvider, mot: motProvider } = checker.providers;
  const beacon = new BeaconClient(beaconApiUrl, fetchImpl);

  const server = new McpServer(
    { name: 'beacon-search', version },
    {
      instructions:
        'Tools for UK number-plate analysis (offline format/age/region plus optional ' +
        'DVLA and DVSA lookups) and for searching / adding documents in a running ' +
        'Beacon Search instance.',
    },
  );

  const plateArg = z
    .string()
    .min(1)
    .max(16)
    .describe('A UK or Australian vehicle registration mark, e.g. "AB12 CDE" or "AB12 CD"');

  const countryArg = z
    .enum(['GB', 'AU'])
    .optional()
    .describe('Force interpretation as UK ("GB") or Australian ("AU") instead of auto-detecting');

  server.registerTool(
    'check_number_plate',
    {
      title: 'Check a UK or Australian number plate',
      description:
        'Run all automatic checks on a registration mark: format validation and, for UK plates, ' +
        'age identifier, region of registration, and (when API credentials are configured) DVLA ' +
        'tax/MOT status and DVSA MOT history. Australian plates get structural format validation ' +
        'and a list of states that commonly issue that shape (Australia has no national scheme ' +
        'encoding the state, unlike UK memory tags). Country is auto-detected unless given. ' +
        'Returns a structured report with per-check pass/warn/fail status.',
      inputSchema: {
        plate: plateArg,
        country: countryArg,
        includeVehicleData: z
          .boolean()
          .optional()
          .describe('Query the DVLA Vehicle Enquiry Service (default true; GB only)'),
        includeMotHistory: z
          .boolean()
          .optional()
          .describe('Query the DVSA MOT History API (default true; GB only)'),
        referenceDate: z
          .string()
          .datetime()
          .optional()
          .describe('Evaluate as if checked on this ISO date/time'),
      },
    },
    async (args) => {
      try {
        const check = await checker.check(args.plate, {
          country: args.country,
          includeVehicleData: args.includeVehicleData,
          includeMotHistory: args.includeMotHistory,
          referenceDate: args.referenceDate,
        });
        return ok(check);
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  );

  server.registerTool(
    'validate_plate_format',
    {
      title: 'Validate plate format',
      description:
        'Offline check of whether a string is a structurally valid UK or Australian registration ' +
        'mark. Country is auto-detected unless given.',
      inputSchema: { plate: plateArg, country: countryArg },
    },
    async (args) => {
      const normalized = normalizePlate(args.plate);
      const country = detectCountry(normalized, args.country);
      if (country === 'AU') {
        const classification = classifyAuPlate(normalized);
        return ok({
          input: args.plate,
          normalized,
          country,
          formatted: formatAuPlate(normalized, classification.shape),
          format: classification.shape,
          valid: classification.valid,
          likelyStates: classification.likelyStates,
          reason: classification.reason,
        });
      }
      const classification = classifyPlate(normalized);
      return ok({
        input: args.plate,
        normalized,
        country: country === 'unknown' ? 'unknown' : 'GB',
        formatted: formatPlate(normalized, classification.format),
        ...classification,
      });
    },
  );

  server.registerTool(
    'decode_plate',
    {
      title: 'Decode plate age and region',
      description:
        'Offline decode of a UK plate: the registration date range from the age identifier and ' +
        'the DVLA office / region from the memory tag. Australian plates have no equivalent ' +
        'national age/region scheme, so only the format and likely issuing states are returned. ' +
        'Country is auto-detected unless given. No external calls.',
      inputSchema: { plate: plateArg, country: countryArg },
    },
    async (args) => {
      const normalized = normalizePlate(args.plate);
      const country = detectCountry(normalized, args.country);
      if (country === 'AU') {
        const classification = classifyAuPlate(normalized);
        return ok({
          normalized,
          country,
          format: classification.shape,
          valid: classification.valid,
          age: null,
          likelyStates: classification.likelyStates,
        });
      }
      const { format, valid } = classifyPlate(normalized);
      const age = decodeAge(normalized, format, new Date());
      const region = format === 'current' ? lookupMemoryTag(normalized.slice(0, 2)) : null;
      return ok({
        normalized,
        country: country === 'unknown' ? 'unknown' : 'GB',
        format,
        valid,
        age,
        region,
      });
    },
  );

  server.registerTool(
    'dvla_vehicle_enquiry',
    {
      title: 'DVLA Vehicle Enquiry Service lookup',
      description:
        'Fetch make, colour, year, fuel type, tax status and MOT status for a registration from ' +
        'the DVLA VES API. Requires DVLA_VES_API_KEY.',
      inputSchema: { plate: plateArg },
    },
    async (args) => {
      if (!vesProvider?.configured) return fail('DVLA_VES_API_KEY is not configured');
      const result = await vesProvider.lookup(normalizePlate(args.plate));
      return result.ok ? ok(result.data) : fail(result.message ?? result.reason ?? 'lookup failed');
    },
  );

  server.registerTool(
    'mot_history',
    {
      title: 'DVSA MOT history lookup',
      description:
        'Fetch the full MOT test history (results, mileage, defects) for a registration from the ' +
        'DVSA MOT History API. Requires MOT_CLIENT_ID / MOT_CLIENT_SECRET / MOT_API_KEY / MOT_TOKEN_URL.',
      inputSchema: { plate: plateArg },
    },
    async (args) => {
      if (!motProvider?.configured)
        return fail('DVSA MOT History API credentials are not configured');
      const result = await motProvider.lookup(normalizePlate(args.plate));
      return result.ok ? ok(result.data) : fail(result.message ?? result.reason ?? 'lookup failed');
    },
  );

  server.registerTool(
    'beacon_search',
    {
      title: 'Search the Beacon index',
      description: 'Full-text search against a running Beacon Search instance.',
      inputSchema: {
        query: z.string().describe('Search query (blank returns the newest documents)'),
        limit: z.number().int().min(1).max(50).optional(),
        tags: z.array(z.string()).optional().describe('Only return documents with all these tags'),
        source: z.string().optional(),
      },
    },
    async (args) => {
      try {
        return ok(
          await beacon.search({
            q: args.query,
            limit: args.limit,
            tags: args.tags,
            source: args.source,
          }),
        );
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  );

  server.registerTool(
    'beacon_index_document',
    {
      title: 'Add a document to the Beacon index',
      description: 'Create or replace a document in a running Beacon Search instance.',
      inputSchema: {
        title: z.string().min(1),
        body: z.string().default(''),
        url: z.string().url().optional(),
        tags: z.array(z.string()).optional(),
        source: z.string().optional(),
      },
    },
    async (args) => {
      try {
        return ok(await beacon.addDocument(args));
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  );

  server.registerTool(
    'beacon_stats',
    {
      title: 'Beacon index statistics',
      description: 'Document counts, top tags and sources from a running Beacon Search instance.',
      inputSchema: {},
    },
    async () => {
      try {
        return ok(await beacon.stats());
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  );

  return server;
}
