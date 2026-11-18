export { browseOnion, type BrowseOptions, type BrowseResult } from './browse.js';
export { isOnionHostname, onionBrowsePath, parseOnionUrl } from './onion.js';
export {
  curatedTorDirectoryHits,
  searchTorNetwork,
  torHitsToDisplay,
  type TorSearchHit,
  type TorSearchOptions,
} from './search.js';
export {
  probeTorSocks,
  torFetch,
  type TorFetchOptions,
  type TorFetchResult,
} from './socks-fetch.js';

export interface TorStatus {
  enabled: boolean;
  socksUrl: string;
  reachable: boolean;
  isTor?: boolean;
  exitIp?: string;
  error?: string;
  checkedAt: string;
}
