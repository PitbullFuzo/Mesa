import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Agent } from '../../core/model';
import type { AgentSetupPatch } from '../../core/setup';
import { statusGlyph } from '../../core/quickChat';
import { agentDisplayName } from '../../core/obi';
import { OTHER_MODEL, modelSelectOptions } from '../../core/models';
import { agentOutsideFolders } from '../../core/folders';
import type { App } from 'obsidian';
import { ChatContent, HistoryContent } from './chatContent';
import { TasksContent } from './tasksContent';
import { InboxContent } from './inboxContent';
import {
  RUNTIME_OPTIONS,
  runtimeModelHint,
  runtimeReadWarning,
  commandsAsk,
  commandsOffered,
} from '../../core/runtimes/ids';
import { FULL_PERMISSION_WARNING } from '../../core/permissions';
import { M365_WARNING, m365UnavailableReason } from '../../core/m365/launch';
import {
  browserUnavailableReason,
  BROWSER_CODEX_WARNING,
  BROWSER_WARNING,
} from '../../core/browser';
import type {
  AgentPlacement,
  AgentTab,
  WorkspaceActions,
} from '../../core/workspace';

type Props = { workspace: WorkspaceActions };
type SetupDraft = Pick<
  Agent,
  | 'name'
  | 'role'
  | 'runtime'
  | 'model'
  | 'permission'
  | 'vaultAccess'
  | 'outsideFolders'
  | 'webAccess'
  | 'wholeComputerReadConfirmed'
  | 'canUseBrowser'
  | 'canUseM365'
  | 'noteTypes'
  | 'browserReadsConfirmed'
  | 'workdir'
  | 'verifier'
  | 'group'
  | 'skills'
  | 'instructions'
> & {
  /** Always a list in the form: an agent without its own list shows every allowed folder ticked. */
  outsideFolders: string[];
  /** Always a list in the form. */
  noteTypes: string[];
  runCommands: 'off' | 'allow' | 'ask';
};

const CODEX_OFF_LABEL =
  'Off: commands only inside its sandbox (folders you allow, no internet)';
const CODEX_ALLOW_WARNING =
  'No folder limits and internet on: this agent can change or delete any file and send data online.';

/** What Off and "Allow freely" mean for each runtime, shown under the select. */
function commandNote(runtime: string): string {
  if (runtime === 'codex')
    return 'Codex always runs commands. Off keeps them inside its sandbox: only the folders you allow, no internet. Allow freely removes the sandbox for this agent.';
  if (commandsOffered(runtime))
    return 'Commands run as you, in the agent’s working folder.';
  return 'Commands are not available for this tool, so this agent cannot run commands.';
}

function setupValues(agent: Agent, allowed: string[]): SetupDraft {
  return {
    name: agent.name,
    role: agent.role,
    runtime: agent.runtime,
    model: agent.model,
    permission: agent.permission,
    vaultAccess: agent.vaultAccess ?? 'off',
    outsideFolders: [...agentOutsideFolders(agent, allowed)],
    runCommands: agent.runCommands ?? 'off',
    webAccess: agent.webAccess ?? true,
    wholeComputerReadConfirmed: agent.wholeComputerReadConfirmed ?? false,
    canUseBrowser: agent.canUseBrowser ?? false,
    canUseM365: agent.canUseM365 ?? false,
    noteTypes: [...(agent.noteTypes ?? [])],
    browserReadsConfirmed: agent.browserReadsConfirmed ?? false,
    workdir: agent.workdir,
    verifier: agent.verifier,
    group: agent.group,
    skills: [...agent.skills],
    instructions: agent.instructions,
  };
}

function StatusDot({ agent, workspace }: Props & { agent: Agent }) {
  const state = useSyncExternalStore(
    workspace.subscribe,
    workspace.getSnapshot,
  );
  const status = state.chat?.agents[agent.id]?.status ?? 'offline';
  return (
    <span
      className={`agenthq-status agenthq-status-${status}`}
      title={status}
      aria-label={status}
    />
  );
}

