import type { App } from 'obsidian';
import type { Snippet } from '../core/memory';
import {
  incomingLinkCounts,
  isVaultSearchable,
  passagesFor,
  type VaultFile,
} from '../core/vaultMap';

/**
 * The vault's notes for the map and for vault search, outside Mesa and the configuration folder. Passages are
 * kept in memory and a note is read again only when its modified time changes, so searching stays cheap.
 */
export class VaultIndex {
  private readonly passages = new Map<
    string,
    { mtime: number; items: Snippet[] }
  >();

  constructor(
    private readonly app: App,
    private readonly managedRoot: string,
    private readonly configDir: string,
  ) {}

  /** Every searchable note, with how many other notes link to it. */
  mapFiles(): VaultFile[] {
    const incoming = incomingLinkCounts(
      this.app.metadataCache.resolvedLinks,
      this.managedRoot,
      this.configDir,
    );
    return this.app.vault
      .getMarkdownFiles()
      .filter((file) =>
        isVaultSearchable(file.path, this.managedRoot, this.configDir),
      )
      .map((file) => ({
        path: file.path,
        mtime: file.stat.mtime,
        incomingLinks: incoming.get(file.path) ?? 0,
      }));
  }

  /** The passages of every searchable note, as they are now. Notes that were deleted are forgotten. */
  async passagesNow(): Promise<Snippet[]> {
    const live = new Set<string>();
    const out: Snippet[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!isVaultSearchable(file.path, this.managedRoot, this.configDir))
        continue;
      live.add(file.path);
      let entry = this.passages.get(file.path);
      if (!entry || entry.mtime !== file.stat.mtime) {
        const text = await this.app.vault.cachedRead(file);
        entry = {
          mtime: file.stat.mtime,
          items: passagesFor(file.path, text),
        };
        this.passages.set(file.path, entry);
      }
      out.push(...entry.items);
    }
    for (const path of [...this.passages.keys()])
      if (!live.has(path)) this.passages.delete(path);
    return out;
  }
}
