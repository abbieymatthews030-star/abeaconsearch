import type { Config } from '../config.js';
import { slugify } from '../text.js';
import type { DocumentInput } from '../types.js';
import { PlateChecker } from './checker.js';
import { DvlaVesProvider } from './providers/dvla-ves.js';
import { MotHistoryProvider } from './providers/mot-history.js';
import type { PlateCheck } from './types.js';

export * from './types.js';
export { normalizePlate, classifyPlate, formatPlate } from './format.js';
export { classifyAuPlate, formatAuPlate, AU_STATE_AUTHORITIES } from './au-format.js';
export { detectCountry } from './country.js';
export { decodeAge } from './age.js';
export { lookupMemoryTag } from './regions.js';
export { PlateChecker } from './checker.js';
export { DvlaVesProvider } from './providers/dvla-ves.js';
export { MotHistoryProvider } from './providers/mot-history.js';

/** Build a {@link PlateChecker} wired to the providers enabled by `config`. */
export function createPlateChecker(
  config: Pick<Config, 'plate'>,
  fetchImpl?: typeof fetch,
): PlateChecker {
  const timeoutMs = config.plate.timeoutMs;
  return new PlateChecker({
    vehicleProvider: new DvlaVesProvider({
      apiKey: config.plate.dvlaVesApiKey,
      baseUrl: config.plate.dvlaVesBaseUrl,
      timeoutMs,
      fetchImpl,
    }),
    motProvider: new MotHistoryProvider({
      clientId: config.plate.motClientId,
      clientSecret: config.plate.motClientSecret,
      apiKey: config.plate.motApiKey,
      tokenUrl: config.plate.motTokenUrl,
      scope: config.plate.motScope,
      baseUrl: config.plate.motBaseUrl,
      timeoutMs,
      fetchImpl,
    }),
  });
}

/** Render a completed check as a searchable document for the Beacon index. */
export function plateCheckToDocument(check: PlateCheck): DocumentInput {
  const lines = [
    `Registration: ${check.formatted}`,
    `Country: ${check.country}`,
    `Format: ${check.format}`,
    `Result: ${check.summary.headline}`,
    check.age ? `Age: ${check.age.description}` : null,
    check.region ? `Region: ${check.region.office}, ${check.region.region}` : null,
    check.vehicle
      ? `Vehicle: ${[check.vehicle.colour, check.vehicle.make, check.vehicle.fuelType, check.vehicle.yearOfManufacture].filter(Boolean).join(' ')}`
      : null,
    '',
    ...check.checks.map((c) => `[${c.status.toUpperCase()}] ${c.label}: ${c.detail}`),
  ].filter((l): l is string => l !== null);

  const tags = [
    'plate-check',
    `plate:${check.format}`,
    `result:${check.summary.status}`,
    `country:${slugify(check.country)}`,
  ];
  if (check.region?.country) tags.push(`region-country:${slugify(check.region.country)}`);
  if (check.vehicle?.make) tags.push(`make:${slugify(check.vehicle.make)}`);

  return {
    id: `plate-${check.normalized || 'unknown'}`,
    title: `Plate check — ${check.formatted}`,
    body: lines.join('\n'),
    tags,
    source: 'plate-checker',
  };
}