export function TeamPanelContent({ workspace }: Props) {
  const state = useSyncExternalStore(
    workspace.subscribe,
    workspace.getSnapshot,
  );
  const renderAgent = (agent: Agent) => (
    <li key={agent.id}>
      <button
        className={`agenthq-team-agent ${state.selectedId === agent.id ? 'is-selected' : ''}`}
        aria-pressed={state.selectedId === agent.id}
        onClick={() => workspace.selectAgent(agent.id)}
      >
        <span>
          <StatusDot agent={agent} workspace={workspace} />{' '}
          <strong>{agent.name}</strong>
        </span>
        <small>
          {agent.role || 'No role'} ·{' '}
          {state.agents.find((entry) => entry.id === agent.reportsTo)?.name ??
            'No manager'}
        </small>
      </button>
      {agent.warnings.map((warning, index) => (
        <p className="agenthq-warning" key={index}>
          ⚠ {warning}
        </p>
      ))}
    </li>
  );
  const ungrouped = state.agents.filter(
    (agent) =>
      !agent.group || !state.groups.some((group) => group.id === agent.group),
  );
  return (
    <div className="agenthq-team">
      <header className="agenthq-panel-header">
        <h2>Team</h2>
        <button
          disabled={state.loading}
          onClick={() => workspace.requestCreateAgent()}
        >
          + Agent
        </button>
      </header>
      {state.loading && <p>Loading team notes…</p>}
      {state.error && <p className="agenthq-warning">{state.error}</p>}
      {state.groups.map((group) => (
        <details className="agenthq-team-group" key={group.id} open>
          <summary>{group.name}</summary>
          <ul>
            {state.agents
              .filter((agent) => agent.group === group.id)
              .map(renderAgent)}
          </ul>
        </details>
      ))}
      {ungrouped.length > 0 && (
        <details className="agenthq-team-group" open>
          <summary>Ungrouped</summary>
          <ul>{ungrouped.map(renderAgent)}</ul>
        </details>
      )}
      {state.invalidAgents.map((invalid) => (
        <div key={invalid.path} className="agenthq-invalid">
          <strong>⚠ {invalid.name}</strong>
          <p>{invalid.reason}</p>
          <button
            onClick={() => {
              void workspace
                .openNote(invalid.path)
                .catch((error: unknown) => workspace.reportError(error));
            }}
          >
            Open note
          </button>
        </div>
      ))}
      {!state.loading &&
        !state.agents.length &&
        !state.invalidAgents.length && <p>No agent notes found.</p>}
      <InboxContent workspace={workspace} />
    </div>
  );
}

