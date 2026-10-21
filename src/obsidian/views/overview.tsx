import { ItemView, type WorkspaceLeaf } from 'obsidian';
import { createRoot, type Root } from 'react-dom/client';
import type { GraphAnalysis } from '../../core/graphMap';
import type { OverviewSettings } from '../../core/overviewForce';
import { OverviewCanvas } from './overviewContent';
import './overview.css';

export const VAULT_OVERVIEW_VIEW = 'agenthq-vault-overview';

/** The dots view of the vault: clusters as bubbles, their notes as dots. Built from the graph map data, no AI. */
export class VaultOverviewView extends ItemView {
  private root: Root | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly loadAnalysis: () => GraphAnalysis | null,
    private readonly openPath: (path: string) => void,
    private readonly settings: {
      get: () => OverviewSettings;
      save: (settings: OverviewSettings) => void;
    },
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VAULT_OVERVIEW_VIEW;
  }
  getDisplayText(): string {
    return 'Vault overview';
  }
  getIcon(): string {
    return 'circle-dot';
  }

  onOpen(): Promise<void> {
    this.unmount();
    this.contentEl.empty();
    this.contentEl.addClass('agenthq-overview');
    this.root = createRoot(this.contentEl);
    this.root.render(
      <OverviewCanvas
        load={this.loadAnalysis}
        onOpen={this.openPath}
        initial={this.settings.get()}
        onSettings={this.settings.save}
      />,
    );
    this.register(() => this.unmount());
    return Promise.resolve();
  }

  unmount(): void {
    this.root?.unmount();
    this.root = null;
  }

  onClose(): Promise<void> {
    this.unmount();
    return Promise.resolve();
  }
}
