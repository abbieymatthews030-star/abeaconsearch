/** Coarse source kind shown on results and used for filtering. */
export type SourceType = 'forum' | 'archive' | 'official' | 'news' | 'blog' | 'academic';

export const SOURCE_TYPES: readonly SourceType[] = [
  'forum',
  'archive',
  'official',
  'news',
  'blog',
  'academic',
] as const;

const FORUM_HOSTS = [
  'reddit.com',
  'old.reddit.com',
  'news.ycombinator.com',
  'ycombinator.com',
  'stackoverflow.com',
  'stackexchange.com',
  'discourse.org',
  'lobste.rs',
  'slashdot.org',
  'quora.com',
  'disqus.com',
];

const ARCHIVE_HOSTS = [
  'archive.org',
  'web.archive.org',
  'archive.is',
  'archive.ph',
  'archive.today',
  'commoncrawl.org',
  'openlibrary.org',
  'gutenberg.org',
  'loc.gov',
];

const NEWS_HOSTS = [
  'bbc.co.uk',
  'bbc.com',
  'reuters.com',
  'apnews.com',
  'nytimes.com',
  'theguardian.com',
  'washingtonpost.com',
  'cnn.com',
  'npr.org',
  'aljazeera.com',
  'ft.com',
  'wsj.com',
  'bloomberg.com',
  'techcrunch.com',
  'arstechnica.com',
  'theverge.com',
  'wired.com',
];

const ACADEMIC_HOSTS = [
  'arxiv.org',
  'openalex.org',
  'doi.org',
  'crossref.org',
  'doaj.org',
  'europepmc.org',
  'nih.gov',
  'ncbi.nlm.nih.gov',
  'pubmed.ncbi.nlm.nih.gov',
  'scholar.google.com',
  'semanticscholar.org',
  'acm.org',
  'ieee.org',
  'springer.com',
  'nature.com',
  'science.org',
  'jstor.org',
  'ssrn.com',
];

const SEO_MEGA = new Set([
  'wikipedia.org',
  'youtube.com',
  'facebook.com',
  'twitter.com',
  'x.com',
  'linkedin.com',
  'instagram.com',
  'pinterest.com',
  'amazon.com',
  'ebay.com',
  'medium.com',
  'quora.com',
  'forbes.com',
  'businessinsider.com',
  'msn.com',
  'yahoo.com',
  'bing.com',
  'google.com',
]);

const OFFICIAL_EXACT = ['europa.eu', 'un.org', 'who.int', 'imf.org', 'worldbank.org', 'oecd.org'];

function hostMatches(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

function hostnameOf(url: string | undefined, domain?: string): string | undefined {
  if (domain) return domain.toLowerCase().replace(/^www\./, '');
  if (!url) return undefined;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

/**
 * Label a hit by publisher shape. Provider name is a tie-breaker when the
 * host alone is ambiguous (HN story linking out still counts as forum).
 */
export function classifySourceType(input: {
  url?: string;
  domain?: string;
  provider?: string;
}): SourceType {
  const host = hostnameOf(input.url, input.domain);
  const provider = (input.provider ?? '').toLowerCase();

  if (
    provider.includes('hacker news') ||
    provider.includes('reddit') ||
    (host && FORUM_HOSTS.some((h) => hostMatches(host, h)))
  ) {
    return 'forum';
  }
  if (
    provider.includes('wayback') ||
    provider.includes('common crawl') ||
    provider.includes('internet archive') ||
    (host && ARCHIVE_HOSTS.some((h) => hostMatches(host, h)))
  ) {
    return 'archive';
  }
  if (
    provider.includes('openalex') ||
    provider.includes('crossref') ||
    provider.includes('arxiv') ||
    provider.includes('europe pmc') ||
    provider.includes('doaj') ||
    provider.includes('library of congress') ||
    (host && ACADEMIC_HOSTS.some((h) => hostMatches(host, h))) ||
    (host && (host.endsWith('.edu') || host.endsWith('.ac.uk') || host.endsWith('.edu.au')))
  ) {
    return 'academic';
  }
  if (
    host &&
    (host === 'gov' ||
      host.endsWith('.gov') ||
      host === 'gov.uk' ||
      host.endsWith('.gov.uk') ||
      host === 'gov.au' ||
      host.endsWith('.gov.au') ||
      host === 'nhs.uk' ||
      host.endsWith('.nhs.uk') ||
      host.endsWith('.mil') ||
      host.endsWith('.int') ||
      OFFICIAL_EXACT.some((h) => hostMatches(host, h)))
  ) {
    return 'official';
  }
  if (host && NEWS_HOSTS.some((h) => hostMatches(host, h))) return 'news';
  if (provider.includes('marginalia')) return 'blog';
  if (host && (host.includes('blog') || host.endsWith('.blog'))) return 'blog';
  // Small / independent hosts default to blog rather than news.
  if (host && !SEO_MEGA.has(host) && host.split('.').length <= 3) return 'blog';
  return 'news';
}

/** Domains that tend to drown out long-tail results in mainstream ranking. */
export function isSeoMegaDomain(domain: string | undefined): boolean {
  if (!domain) return false;
  const host = domain.toLowerCase().replace(/^www\./, '');
  return [...SEO_MEGA].some((mega) => hostMatches(host, mega));
}

/** Small independent-looking host (not a mega SEO property). */
export function isIndieDomain(domain: string | undefined): boolean {
  if (!domain) return false;
  const host = domain.toLowerCase().replace(/^www\./, '');
  if (isSeoMegaDomain(host)) return false;
  if (host.endsWith('.gov') || host.endsWith('.edu') || host.endsWith('.ac.uk')) return false;
  const labels = host.split('.');
  // example.com, tilde.club, personal.neocities.org-style short hosts
  return labels.length <= 3 && !host.includes('cdn.') && !host.includes('static.');
}
