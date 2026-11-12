import { Menu } from 'obsidian';
import { t } from '../core/i18n';
import type AgentHQPlugin from '../main';
import {
  MESA_PAGES,
  OPTIONAL_RIBBON_PAGES,
  type MesaPageId,
} from '../core/ribbon';
import { GRAPH_VIEW } from './views/graphView';
import { VAULT_OVERVIEW_VIEW } from './views/overview';
import {
  ACTIVITY_VIEW,
  PROJECTS_VIEW,
  SCHEDULES_VIEW,
  SKILLS_VIEW,
} from './views/panels';

/** The left-bar icons: Obi, Mesa chat and AI Graph always, one Mesa menu, and the extra page icons the owner ticked. */
export class MesaRibbon {
  private readonly extraIcons = new Map<string, HTMLElement>();

  constructor(private readonly plugin: AgentHQPlugin) {}

  register(): void {
    const { plugin } = this;
    plugin.addRibbonIcon('layout-grid', t('ribbon.mesa'), (event) => {
      this.openMenu(event);
    });
    plugin.addRibbonIcon('sparkles', t('page.obi'), () => {
      this.openPage('obi');
    });
    plugin.addRibbonIcon('network', t('ribbon.graph'), () => {
      void plugin.openView(GRAPH_VIEW);
    });
    plugin.addRibbonIcon('message-circle', t('page.chat'), (event) => {
      plugin.openQuickChat(event);
    });
    // Extra page icons: all are created, and only the ticked ones are shown (Settings → Ribbon icons).
    for (const page of OPTIONAL_RIBBON_PAGES)
      this.extraIcons.set(
        page.id,
        plugin.addRibbonIcon(page.icon, t(`page.${page.id}`), () => {
          this.openPage(page.id);
        }),
      );
    this.applyExtras();
  }

  /** Opens one of Mesa's pages by its id (used by the ribbon icons and the Mesa menu). */
  openPage(id: MesaPageId, event?: MouseEvent): void {
    const { plugin } = this;
    switch (id) {
      case 'activity':
        void plugin.openView(ACTIVITY_VIEW);
        return;
      case 'projects':
        void plugin.openView(PROJECTS_VIEW);
        return;
      case 'schedules':
        void plugin.openView(SCHEDULES_VIEW);
        return;
      case 'skills':
        void plugin.openView(SKILLS_VIEW);
        return;
      case 'overview':
        void plugin.openView(VAULT_OVERVIEW_VIEW);
        return;
      case 'graph':
        void plugin.openView(GRAPH_VIEW);
        return;
      case 'obi':
        plugin.openObi();
        return;
      case 'chat':
        plugin.openQuickChat(event);
        return;
    }
  }

  /** The "Mesa" ribbon icon: one menu with every Mesa page. */
  private openMenu(event: MouseEvent): void {
    const menu = new Menu();
    for (const page of MESA_PAGES)
      menu.addItem((item) =>
        item
          .setTitle(t(`page.${page.id}`))
          .setIcon(page.icon)
          .onClick(() => this.openPage(page.id)),
      );
    menu.showAtMouseEvent(event);
  }

  /** Shows the extra page icons the owner ticked and hides the rest. */
  applyExtras(): void {
    for (const [id, el] of this.extraIcons)
      el.toggle(this.plugin.settings.ribbonExtras.includes(id));
  }
}
