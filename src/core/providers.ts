import { createLlmSynthesizers } from './answer/providers/llm.js';
import { describeWebProviders } from './answer/providers/web-search.js';
import type { Config } from './config.js';
import { lookupDomain } from './lookups/domain.js';
import type { PlateChecker } from './plate/checker.js';
import type { PersistentEngine } from './store.js';

export type ProviderGroup = 'web' | 'network' | 'vehicle' | 'ai';
export type ProviderStatusValue =
  'connected' | 'available' | 'disabled' | 'not_configured' | 'error';

export interface ProviderStatus {
  id: string;
  label: string;
  group: ProviderGroup;
  status: ProviderStatusValue;
  detail: string;
  /** Present once this provider has been test-probed this session. */
  latencyMs?: number;
  lastCheckedAt?: string;
  testable: boolean;
}

export interface ProvidersDeps {
  config: Config;
  engine: PersistentEngine;
  plateChecker: PlateChecker;
}

/**
 * Every data source Beacon can actually use, derived live from config/
 * capability flags — nothing here is invented. A provider with no remote
 * endpoint (the local index, the crawler) is always `available` and isn't
 * testable; everything else reflects whether it's configured, and — once
 * {@link testProvider} has been run — the result of that probe.
 */
interface StaticStatus {
  id: string;
  label: string;
  group: ProviderGroup;
  configured: boolean;
  /** Shown when `configured` is false. */
  unconfiguredDetail: string;
  /** Shown when `configured` is true and no probe has run yet. */
  configuredDetail: string;
}

/** Apply the last probe result (if any) on top of a provider's static configured/unconfigured state. */
function resolve(entry: StaticStatus, cache: ProbeCache): ProviderStatus {
  if (!entry.configured) {
    return {
      id: entry.id,
      label: entry.label,
      group: entry.group,
      status: 'not_configured',
      detail: entry.unconfiguredDetail,
      testable: false,
    };
  }
  const probe = cache.get(entry.id);
  return {
    id: entry.id,
    label: entry.label,
    group: entry.group,
    status: probe?.status ?? 'available',
    detail: probe?.detail ?? entry.configuredDetail,
    latencyMs: probe?.latencyMs,
    lastCheckedAt: probe?.at,
    testable: true,
  };
}

export function listProviders(deps: ProvidersDeps, cache: ProbeCache): ProviderStatus[] {
  const { config } = deps;
  const webSpecs = describeWebProviders(config.answer);
  const activeWeb = webSpecs.filter((spec) => spec.provider);
  const llm = createLlmSynthesizers(config.answer);

  return [
    {
      id: 'local_index',
      label: 'Local full-text index',
      group: 'web',
      status: 'available',
      detail: `${deps.engine.size.toLocaleString()} document${deps.engine.size === 1 ? '' : 's'}`,
      testable: false,
    },
    {
      id: 'crawler',
      label: 'Web crawler',
      group: 'web',
      status: 'available',
      detail: 'fetches on demand, respects robots.txt',
      testable: false,
    },
    config.lookups.enabled
      ? resolve(
          {
            id: 'domain_lookups',
            label: 'Domain / IP lookups',
            group: 'network',
            configured: true,
            unconfiguredDetail: '',
            configuredDetail: 'DNS + RDAP, no API key',
          },
          cache,
        )
      : {
          id: 'domain_lookups',
          label: 'Domain / IP lookups',
          group: 'network',
          status: 'disabled',
          detail: 'disabled in Settings',
          testable: false,
        },
    resolve(
      {
        id: 'dvla_vehicle',
        label: 'DVLA vehicle data (UK)',
        group: 'vehicle',
        configured: deps.plateChecker.capabilities.vehicleData,
        unconfiguredDetail: 'set DVLA_VES_API_KEY to enable',
        configuredDetail: 'DVLA Vehicle Enquiry Service',
      },
      cache,
    ),
    resolve(
      {
        id: 'dvsa_mot',
        label: 'DVSA MOT history (UK)',
        group: 'vehicle',
        configured: deps.plateChecker.capabilities.motHistory,
        unconfiguredDetail: 'set MOT_CLIENT_ID / MOT_CLIENT_SECRET to enable',
        configuredDetail: 'DVSA MOT History API',
      },
      cache,
    ),
    resolve(
      {
        id: 'answer_web_search',
        label: 'Answer web search',
        group: 'ai',
        configured: activeWeb.length > 0,
        unconfiguredDetail: webSpecs
          .map((spec) => `${spec.label}: set ${spec.missingEnv.join(' or ')}`)
          .join('; '),
        configuredDetail: activeWeb.map((spec) => spec.label).join(', '),
      },
      cache,
    ),
    resolve(
      {
        id: 'answer_llm',
        label: 'Answer model (LLM)',
        group: 'ai',
        configured: llm.length > 0,
        unconfiguredDetail: 'no LLM key configured — answers use extractive synthesis',
        configuredDetail: llm.map((s) => s.name).join(', '),
      },
      cache,
    ),
  ];
}

