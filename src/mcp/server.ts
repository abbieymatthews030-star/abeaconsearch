import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config } from '../core/config.js';
import { resolveCountry } from '../core/plate/countries/index.js';
import { normalizePlate } from '../core/plate/format.js';
import { createPlateChecker } from '../core/plate/index.js';
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
        'Tools for worldwide number-plate analysis (offline format/age/region by country, ' +
        'plus optional UK DVLA and DVSA lookups) and for searching / adding documents in a ' +
        'running Beacon Search instance.',
    },
  );

  const plateArg = z
    .string()
    .min(1)
    .max(24)
    .describe('A vehicle registration mark, e.g. "AB12 CDE" or "AB-123-CD"');

  const countryArg = z
    .string()
    .min(2)
    .max(32)
    .optional()
    .describe('ISO 3166-1 alpha-2 country code (default GB). Examples: GB, US, DE, FR, AU, IE');

  server.registerTool(
    'check_number_plate',
    {
      title: 'Check a number plate',
      description:
        'Run automatic checks on a registration mark for a selected country: format validation, ' +
        'age/region decode where the national system encodes them, and (for GB, when credentials ' +
        'are configured) DVLA tax/MOT status and DVSA MOT history.',
      inputSchema: {
        plate: plateArg,
        country: countryArg,
        includeVehicleData: z
          .boolean()
          .optional()
          .describe('Query live vehicle data when the country supports it (GB: DVLA VES)'),
        includeMotHistory: z
          .boolean()
          .optional()
          .describe('Query inspection history when supported (GB: DVSA MOT)'),
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
    'list_plate_countries',
    {
      title: 'List plate countries',
      description:
        'List jurisdictions the plate checker supports, with examples and whether live vehicle ' +
        'or inspection APIs are wired.',
      inputSchema: {},
    },
    async () =>
      ok({
        defaultCountry: checker.capabilities.defaultCountry,
        countries: checker.capabilities.countries,
      }),
  );

  server.registerTool(
    'validate_plate_format',
    {
      title: 'Validate plate format',
      description:
        'Offline check of whether a string is a structurally valid registration mark for a country.',
      inputSchema: { plate: plateArg, country: countryArg },
    },
    async (args) => {
      const country = resolveCountry(args.country);
      const normalized = normalizePlate(args.plate);
      const classification = country.classify(normalized);
      return ok({
        input: args.plate,
        country: { code: country.code, name: country.name },
        normalized,
        formatted: country.formatDisplay(normalized, classification.format),
        ...classification,
      });
    },
  );

  server.registerTool(
    'decode_plate',
    {
      title: 'Decode plate age and region',
      description:
        'Offline decode of a plate for a country: age / series identifiers and region / office ' +
        'codes where the national system encodes them. No external calls.',
      inputSchema: { plate: plateArg, country: countryArg },
    },
    async (args) => {
      const country = resolveCountry(args.country);
      const normalized = normalizePlate(args.plate);
      const { format, valid } = country.classify(normalized);
      const decoded = country.decode(normalized, format, new Date());
      return ok({
        country: { code: country.code, name: country.name },
        normalized,
        format,
        valid,
        age: decoded.age,
        region: decoded.region,
        notices: decoded.notices,
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
        query: z.string().describe('Search query (blank lists documents newest-first)'),
        limit: z.number().int().min(1).max(50).optional(),
        tags: z.array(z.string()).optional().describe('Only return documents with all these tags'),
        source: z.string().optional(),
      },
    },
    async (args) => {
      try {
        const blank = args.query.trim().length === 0;
        return ok(
          await beacon.search({
            q: args.query,
            limit: args.limit,
            tags: args.tags,
            source: args.source,
            sort: blank ? 'newest' : undefined,
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