function SetupForm({ agent, workspace }: Props & { agent: Agent }) {
  const [otherModel, setOtherModel] = useState(false);
  const state = useSyncExternalStore(
    workspace.subscribe,
    workspace.getSnapshot,
  );
  const allowed = state.allowedFolders ?? [];
  const [commandsAck, setCommandsAck] = useState(false);
  const [draft, setDraft] = useState<SetupDraft>(() =>
    setupValues(agent, allowed),
  );
  const runtimeModels = state.runtimeModels?.[draft.runtime] ?? [];
  useEffect(() => {
    if (draft.runtime === 'opencode' || draft.runtime === 'codex')
      void workspace.loadRuntimeModels(draft.runtime);
  }, [draft.runtime, workspace]);
  const [baseline, setBaseline] = useState<SetupDraft>(() =>
    setupValues(agent, allowed),
  );
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!dirty) {
      const values = setupValues(agent, allowed);
      setDraft(values);
      setBaseline(values);
    }
  }, [agent, dirty, allowed]);
  const change = <K extends keyof SetupDraft>(
    key: K,
    value: SetupDraft[K],
  ): void => {
    setDraft((previous) => ({
      ...previous,
      [key]: value,
      ...(key === 'wholeComputerReadConfirmed' && value === true
        ? { webAccess: false }
        : {}),
    }));
    setDirty(true);
    setError(null);
  };
  const patch = Object.fromEntries(
    Object.entries(draft).filter(
      ([key, value]) =>
        JSON.stringify(value) !==
        JSON.stringify(baseline[key as keyof SetupDraft]),
    ),
  ) as AgentSetupPatch;
  // Turning commands on needs the tick: the warning must be read first.
  const needsCommandsAck =
    draft.runCommands === 'allow' &&
    baseline.runCommands !== 'allow' &&
    !commandsAck;
  async function save(): Promise<void> {
    if (saving || Object.keys(patch).length === 0) return;
    if (needsCommandsAck) return;
    setSaving(true);
    setError(null);
    try {
      await workspace.updateAgent(agent.id, patch);
      setBaseline(draft);
      setDirty(false);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Could not save the changed fields.',
      );
      workspace.reportError(caught);
    } finally {
      setSaving(false);
    }
  }
  const browserBlock =
    browserUnavailableReason(
      draft.runtime,
      draft.wholeComputerReadConfirmed ?? false,
      state.browser?.engine ?? 'playwright',
      draft.browserReadsConfirmed,
    ) ||
    (!state.browser?.available
      ? (state.browser?.hint ?? 'Set up browser tools in Settings first.')
      : '');
  const m365Block = m365UnavailableReason(
    draft.runtime,
    state.m365?.connected ?? false,
  );
  return (
    <form
      className="agenthq-setup"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <p className="agenthq-help">
        Save changes writes only the fields you edited. ID:{' '}
        <code>{agent.id}</code>
      </p>
      <label>
        Name
        <input
          aria-label="Name"
          disabled={saving}
          value={draft.name}
          onChange={(event) => change('name', event.target.value)}
        />
      </label>
      <label>
        Role
        <input
          aria-label="Role"
          disabled={saving}
          value={draft.role}
          onChange={(event) => change('role', event.target.value)}
        />
      </label>
      <label>
        Runtime
        <select
          aria-label="Runtime"
          disabled={saving}
          value={draft.runtime}
          onChange={(event) => change('runtime', event.target.value)}
        >
          {[
            ...RUNTIME_OPTIONS,
            ...(state.developerMode
              ? [{ id: 'fake', label: 'Fake (developer)' }]
              : []),
          ].map((runtime) => (
            <option key={runtime.id} value={runtime.id}>
              {runtime.label}
            </option>
          ))}
          {!RUNTIME_OPTIONS.some((runtime) => runtime.id === draft.runtime) &&
            !(state.developerMode && draft.runtime === 'fake') && (
              <option value={draft.runtime}>{draft.runtime} (offline)</option>
            )}
        </select>
      </label>
      <label>
        Model
        <select
          aria-label="Model"
          disabled={saving}
          value={otherModel ? OTHER_MODEL : draft.model}
          onChange={(event) => {
            const value = event.currentTarget.value;
            if (value === OTHER_MODEL) setOtherModel(true);
            else {
              setOtherModel(false);
              change('model', value);
            }
          }}
        >
          {modelSelectOptions(draft.runtime, draft.model, runtimeModels).map(
            (choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ),
          )}
        </select>
      </label>
      {otherModel && (
        <label>
          Model name
          <input
            aria-label="Model name"
            disabled={saving}
            placeholder="Type a model name"
            value={draft.model}
            onChange={(event) => change('model', event.target.value)}
          />
        </label>
      )}
      {runtimeModelHint(draft.runtime) && (
        <p className="agenthq-help">{runtimeModelHint(draft.runtime)}</p>
      )}
      <label>
        Permission
        <select
          aria-label="Permission"
          disabled={saving}
          value={draft.permission}
          onChange={(event) =>
            change('permission', event.target.value as Agent['permission'])
          }
        >
          <option value="read-only">Read-only</option>
          <option value="edit">Edit</option>
          <option value="full" disabled>
            Full — not available yet
          </option>
        </select>
      </label>
      {draft.permission === 'full' && (
        <p className="agenthq-danger">{FULL_PERMISSION_WARNING}</p>
      )}
      {runtimeReadWarning(draft.runtime) && (
        <>
          <p className="agenthq-danger">{runtimeReadWarning(draft.runtime)}</p>
          <label>
            <input
              type="checkbox"
              aria-label="Whole computer read access"
              disabled={saving}
              checked={draft.wholeComputerReadConfirmed}
              onChange={(event) =>
                change('wholeComputerReadConfirmed', event.target.checked)
              }
            />{' '}
            Allow whole-computer reads (requires confirmation)
          </label>
        </>
      )}
      <label>
        Run commands
        <select
          aria-label="Run commands"
          disabled={saving}
          value={draft.runCommands}
          onChange={(event) => {
            change(
              'runCommands',
              event.target.value as SetupDraft['runCommands'],
            );
            setCommandsAck(false);
          }}
        >
          <option value="off">
            {draft.runtime === 'codex'
              ? CODEX_OFF_LABEL
              : 'Off: no commands (default)'}
          </option>
          <option value="ask" disabled={!commandsAsk(draft.runtime)}>
            Ask me each time: approve every command
          </option>
          <option value="allow" disabled={!commandsOffered(draft.runtime)}>
            Allow freely: run commands
          </option>
        </select>
      </label>
      {draft.runCommands === 'ask' && (
        <p className="agenthq-help">
          Every command shows an Approve or Reject card in this agent’s chat and
          does not run until you approve it. Nothing is remembered. A scheduled
          or looping run waits and adds an Inbox item.
        </p>
      )}
      {!commandsAsk(draft.runtime) && (
        <p className="agenthq-help">
          Ask me each time is not available for this tool: it cannot hold a
          command until you approve it.
        </p>
      )}
      {(draft.runtime === 'codex' || !commandsOffered(draft.runtime)) && (
        <p className="agenthq-help">{commandNote(draft.runtime)}</p>
      )}
      {draft.runCommands === 'allow' && (
        <div className="agenthq-danger">
          <p>
            {draft.runtime === 'codex'
              ? CODEX_ALLOW_WARNING
              : 'This agent can do anything you can do on this computer: install programs, change or delete any file, send data online.'}{' '}
            Only for agents you trust.
          </p>
          {draft.runtime !== 'codex' && (
            <p className="agenthq-help">{commandNote(draft.runtime)}</p>
          )}
          {baseline.runCommands !== 'allow' && (
            <label>
              <input
                type="checkbox"
                aria-label="I understand the command risk"
                checked={commandsAck}
                onChange={(event) =>
                  setCommandsAck(event.currentTarget.checked)
                }
              />{' '}
              I understand, and I want this agent to run commands.
            </label>
          )}
        </div>
      )}
      {!!state.noteTypes?.some((type) => type.enabled) && (
        <fieldset>
          <legend>Note types this agent may write</legend>
          <p className="agenthq-help">
            Only these vault folders become writable, nothing else in your
            vault. Choose them in Settings → Note destinations.
          </p>
          {state.noteTypes
            .filter((type) => type.enabled)
            .map((type) => (
              <label key={type.id}>
                <input
                  type="checkbox"
                  aria-label={`Write ${type.label}`}
                  disabled={saving}
                  checked={draft.noteTypes.includes(type.id)}
                  onChange={(event) =>
                    change(
                      'noteTypes',
                      event.target.checked
                        ? [...draft.noteTypes, type.id]
                        : draft.noteTypes.filter((id) => id !== type.id),
                    )
                  }
                />{' '}
                {type.label} → <code>{type.folder}/</code>
              </label>
            ))}
        </fieldset>
      )}
      <label>
        Vault access
        <select
          aria-label="Vault access"
          disabled={saving}
          value={draft.vaultAccess}
          onChange={(event) =>
            change('vaultAccess', event.target.value as Agent['vaultAccess'])
          }
        >
          <option value="off">Off — agent folders only</option>
          <option value="read">Read vault</option>
          <option value="write">Write vault</option>
        </select>
      </label>
      {draft.vaultAccess === 'write' && (
        <p className="agenthq-danger">
          Vault write access lets this agent change notes across the vault.
          Protected folders stay denied. Saving requires confirmation.
        </p>
      )}
      {allowed.length > 0 && (
        <fieldset className="agenthq-outside-folders">
          <legend>Outside folders this agent may use</legend>
          {allowed.map((folder) => (
            <label key={folder}>
              <input
                type="checkbox"
                aria-label={`Outside folder ${folder}`}
                disabled={saving}
                checked={draft.outsideFolders.includes(folder)}
                onChange={(event) =>
                  change(
                    'outsideFolders',
                    event.currentTarget.checked
                      ? [...draft.outsideFolders, folder]
                      : draft.outsideFolders.filter(
                          (entry) => entry !== folder,
                        ),
                  )
                }
              />{' '}
              {folder}
            </label>
          ))}
          <p className="agenthq-help">
            Only the folders you tick are passed to this agent&apos;s runs.
            Folders are added in Settings.
          </p>
        </fieldset>
      )}
      <label>
        <input
          aria-label="Web access"
          type="checkbox"
          disabled={saving}
          checked={draft.webAccess}
          onChange={(event) => change('webAccess', event.target.checked)}
        />{' '}
        Web access
      </label>
      {draft.wholeComputerReadConfirmed && draft.webAccess && (
        <p className="agenthq-warning">
          This agent can read your whole computer and search the web; a
          malicious page could try to trick it into leaking files.
        </p>
      )}
      {draft.vaultAccess !== 'off' && draft.webAccess && (
        <p className="agenthq-warning">
          This agent can read your vault and the web; a malicious page could try
          to trick it into leaking notes.
        </p>
      )}
      <label>
        <input
          aria-label="Can use browser"
          type="checkbox"
          disabled={saving || (!draft.canUseBrowser && !!browserBlock)}
          checked={draft.canUseBrowser}
          onChange={(e) => change('canUseBrowser', e.target.checked)}
        />{' '}
        Can use browser (requires confirmation)
      </label>
      {draft.runtime === 'codex' && draft.wholeComputerReadConfirmed && (
        <label>
          <input
            type="checkbox"
            aria-label="Allow the browser together with whole-computer reads"
            disabled={saving}
            checked={draft.browserReadsConfirmed}
            onChange={(event) =>
              change('browserReadsConfirmed', event.target.checked)
            }
          />{' '}
          Allow the browser together with whole-computer reads
        </label>
      )}
      <p className={browserBlock ? 'agenthq-warning' : 'agenthq-help'}>
        Browser engine: {state.browser?.engine ?? 'playwright'}.{' '}
        {browserBlock || 'Isolated Playwright is ready.'}
      </p>
      {draft.canUseBrowser && (
        <p className="agenthq-warning">{BROWSER_WARNING}</p>
      )}
      {draft.canUseBrowser &&
        draft.runtime === 'codex' &&
        draft.browserReadsConfirmed && (
          <p className="agenthq-danger">{BROWSER_CODEX_WARNING}</p>
        )}
      <label>
        <input
          aria-label="Can use Microsoft 365"
          type="checkbox"
          disabled={saving || (!draft.canUseM365 && !!m365Block)}
          checked={draft.canUseM365}
          onChange={(e) => change('canUseM365', e.target.checked)}
        />{' '}
        Can use Microsoft 365: mail, calendar, OneDrive (requires confirmation)
      </label>
      {m365Block && <p className="agenthq-warning">{m365Block}</p>}
      {draft.canUseM365 && <p className="agenthq-warning">{M365_WARNING}</p>}
      {draft.canUseM365 && draft.runCommands === 'allow' && (
        <p className="agenthq-danger">
          Microsoft 365 together with Run commands: Allow freely lets this agent
          read the run’s sign-in file. Use Ask me each time or Off.
        </p>
      )}
      <label>
        Working folder
        <input
          aria-label="Working folder"
          disabled={saving}
          placeholder="Default agent work folder"
          value={draft.workdir}
          onChange={(event) => change('workdir', event.target.value)}
        />
      </label>
      <label>
        Default verifier
        <select
          aria-label="Default verifier"
          disabled={saving}
          value={draft.verifier ?? ''}
          onChange={(event) => change('verifier', event.target.value || null)}
        >
          <option value="">None</option>
          {state.agents.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Group
        <select
          aria-label="Group"
          disabled={saving}
          value={draft.group ?? ''}
          onChange={(event) => change('group', event.target.value || null)}
        >
          <option value="">Ungrouped</option>
          {state.groups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.name}
            </option>
          ))}
          {draft.group &&
            !state.groups.some((group) => group.id === draft.group) && (
              <option value={draft.group}>{draft.group} (missing group)</option>
            )}
        </select>
      </label>
      <fieldset>
        <legend>Skills</legend>
        {state.skills.map((skill) => (
          <label className="agenthq-skill" key={skill.path}>
            <input
              type="checkbox"
              disabled={saving}
              checked={draft.skills.includes(skill.path)}
              onChange={(event) =>
                change(
                  'skills',
                  event.target.checked
                    ? [...draft.skills, skill.path]
                    : draft.skills.filter((path) => path !== skill.path),
                )
              }
            />
            {skill.name}
          </label>
        ))}
        {!state.skills.length && <p>No skill notes found.</p>}
      </fieldset>
      <label>
        Instructions
        <textarea
          aria-label="Instructions"
          disabled={saving}
          rows={8}
          value={draft.instructions}
          onChange={(event) => change('instructions', event.target.value)}
        />
      </label>
      {error && (
        <p role="alert" className="agenthq-warning">
          {error}
        </p>
      )}
      <div className="agenthq-setup-actions">
        <button
          className="mod-cta"
          type="submit"
          disabled={
            saving || Object.keys(patch).length === 0 || needsCommandsAck
          }
        >
          {saving ? 'Saving…' : 'Save changes'}
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={() => {
            setDraft(setupValues(agent, allowed));
            setBaseline(setupValues(agent, allowed));
            setDirty(false);
            setError(null);
          }}
        >
          Reset
        </button>
        <button
          type="button"
          onClick={() => {
            void workspace
              .openNote(agent.path)
              .catch((caught: unknown) => workspace.reportError(caught));
          }}
        >
          Open note
        </button>
        <button
          type="button"
          className="mod-warning"
          onClick={() => {
            void workspace
              .deleteAgent(agent.id)
              .catch((caught: unknown) => workspace.reportError(caught));
          }}
        >
          Delete agent
        </button>
      </div>
    </form>
  );
}

