import type { CheckItem, PlateAge, PlateClassification, PlateRegion } from '../types.js';

/** ISO 3166-1 alpha-2 code for a plate jurisdiction (GB = United Kingdom). */
export type CountryCode = string;

export interface CountryInfo {
  code: CountryCode;
  name: string;
  /** Local name for the registration mark (e.g. "number plate", "kennzeichen"). */
  plateLabel: string;
  /** Example shown in UI help text. */
  example: string;
  /** Input placeholder. */
  placeholder: string;
  /** Max characters accepted in the input field (including spaces/dashes). */
  maxInputLength: number;
  /** Official / issuing authority label for notices. */
  authority: string;
  /** Whether this build can query a live vehicle record API for the country. */
  liveVehicleData: boolean;
  /** Whether this build can query inspection / roadworthiness history. */
  liveInspectionHistory: boolean;
  /** Short capability summary for the country picker. */
  summary: string;
}

export interface CountryDecodeResult {
  age: PlateAge | null;
  region: PlateRegion | null;
  /** Extra offline checks unique to this country (beyond format/characters). */
  checks?: CheckItem[];
  notices?: string[];
}

export interface CountryDefinition extends CountryInfo {
  classify(normalized: string): PlateClassification;
  formatDisplay(normalized: string, format: string): string;
  decode(normalized: string, format: string, reference: Date): CountryDecodeResult;
}
