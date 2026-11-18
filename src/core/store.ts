import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { writeJsonAtomic } from './fs-atomic.js';
import type { Logger } from './logger.js';
import { SearchEngine } from './search-engine.js';
import type { BeaconDocument, IndexSnapshot } from './types.js';

export interface PersistentEngineOptions {
  indexFile: string;
  debounceMs?: number;
  logger?: Logger;
}

function isSnapshot(value: unknown): value is IndexSnapshot {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { version?: unknown }).version === 1 &&
    Array.isArray((value as { documents?: unknown }).documents)
  );
}

function coerceDocument(raw: unknown): BeaconDocument | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.title !== 'string') return null;
  const now = new Date().toISOString();
  return {
    id: r.id,
    title: r.title,
    body: typeof r.body === 'string' ? r.body : '',
    url: typeof r.url === 'string' ? r.url : undefined,
    tags: Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === 'string') : [],
    source: typeof r.source === 'string' ? r.source : undefined,
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : now,
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : now,
  };
}

/**
 * A {@link SearchEngine} that loads from and transparently persists to a JSON
 * snapshot file. Writes are debounced and atomic (write-temp-then-rename).
 */
export class PersistentEngine extends SearchEngine {
  private readonly indexFile: string;
  private readonly debounceMs: number;
  private readonly logger?: Logger;
  private timer: NodeJS.Timeout | null = null;
  private writing: Promise<void> = Promise.resolve();
  private dirty = false;

  constructor(options: PersistentEngineOptions) {
    super({ onChange: () => this.scheduleSave() });
    this.indexFile = path.resolve(options.indexFile);
    this.debounceMs = options.debounceMs ?? 750;
    this.logger = options.logger;
  }

  async load(): Promise<void> {
    if (!existsSync(this.indexFile)) {
      this.logger?.info({ indexFile: this.indexFile }, 'no existing index; starting empty');
      return;
    }
    try {
      const parsed: unknown = JSON.parse(await readFile(this.indexFile, 'utf8'));
      const rawDocs = isSnapshot(parsed) ? parsed.documents : Array.isArray(parsed) ? parsed : [];
      const documents = rawDocs.map(coerceDocument).filter((d): d is BeaconDocument => d !== null);
      this.replaceAll(documents);
      this.dirty = false;
      this.lastPersistedAt = isSnapshot(parsed) ? parsed.savedAt : new Date().toISOString();
      this.logger?.info({ indexFile: this.indexFile, documents: documents.length }, 'index loaded');
    } catch (error) {
      this.logger?.error({ err: error, indexFile: this.indexFile }, 'failed to load index');
      throw new Error(`Could not read index file "${this.indexFile}": ${(error as Error).message}`);
    }
  }

  private scheduleSave(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.debounceMs);
    // Do not keep the event loop alive solely for a pending write.
    this.timer.unref?.();
  }

  /** Force any pending write to disk and wait for it to complete. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) {
      await this.writing;
      return;
    }
    this.dirty = false;
    const snapshot = this.toSnapshot();
    this.writing = this.writing.catch(() => undefined).then(() => this.writeSnapshot(snapshot));
    await this.writing;
  }

  private async writeSnapshot(snapshot: IndexSnapshot): Promise<void> {
    await writeJsonAtomic(this.indexFile, snapshot);
    this.lastPersistedAt = snapshot.savedAt;
    this.logger?.debug(
      { indexFile: this.indexFile, documents: snapshot.documents.length },
      'index persisted',
    );
  }

  async close(): Promise<void> {
    await this.flush();
  }
}