const TAB_LABELS: Record<AgentTab, string> = {
  chat: 'Chat',
  setup: 'Setup',
  tasks: 'Tasks',
  history: 'History',
};

/** One Agent tab: its own agent and its own Chat/Setup/Tasks/History view. */
export function AgentTabContent({
  workspace,
  app,
  agentId,
  tab: initialTab,
  onState,
  onMissing,
  location,
  onMove,
  onClose,
}: Props & {
  app: App;
  agentId: string;
  tab: AgentTab;
  onState: (value: { agentId: string; tab: AgentTab }) => void;
  onMissing: () => void;
  location?: 'side' | 'main' | 'window';
  onMove?: (target: AgentPlacement) => void;
  onClose?: () => void;
}) {
  const state = useSyncExternalStore(
    workspace.subscribe,
    workspace.getSnapshot,
  );
  const [tab, setTabState] = useState<AgentTab>(initialTab);
  const setTab = (next: AgentTab) => {
    setTabState(next);
    onState({ agentId, tab: next });
  };
  const known = state.agents.some((entry) => entry.id === agentId);
  useEffect(() => {
    // A tab whose agent was deleted closes itself; running agents are unaffected.
    if (!state.loading && !known) onMissing();
  }, [state.loading, known, onMissing]);
  return (
    <AgentPanelContent
      workspace={workspace}
      app={app}
      agentId={agentId}
      tab={tab}
      setTab={setTab}
      location={location}
      onMove={onMove}
      onClose={onClose}
    />
  );
}

