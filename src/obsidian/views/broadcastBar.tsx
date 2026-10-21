import { useState, useSyncExternalStore } from 'react';
import type { BroadcastTarget } from '../../core/broadcast';
import { projectsForAgents } from '../../core/projects';
import { useImageInput, AttachmentPreviews } from './imageInput';
import { ProjectMenu, projectPickerState } from './projectMenu';
import type { WorkspaceActions } from '../../core/workspace';
import { enterSendsMessage, hasSendableContent } from '../../core/composer';

export function BroadcastBar({ workspace }: { workspace: WorkspaceActions }) {
  const state = useSyncExternalStore(
    workspace.subscribe,
    workspace.getSnapshot,
  );
  const [target, setTarget] = useState('everyone');
  const [draft, setDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [projectId, setProjectId] = useState('');
  const targetIds =
    target === 'everyone'
      ? state.agents.map((agent) => agent.id)
      : target.startsWith('group:')
        ? state.agents
            .filter((agent) => agent.group === target.slice(6))
            .map((agent) => agent.id)
        : [target.slice(6)];
  const projectChoices = projectsForAgents(
    state.projects ?? [],
    targetIds,
    state.agents,
    state.groups,
  );
  const sendProjectId = projectPickerState(
    projectId,
    projectChoices,
    state.projects ?? [],
  ).sendId;
  const result = state.chat?.broadcast;
  const busy = submitting || !!result?.running;
  const attachment = useImageInput(workspace, busy);
  const enterToSend = state.enterToSend !== false;
  const validTarget =
    target === 'everyone' ||
    (target.startsWith('group:')
      ? state.groups.some((group) => group.id === target.slice(6))
      : state.agents.some((agent) => agent.id === target.slice(6)));
  async function send() {
    if (
      !hasSendableContent(draft, attachment.images.length) ||
      attachment.saving ||
      busy ||
      !validTarget
    )
      return;
    const recipient: BroadcastTarget =
      target === 'everyone'
        ? { kind: 'everyone' }
        : target.startsWith('group:')
          ? { kind: 'group', id: target.slice(6) }
          : { kind: 'agent', id: target.slice(6) };
    setSubmitting(true);
    setError('');
    try {
      await workspace.broadcast(
        recipient,
        draft,
        attachment.images,
        sendProjectId,
      );
      attachment.clear();
      setDraft('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Broadcast failed.');
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <section className="agenthq-broadcast" aria-label="Broadcast">
      <form
        {...attachment.handlers}
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <label>
          To
          <select
            aria-label="Broadcast target"
            value={target}
            disabled={busy || state.loading}
            onChange={(event) => setTarget(event.target.value)}
          >
            <option value="everyone">Everyone</option>
            <optgroup label="Groups">
              {state.groups.map((group) => (
                <option key={group.id} value={`group:${group.id}`}>
                  {group.name}
                </option>
              ))}
            </optgroup>
            <optgroup label="Agents">
              {state.agents.map((agent) => (
                <option key={agent.id} value={`agent:${agent.id}`}>
                  {agent.name}
                </option>
              ))}
            </optgroup>
            {!validTarget && (
              <option value={target}>Target no longer available</option>
            )}
          </select>
        </label>
        <AttachmentPreviews
          images={attachment.images}
          onRemove={attachment.remove}
        />
        {projectChoices.length > 0 && (
          <ProjectMenu
            choices={projectChoices}
            known={state.projects ?? []}
            selectedId={projectId}
            onChange={setProjectId}
          />
        )}
        <textarea
          aria-label="Broadcast message"
          placeholder="Message many agents…"
          rows={2}
          value={draft}
          disabled={busy}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (enterSendsMessage(event.nativeEvent, enterToSend)) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        {!enterToSend && (
          <button
            type="submit"
            className="mod-cta"
            disabled={
              busy ||
              state.loading ||
              !state.chat ||
              (!draft.trim() && !attachment.images.length) ||
              attachment.saving ||
              !validTarget
            }
          >
            {busy ? 'Sending…' : 'Broadcast'}
          </button>
        )}
      </form>
      {attachment.saving && <p role="status">Saving image…</p>}
      {attachment.error && (
        <p role="alert" className="agenthq-warning">
          {attachment.error}
        </p>
      )}
      {error && (
        <p role="alert" className="agenthq-warning">
          {error}
        </p>
      )}
      {result && (
        <div
          className="agenthq-broadcast-results"
          role="status"
          aria-live="polite"
        >
          <p>
            {result.running ? 'Sending broadcast…' : 'Broadcast finished'} ·{' '}
            {result.text}
          </p>
          {!result.recipients.length && <p>No agents in this target.</p>}
          <ul>
            {result.recipients.map((recipient) => (
              <li key={recipient.key}>
                {recipient.agentId ? (
                  <button
                    type="button"
                    onClick={() =>
                      workspace.selectAgent(recipient.agentId!, 'chat')
                    }
                  >
                    {recipient.name}
                  </button>
                ) : (
                  <strong>{recipient.name}</strong>
                )}
                {' · '}
                {recipient.status.charAt(0).toUpperCase() +
                  recipient.status.slice(1)}
                {recipient.reason ? ` — ${recipient.reason}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
