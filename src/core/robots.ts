import { fetchWithTimeout } from './http.js';

/**
 * Minimal robots.txt matcher. Understands `User-agent`, `Disallow` and `Allow`
 * for the `*` group and for an explicitly named bot. Longest-match wins, which
 * matches the de-facto behaviour of major crawlers.
 */
export class RobotsRules {
  private readonly rules: Array<{ allow: boolean; path: string }> = [];

  constructor(body: string, userAgent: string) {
    const uaToken = userAgent.toLowerCase().split('/')[0] ?? userAgent.toLowerCase();
    let groupAgents: string[] = [];
    let capturing = false;
    const collected: Array<{ agents: string[]; rules: Array<{ allow: boolean; path: string }> }> =
      [];
    let current: { agents: string[]; rules: Array<{ allow: boolean; path: string }> } | null = null;

    for (const rawLine of body.split(/\r?\n/)) {
      const line = rawLine.replace(/#.*$/, '').trim();
      if (line === '') continue;
      const sepAt = line.indexOf(':');
      if (sepAt === -1) continue;
      const field = line.slice(0, sepAt).trim().toLowerCase();
      const value = line.slice(sepAt + 1).trim();

      if (field === 'user-agent') {
        if (capturing && current) {
          collected.push(current);
          current = null;
        }
        groupAgents.push(value.toLowerCase());
        capturing = false;
      } else if (field === 'allow' || field === 'disallow') {
        if (!current) {
          current = { agents: groupAgents, rules: [] };
          groupAgents = [];
        }
        capturing = true;
        if (value !== '' || field === 'disallow') {
          current.rules.push({ allow: field === 'allow', path: value });
        }
      }
    }
    if (current) collected.push(current);

    const relevant = collected.filter(
      (g) => g.agents.includes('*') || g.agents.some((a) => a !== '' && uaToken.includes(a)),
    );
    const specific = collected.filter((g) => g.agents.some((a) => a !== '' && uaToken.includes(a)));
    for (const group of specific.length > 0 ? specific : relevant) {
      this.rules.push(...group.rules);
    }
  }

  isAllowed(pathname: string): boolean {
    let decision = true;
    let matchLength = -1;
    for (const rule of this.rules) {
      if (rule.path === '') continue;
      if (pathname.startsWith(rule.path) && rule.path.length > matchLength) {
        matchLength = rule.path.length;
        decision = rule.allow;
      }
    }
    return decision;
  }
}

export type RobotsFetchStatus = 'ok' | 'missing' | 'error';

export interface RobotsFetchResult {
  rules: RobotsRules;
  status: RobotsFetchStatus;
}

export async function fetchRobots(
  origin: string,
  userAgent: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<RobotsFetchResult> {
  try {
    const response = await fetchWithTimeout(`${origin}/robots.txt`, {
      headers: { 'user-agent': userAgent },
      timeoutMs,
      fetchImpl,
    });
    if (!response.ok) {
      return { rules: new RobotsRules('', userAgent), status: 'missing' };
    }
    return { rules: new RobotsRules(await response.text(), userAgent), status: 'ok' };
  } catch {
    return { rules: new RobotsRules('', userAgent), status: 'error' };
  }
}
