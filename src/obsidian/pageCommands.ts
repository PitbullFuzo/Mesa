import type AgentHQPlugin from '../main';
import { t } from '../core/i18n';
import { OBI_ID } from '../core/obi';
import { pickProject } from './projectModal';
import { GRAPH_VIEW } from './views/graphView';
import { VAULT_OVERVIEW_VIEW } from './views/overview';
import {
  ACTIVITY_VIEW,
  AGENT_VIEW,
  PROJECTS_VIEW,
  SCHEDULES_VIEW,
  SKILLS_VIEW,
  TEAM_VIEW,
} from './views/panels';

/** Command-palette commands that open a Mesa page or start a simple action. Every page also has one here. */
export function registerPageCommands(plugin: AgentHQPlugin): void {
  const page = (id: string, name: string, view: string) =>
    plugin.addCommand({ id, name, callback: () => plugin.openView(view) });
  plugin.addCommand({
    id: 'open-obi',
    name: t('cmd.openObi'),
    callback: () => plugin.openObi(),
  });
  plugin.addCommand({
    id: 'take-tour',
    name: t('cmd.tour'),
    callback: () => {
      plugin.workspace.restartTour();
      plugin.workspace.selectAgent(OBI_ID, 'chat');
    },
  });
  page('open-ai-graph', t('cmd.graph'), GRAPH_VIEW);
  page('open-vault-overview', t('cmd.overview'), VAULT_OVERVIEW_VIEW);
  plugin.addCommand({
    id: 'open-quick-chat',
    name: t('cmd.chat'),
    callback: () => plugin.openQuickChat(),
  });
  page('open-team-panel', t('cmd.team'), TEAM_VIEW);
  page('open-agent-panel', t('cmd.agent'), AGENT_VIEW);
  page('open-live-activity', t('cmd.activity'), ACTIVITY_VIEW);
  page('open-skills', t('cmd.skills'), SKILLS_VIEW);
  page('open-schedules', t('cmd.schedules'), SCHEDULES_VIEW);
  page('open-projects', t('cmd.projects'), PROJECTS_VIEW);
  plugin.addCommand({
    id: 'manage-projects',
    name: t('cmd.manageProjects'),
    callback: () => pickProject(plugin.app, plugin.workspace),
  });
  plugin.addCommand({
    id: 'new-agent',
    name: t('cmd.newAgent'),
    callback: () => plugin.workspace.requestCreateAgent(),
  });
  plugin.addCommand({
    id: 'stop-all-agents',
    name: t('cmd.stopAll'),
    callback: () => plugin.workspace.stopAll(),
  });
}