export function AgentPanelContent({
  workspace,
  app,
  agentId,
  tab,
  setTab,
  location,
  onMove,
  onClose,
}: Props & {
  app: App;
  agentId?: string;
  tab?: AgentTab;
  setTab?: (tab: AgentTab) => void;
  location?: 'side' | 'main' | 'window';
  onMove?: (target: AgentPlacement) => void;
  onClose?: () => void;
}) {
  const state = useSyncExternalStore(
    workspace.subscribe,
    workspace.getSnapshot,
  );
  const focusId = agentId ?? state.selectedId;
  const currentTab = tab ?? state.agentTab;
  const changeTab = setTab ?? ((next: AgentTab) => workspace.setAgentTab(next));
  const [historyScope, setHistoryScope] = useState<
    'all' | `group:${string}` | null
  >(null);
  useEffect(() => {
    if (currentTab !== 'history') setHistoryScope(null);
  }, [currentTab]);
  const agent = state.agents.find((entry) => entry.id === focusId);
  if (!agent)
    return (
      <div className="agenthq-agent">
        <h2>Agent</h2>
        <p>Select an agent in the graph or Team panel.</p>
        {state.error && <p className="agenthq-warning">{state.error}</p>}
      </div>
    );
  const option = (entry: Agent) => {
    const status = state.chat?.agents[entry.id]?.status ?? 'offline';
    const role = entry.role ? ` — ${entry.role}` : '';
    return (
      <option key={entry.id} value={entry.id}>
        {`${statusGlyph(status)} ${agentDisplayName(entry)}${role}`}
      </option>
    );
  };
  const inHistory = currentTab === 'history';
  const historyLabel = (entry: Agent) =>
    `${statusGlyph(state.chat?.agents[entry.id]?.status ?? 'offline')} ${agentDisplayName(entry)}`;
  const grouped = state.groups.filter((group) =>
    state.agents.some((entry) => entry.group === group.id),
  );
  const ungrouped = state.agents.filter(
    (entry) => !state.groups.some((group) => group.id === entry.group),
  );
  return (
    <div className="agenthq-agent">
      <div className="agenthq-agent-sticky">
        <header className="agenthq-panel-header">
          <h2>{agentDisplayName(agent)}</h2>
          <StatusDot agent={agent} workspace={workspace} />
        </header>
        <p className="agenthq-help">{agent.role || 'No role'}</p>
        <div className="agenthq-switcher">
          {currentTab !== 'chat' && (
            <button type="button" onClick={() => changeTab('chat')}>
              ← Chat
            </button>
          )}
          <select
            aria-label={inHistory ? 'History scope' : 'Agent'}
            value={inHistory ? (historyScope ?? `agent:${agent.id}`) : agent.id}
            onChange={(event) => {
              const value = event.currentTarget.value;
              if (!inHistory) {
                workspace.selectAgent(value, 'chat');
              } else if (value === 'all' || value.startsWith('group:')) {
                setHistoryScope(value as 'all' | `group:${string}`);
              } else {
                setHistoryScope(null);
                workspace.selectAgent(value.slice('agent:'.length), 'history');
              }
            }}
          >
            {inHistory ? (
              <>
                <option value="all">All sessions</option>
                <optgroup label="Groups">
                  {state.groups.map((group) => (
                    <option key={group.id} value={`group:${group.id}`}>
                      {group.name}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Agents">
                  {state.agents.map((entry) => (
                    <option key={entry.id} value={`agent:${entry.id}`}>
                      {historyLabel(entry)}
                    </option>
                  ))}
                </optgroup>
              </>
            ) : (
              <>
                {grouped.map((group) => (
                  <optgroup key={group.id} label={group.name}>
                    {state.agents
                      .filter((entry) => entry.group === group.id)
                      .map(option)}
                  </optgroup>
                ))}
                {!!ungrouped.length && (
                  <optgroup label="No group">{ungrouped.map(option)}</optgroup>
                )}
              </>
            )}
          </select>
          {onClose && (
            <button
              type="button"
              title="Close this panel; the agent keeps running"
              onClick={onClose}
            >
              Close
            </button>
          )}
          {location !== 'side' && onMove && (
            <button
              type="button"
              title="Show this agent in the side panel"
              onClick={() => onMove('side')}
            >
              Side panel
            </button>
          )}
          {location !== 'main' && onMove && (
            <button
              type="button"
              title="Open this agent in a large main-area tab"
              onClick={() => onMove('main')}
            >
              Full screen
            </button>
          )}
          <span className="agenthq-help">· {TAB_LABELS[currentTab]}</span>
        </div>
      </div>
      {runtimeReadWarning(agent.runtime) && (
        <p className="agenthq-danger">
          ⚠ This agent can read your whole computer.{' '}
          {agent.wholeComputerReadConfirmed
            ? 'Access confirmed in Setup.'
            : 'Blocked until you confirm access in Setup.'}
        </p>
      )}
      {agent.warnings.map((warning, index) => (
        <p className="agenthq-warning" key={index}>
          ⚠ {warning}
        </p>
      ))}
      {currentTab === 'setup' ? (
        <SetupForm key={agent.id} agent={agent} workspace={workspace} />
      ) : currentTab === 'chat' ? (
        <ChatContent
          key={agent.id}
          app={app}
          workspace={workspace}
          id={agent.id}
          setTab={changeTab}
          chat={state.chat?.agents[agent.id]}
        />
      ) : currentTab === 'history' ? (
        <HistoryContent
          workspace={workspace}
          id={agent.id}
          setTab={changeTab}
          chats={Object.values(state.chat?.agents ?? {})}
          scope={historyScope ?? 'agent'}
          key={historyScope ?? 'agent'}
        />
      ) : (
        <TasksContent workspace={workspace} id={agent.id} />
      )}
    </div>
  );
}