interface ProbeResult {
  status: ProviderStatusValue;
  detail: string;
  latencyMs: number;
  at: string;
}

/** In-memory, per-process cache of the last `testProvider` result for each id. */
export class ProbeCache {
  private readonly results = new Map<string, ProbeResult>();
  get(id: string): ProbeResult | undefined {
    return this.results.get(id);
  }
  set(id: string, result: ProbeResult): void {
    this.results.set(id, result);
  }
}

/** Run a real, on-demand connectivity probe for one provider. Never throws. */
export async function testProvider(id: string, deps: ProvidersDeps): Promise<ProbeResult> {
  const startedAt = performance.now();
  const finish = (status: ProviderStatusValue, detail: string): ProbeResult => ({
    status,
    detail,
    latencyMs: Math.round(performance.now() - startedAt),
    at: new Date().toISOString(),
  });

  try {
    switch (id) {
      case 'domain_lookups': {
        if (!deps.config.lookups.enabled) return finish('disabled', 'disabled in Settings');
        const result = await lookupDomain('example.com', {
          timeoutMs: deps.config.lookups.timeoutMs,
        });
        return result.addresses.length > 0 || result.nameservers.length > 0
          ? finish('connected', 'DNS resolved example.com')
          : finish('error', result.notices.join('; ') || 'DNS lookup returned nothing');
      }
      case 'dvla_vehicle': {
        const provider = deps.plateChecker.providers.vehicle;
        if (!provider?.configured) return finish('not_configured', 'no API key configured');
        const result = await provider.lookup('AA00AAA');
        return result.ok || result.reason === 'not_found'
          ? finish('connected', 'DVLA responded')
          : finish('error', result.message ?? result.reason ?? 'request failed');
      }
      case 'dvsa_mot': {
        const provider = deps.plateChecker.providers.mot;
        if (!provider?.configured) return finish('not_configured', 'no credentials configured');
        const result = await provider.lookup('AA00AAA');
        return result.ok || result.reason === 'not_found'
          ? finish('connected', 'DVSA responded')
          : finish('error', result.message ?? result.reason ?? 'request failed');
      }
      case 'answer_web_search': {
        const specs = describeWebProviders(deps.config.answer);
        const active = specs.filter((spec) => spec.provider);
        if (active.length === 0) {
          const missing = specs
            .map((spec) => `${spec.label} (${spec.missingEnv.join(', ')})`)
            .join('; ');
          return finish('not_configured', `no web search provider configured: ${missing}`);
        }
        const settled = await Promise.allSettled(
          active.map(
            (spec) => spec.provider?.search('beacon connectivity test', 1) ?? Promise.resolve([]),
          ),
        );
        const ok = settled.filter((item) => item.status === 'fulfilled');
        if (ok.length === 0) {
          const first = settled.find((item) => item.status === 'rejected');
          const message =
            first && first.status === 'rejected' ? String(first.reason) : 'all providers failed';
          return finish('error', message);
        }
        return finish('connected', `${ok.length} of ${active.length} web providers responded`);
      }
      case 'answer_llm': {
        const synths = createLlmSynthesizers(deps.config.answer);
        if (synths.length === 0) return finish('not_configured', 'no LLM configured');
        const llm = synths[0];
        if (!llm) return finish('not_configured', 'no LLM configured');
        await llm.weave({
          query: 'connectivity test',
          extracts: [{ id: 1, source: 'test', text: 'OK.' }],
        });
        return finish('connected', `${llm.name} responded`);
      }
      default:
        return finish('error', 'unknown provider');
    }
  } catch (error) {
    return finish('error', error instanceof Error ? error.message : String(error));
  }
}
