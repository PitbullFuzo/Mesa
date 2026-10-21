import { useEffect, useSyncExternalStore } from 'react';
import { Menu, type App } from 'obsidian';
import {
  OTHER_MODEL,
  modelSelectOptions,
  runtimeModelLabel,
} from '../../core/models';
import type { AgentTab, WorkspaceActions } from '../../core/workspace';
import { promptForName } from '../modals';

/**
 * The composer's runtime and model label. Clicking it changes the model (same save as Setup);
 * the runtime itself is changed in Setup, which the menu opens.
 */
export function ModelLabel({
  app,
  workspace,
  agentId,
  disabled,
  setTab,
}: {
  app: App;
  workspace: WorkspaceActions;
  agentId: string;
  disabled: boolean;
  setTab: (tab: AgentTab) => void;
}) {
  const state = useSyncExternalStore(
    workspace.subscribe,
    workspace.getSnapshot,
  );
  const agent = state.agents.find((entry) => entry.id === agentId);
  const runtime = agent?.runtime ?? '';
  useEffect(() => {
    if (runtime === 'opencode' || runtime === 'codex')
      void workspace.loadRuntimeModels(runtime);
  }, [runtime, workspace]);
  if (!agent) return null;
  const current = agent.model;
  const loaded = state.runtimeModels?.[runtime] ?? [];
  const save = (model: string) => {
    workspace
      .updateAgent(agentId, { model })
      .catch((error: unknown) => workspace.reportError(error));
  };
  function openMenu(anchor: HTMLElement) {
    const menu = new Menu();
    for (const choice of modelSelectOptions(runtime, current, loaded)) {
      if (choice.value === OTHER_MODEL)
        menu.addItem((item) => {
          item.setTitle(choice.label).onClick(() => {
            promptForName(
              app,
              'Model name',
              (name) => workspace.updateAgent(agentId, { model: name.trim() }),
              (error) => workspace.reportError(error),
              false,
              'Use',
              current,
            );
          });
        });
      else
        menu.addItem((item) => {
          item
            .setTitle(choice.label)
            .setChecked(choice.value === current)
            .onClick(() => save(choice.value));
        });
    }
    menu.addSeparator();
    menu.addItem((item) => {
      item.setTitle('Change AI tool in Setup…').onClick(() => setTab('setup'));
    });
    const rect = anchor.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom });
  }
  return (
    <button
      type="button"
      className="agenthq-model-label"
      aria-label="Runtime and model"
      title={
        disabled
          ? 'Wait for the reply to finish, or stop it'
          : 'Change the model'
      }
      disabled={disabled}
      onClick={(event) => openMenu(event.currentTarget)}
    >
      {runtimeModelLabel(runtime, agent.model, loaded)}
    </button>
  );
}
