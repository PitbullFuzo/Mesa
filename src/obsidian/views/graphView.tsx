import { ItemView, type WorkspaceLeaf } from 'obsidian';
import { createRoot, type Root } from 'react-dom/client';
import type { WorkspaceActions } from '../../core/workspace';
import { GraphCanvas } from './graphCanvas';
import '@xyflow/react/dist/style.css';
import './graph.css';

export const GRAPH_VIEW = 'agenthq-graph';

export class GraphView extends ItemView {
  private root: Root | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly workspace: WorkspaceActions,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return GRAPH_VIEW;
  }
  getDisplayText(): string {
    return 'AI Graph';
  }
  getIcon(): string {
    return 'network';
  }

  onOpen(): Promise<void> {
    this.unmount();
    this.contentEl.empty();
    this.contentEl.addClass('agenthq-graph');
    this.root = createRoot(this.contentEl);
    this.root.render(<GraphCanvas workspace={this.workspace} />);
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
