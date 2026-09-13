import type { AuPlateShape } from './types.js';

export interface AuPlateClassification {
  shape: AuPlateShape;
  valid: boolean;
  /**
   * States/territories that commonly issue this shape. This is a hint from
   * the character pattern only — Australia has no national scheme like the
   * UK's DVLA memory tags, so it is not a determination of origin.
   */
  likelyStates: string[];
  reason?: string;
}

// Structural shapes seen on current general-issue Australian passenger
// plates. Personalised, slimline, historic, trade and other special series
// vary widely between (and within) states and are not covered here.
const NSW_STYLE = /^[A-Z]{2}[0-9]{2}[A-Z]{2}$/; // e.g. AB12CD
const QLD_STYLE = /^[0-9]{3}[A-Z]{3}$/; // e.g. 123ABC
const GENERAL_STYLE = /^[A-Z]{3}[0-9]{3}$/; // e.g. ABC123

/**
 * Classify a normalized string against known current Australian plate
 * shapes. A match means "structurally plausible as an AU plate", not proof
 * of which state issued it — see {@link AuPlateClassification.likelyStates}.
 */
export function classifyAuPlate(normalized: string): AuPlateClassification {
  const plate = normalized;

  if (plate.length === 0) {
    return { shape: 'unknown', valid: false, likelyStates: [], reason: 'empty registration' };
  }
  if (plate.length < 2 || plate.length > 8) {
    return {
      shape: 'unknown',
      valid: false,
      likelyStates: [],
      reason: 'wrong length for a standard Australian plate',
    };
  }

  if (NSW_STYLE.test(plate)) {
    return { shape: 'nsw-style', valid: true, likelyStates: ['New South Wales'] };
  }
  if (QLD_STYLE.test(plate)) {
    return { shape: 'qld-style', valid: true, likelyStates: ['Queensland'] };
  }
  if (GENERAL_STYLE.test(plate)) {
    return {
      shape: 'general-au',
      valid: true,
      likelyStates: [
        'Victoria',
        'South Australia',
        'Tasmania',
        'Northern Territory',
        'Western Australia',
        'Australian Capital Territory',
      ],
    };
  }

  return {
    shape: 'unknown',
    valid: false,
    likelyStates: [],
    reason:
      'does not match a common current Australian plate shape (personalised, slimline, ' +
      'historic and trade plates vary and are not covered)',
  };
}

/** Insert the conventional display spacing for a given AU plate shape. */
export function formatAuPlate(normalized: string, shape: AuPlateShape): string {
  switch (shape) {
    case 'nsw-style': {
      const m = /^([A-Z]{2})([0-9]{2})([A-Z]{2})$/.exec(normalized);
      return m ? `${m[1]} ${m[2]} ${m[3]}` : normalized;
    }
    case 'qld-style': {
      const m = /^([0-9]{3})([A-Z]{3})$/.exec(normalized);
      return m ? `${m[1]} ${m[2]}` : normalized;
    }
    case 'general-au': {
      const m = /^([A-Z]{3})([0-9]{3})$/.exec(normalized);
      return m ? `${m[1]} ${m[2]}` : normalized;
    }
    default:
      return normalized;
  }
}

/** The road authority each state/territory uses for its own rego checks and renewals. */
export const AU_STATE_AUTHORITIES: Record<string, string> = {
  'New South Wales': 'Service NSW',
  Victoria: 'VicRoads (Dept. of Transport and Planning)',
  Queensland: 'Department of Transport and Main Roads',
  'Western Australia': 'Department of Transport (WA)',
  'South Australia': 'Service SA',
  Tasmania: 'Service Tasmania',
  'Northern Territory': 'MVR (Dept. of Logistics and Infrastructure)',
  'Australian Capital Territory': 'Access Canberra',
};
