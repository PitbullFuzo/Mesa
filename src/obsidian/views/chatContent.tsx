import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { Menu, type App } from 'obsidian';
import { openLoopForm } from '../loopModal';
import { openScheduleForm } from '../scheduleForm';
import { conversationTitle, type AgentChatSnapshot } from '../../core/chat';
import { historyRows, type HistoryScope } from '../../core/history';
import { pickableProjects } from '../../core/projects';
import type { NoteDocument } from '../../core/notes';
import type {
  AgentTab,
  AttachedNote,
  WorkspaceActions,
} from '../../core/workspace';
import {
  enterSendsMessage,
  hasSendableContent,
  withAttachments,
} from '../../core/composer';
import { mentionQuery, withoutMention } from '../../core/mentions';
import { contextView, planMeterText, planResetText } from '../../core/context';
import {
  parseSlash,
  quotedSideNote,
  SLASH_HELP,
  skillMessage,
  slashMatches,
  takeNamed,
} from '../../core/slash';
import { isAtBottom } from '../../core/scroll';
import { MarkdownContent } from './markdownContent';
import { useImageInput, AttachmentPreviews } from './imageInput';
import { ProjectMenu, projectPickerState } from './projectMenu';
import { ModelLabel } from './modelLabel';
import { TourBanner } from './tourBanner';
import { OBI_ID } from '../../core/obi';

export function ChatContent({
  app,
  workspace,
  chat,
  id,
  setTab = (tab) => workspace.setAgentTab(tab),
}: {
  app: App;
  workspace: WorkspaceActions;
  chat?: AgentChatSnapshot;
  id: string;
  setTab?: (tab: AgentTab) => void;
}) {
  const [draft, setDraft] = useState('');
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState<number | null>(null);
  const [projectId, setProjectId] = useState('');
  const [notes, setNotes] = useState<AttachedNote[]>([]);
  const [caret, setCaret] = useState(0);
  const [side, setSide] = useState<{
    question: string;
    answer?: string;
    costUsd?: number;
    error?: string;
  } | null>(null);
  const [info, setInfo] = useState('');
  const [showReset, setShowReset] = useState(false);
  const snapshot = workspace.getSnapshot();
  const loop = snapshot.chat?.loops?.[id];
  const projectChoices = pickableProjects(
    snapshot.projects ?? [],
    id,
    snapshot.agents,
    snapshot.groups,
  );
  const sendProjectId = projectPickerState(
    projectId,
    projectChoices,
    snapshot.projects ?? [],
  ).sendId;
  const busy = chat?.status === 'working' || chat?.status === 'queued';
  // Why 🔁 cannot run now; undefined when it can. An empty draft is fine: the form has its own message box.
  const loopBlockedReason = !chat
    ? 'Chat is not ready yet'
    : busy
      ? 'Wait for the reply to finish, or stop it'
      : loop
        ? 'A loop is already running; stop it first'
        : closing
          ? 'A new conversation is starting'
          : undefined;
  const attachment = useImageInput(workspace, closing);
  const sectionRef = useRef<HTMLElement>(null);
  const followRef = useRef(true);
  // The panel (.agenthq-panel) is the scroll container; Chat follows it only at the bottom.
  const scroller = () =>
    sectionRef.current?.closest<HTMLElement>('.agenthq-panel') ?? null;
  useLayoutEffect(() => {
    const panel = scroller();
    if (!panel) return;
    const onScroll = () => {
      followRef.current = isAtBottom(panel);
    };
    panel.addEventListener('scroll', onScroll, { passive: true });
    return () => panel.removeEventListener('scroll', onScroll);
  }, []);
  useLayoutEffect(() => {
    const panel = scroller();
    if (panel && followRef.current) panel.scrollTop = panel.scrollHeight;
  }, [chat?.messages]);
  const enterToSend = useSyncExternalStore(
    workspace.subscribe,
    () => workspace.getSnapshot().enterToSend !== false,
  );
  function startNewConversation() {
    setClosing(true);
    void perform(() => workspace.newConversation(id)).finally(() =>
      setClosing(false),
    );
  }
  /** The 🔁 menu: fixed loop options that repeat the composer message. */
  function openLoopMenu(anchor: HTMLElement) {
    const menu = new Menu();
    const message = draft;
    const kinds = [
      ['Repeat until the reviewer passes…', 'until-pass'],
      ['Repeat until…', 'until-condition'],
      ['Run N times…', 'times'],
    ] as const;
    for (const [title, kind] of kinds)
      menu.addItem((item) =>
        item.setTitle(title).onClick(() =>
          openLoopForm(app, workspace, {
            agentId: id,
            kind,
            message,
            projectId: sendProjectId,
            onStarted: () => setDraft(''),
          }),
        ),
      );
    menu.addSeparator();
    menu.addItem((item) =>
      item.setTitle('Repeat on a schedule…').onClick(() =>
        openScheduleForm(app, workspace, {
          agentId: id,
          message: draft,
          projectId: sendProjectId,
        }),
      ),
    );
    const rect = anchor.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom });
  }

  function openMenu(anchor: HTMLElement) {
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle('Chat')
        .setIcon('message-square')
        .onClick(() => setTab('chat')),
    );
    for (const [title, icon, tab] of [
      ['Setup', 'settings', 'setup'],
      ['Tasks', 'list-checks', 'tasks'],
      ['History', 'history', 'history'],
    ] as const)
      menu.addItem((item) =>
        item
          .setTitle(title)
          .setIcon(icon)
          .onClick(() => setTab(tab)),
      );
    const pinned = (workspace.getSnapshot().pins ?? []).includes(id);
    menu.addItem((item) =>
      item
        .setTitle(pinned ? 'Unpin this agent' : 'Pin this agent')
        .setIcon(pinned ? 'pin-off' : 'pin')
        .onClick(() => void perform(() => workspace.setPinned(id, !pinned))),
    );
    menu.addItem((item) =>
      item
        .setTitle('Open in new window')
        .setIcon('separator-vertical')
        .onClick(() => workspace.openBeside(id)),
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle('New conversation')
        .setIcon('plus')
        .setDisabled(closing || !chat)
        .onClick(startNewConversation),
    );
    menu.addItem((item) =>
      item
        .setTitle('Back to top')
        .setIcon('arrow-up')
        .onClick(() => scroller()?.scrollTo({ top: 0 })),
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle('Delete this conversation')
        .setIcon('trash-2')
        .setWarning(true)
        .onClick(() => void perform(() => workspace.deleteConversation(id))),
    );
    const rect = anchor.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom });
  }
  /** Runs a slash command typed in the composer. Returns the text to send instead, or null when it was handled here. */
  async function runSlash(text: string): Promise<string | null> {
    const call = parseSlash(text);
    if (!call) return text;
    setInfo('');
    if (call.name === 'new' || call.name === 'compact') {
      startNewConversation();
      return null;
    }
    if (call.name === 'fork') {
      const last = (chat?.messages.length ?? 0) - 1;
      if (last < 0 || !chat?.session?.path)
        throw new Error('Nothing to fork yet: send a message first.');
      await workspace.forkChat(id, last);
      return null;
    }
    if (call.name === 'side') {
      if (!call.rest) throw new Error('Add a question after /side.');
      const question = call.rest;
      setSide({ question });
      // Runs beside the main chat: its session is not used and nothing is added to it.
      void workspace
        .askSide(id, question)
        .then((result) =>
          setSide({
            question,
            costUsd: result.costUsd,
            ...(result.isError
              ? { error: result.text || 'The side question failed.' }
              : { answer: result.text }),
          }),
        )
        .catch((caught: unknown) =>
          setSide({
            question,
            error:
              caught instanceof Error
                ? caught.message
                : 'The side question failed.',
          }),
        );
      return null;
    }
    if (call.name === 'help') {
      setInfo(SLASH_HELP);
      return null;
    }
    if (call.name === 'project') {
      const found = takeNamed(projectChoices, call.rest);
      if (!found || found.rest)
        throw new Error(
          `No project called "${call.rest}" for this agent. Use /project <name>.`,
        );
      setProjectId(found.item.id);
      setInfo(`Sending under the project ${found.item.name}.`);
      return null;
    }
    const found = takeNamed(snapshot.skills, call.rest);
    if (!found)
      throw new Error(
        `No skill called "${call.rest}". Use /skill <name> <message>.`,
      );
    if (!found.rest)
      throw new Error(`Add a message after /skill ${found.item.name}.`);
    return skillMessage(found.item, found.rest);
  }
  /** An @ choice becomes a removable chip; the @word is taken out of the message. */
  function chooseMention(
    candidate: Parameters<WorkspaceActions['resolveMention']>[0],
    start: number,
  ) {
    const end = caret;
    void perform(async () => {
      const resolved = await workspace.resolveMention(candidate);
      if (!resolved) throw new Error(`${candidate.label} was not found.`);
      setNotes((current) => [
        ...current.filter(
          (other) =>
            !(other.kind === resolved.kind && other.path === resolved.path),
        ),
        resolved,
      ]);
      setDraft((current) => withoutMention(current, start, end));
    });
  }
  async function perform(action: () => Promise<void>) {
    setError('');
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Chat failed.');
    }
  }
  return (
    <section className="agenthq-chat" ref={sectionRef}>
      {id === OBI_ID && <TourBanner workspace={workspace} />}
      <p role="status" className="agenthq-help">
        {chat?.status ?? 'Loading runtime…'}
        {chat?.hint ? ` · ${chat.hint}` : ''}
      </p>
      <div className="agenthq-chat-meters">
        {chat?.agent.runtime === 'claude-code' &&
          planMeterText(snapshot.chat?.planUsage) !== '' && (
            <button
              type="button"
              className="agenthq-meter"
              title="Your Claude plan's usage. Click for reset times."
              onClick={() => setShowReset(!showReset)}
            >
              {planMeterText(snapshot.chat?.planUsage)}
            </button>
          )}
        <span
          className="agenthq-context"
          title={contextView(chat?.context).tip}
        >
          Context{' '}
          {contextView(chat?.context).fraction !== undefined && (
            <progress
              className={contextView(chat?.context).warn ? 'is-warn' : ''}
              value={contextView(chat?.context).fraction}
              max={1}
            />
          )}{' '}
          {contextView(chat?.context).text}
        </span>
      </div>
      {showReset && (
        <p className="agenthq-help agenthq-meter-resets">
          {planResetText(snapshot.chat?.planUsage)}
        </p>
      )}
      {side && (
        <details className="agenthq-side" open>
          <summary>Side chat: {side.question}</summary>
          {side.error ? (
            <p className="agenthq-warning" role="alert">
              {side.error}
            </p>
          ) : side.answer === undefined ? (
            <p role="status">Thinking…</p>
          ) : (
            <pre className="agenthq-side-answer">{side.answer}</pre>
          )}
          {side.costUsd !== undefined && (
            <p className="agenthq-help">${side.costUsd.toFixed(4)}</p>
          )}
          <div className="agenthq-chat-actions">
            {side.answer !== undefined && (
              <button
                type="button"
                onClick={() => {
                  setDraft(
                    (current) =>
                      current + quotedSideNote(side.question, side.answer!),
                  );
                  setSide(null);
                }}
              >
                Add to main chat
              </button>
            )}
            <button type="button" onClick={() => setSide(null)}>
              Close
            </button>
          </div>
        </details>
      )}
      <div className="agenthq-chat-messages" aria-live="polite">
        {chat?.messages.map((message, index) => (
          <article
            key={index}
            className={`agenthq-chat-message ${message.role === 'user' ? 'is-user' : ''}`}
          >
            <header>
              <strong>
                {message.role === 'user' ? 'You' : chat.agent.name}
              </strong>
              <span>
                {message.streaming
                  ? 'Streaming…'
                  : message.cancelled
                    ? 'Stopped'
                    : message.costUsd !== undefined
                      ? `$${message.costUsd.toFixed(4)}`
                      : message.tokens !== undefined
                        ? `${message.tokens.toLocaleString('en-US')} tokens`
                        : ''}
              </span>
              {message.role === 'assistant' && (
                <button
                  type="button"
                  className="agenthq-copy-reply"
                  aria-label="Copy raw Markdown"
                  onClick={() => {
                    void perform(async () => {
                      await navigator.clipboard.writeText(message.content);
                      setCopied(index);
                    });
                  }}
                >
                  {copied === index ? 'Copied' : 'Copy'}
                </button>
              )}
              <button
                type="button"
                aria-label="Fork from here"
                title="Fork a new conversation from this message"
                disabled={busy || !chat.session?.path}
                onClick={() => {
                  void perform(async () => {
                    await workspace.forkChat(id, index);
                  });
                }}
              >
                Fork
              </button>
            </header>
            <MarkdownContent
              app={app}
              content={message.content}
              sourcePath={chat.session?.path ?? chat.agent.path}
              streaming={message.streaming}
            />
            {!!message.tools.length && (
              <details className="agenthq-chat-tools">
                <summary>Tools ({message.tools.length})</summary>
                {message.tools.map((tool, toolIndex) => (
                  <p key={toolIndex}>
                    {tool.name}: {tool.summary}
                  </p>
                ))}
              </details>
            )}
          </article>
        ))}
        <JumpToBottom />
      </div>
      {error && (
        <p className="agenthq-warning" role="alert">
          {error}
        </p>
      )}
      {!!chat?.commandApprovals?.length && (
        <div
          className="agenthq-proposals"
          aria-label="Commands waiting for you"
        >
          {chat.commandApprovals.map((card) => (
            <div key={card.id} className="agenthq-proposal">
              <strong>
                {card.title ?? 'This agent wants to run a command'}
              </strong>
              <pre className="agenthq-proposal-text">{card.command}</pre>
              {card.cwd && <p className="agenthq-help">Folder: {card.cwd}</p>}
              <button
                type="button"
                className="mod-cta"
                onClick={() => workspace.resolveCommand(id, card.id, true)}
              >
                Approve
              </button>
              <button
                type="button"
                onClick={() => workspace.resolveCommand(id, card.id, false)}
              >
                Reject
              </button>
            </div>
          ))}
        </div>
      )}
      {!!chat?.proposals?.length && (
        <div className="agenthq-proposals" aria-label="Proposed team changes">
          {chat.proposals.map((proposal) => (
            <div key={proposal.id} className="agenthq-proposal">
              <strong>{proposal.title}</strong>
              <dl className="agenthq-proposal-fields">
                {proposal.fields.map((entry) => (
                  <div key={entry.label}>
                    <dt>{entry.label}</dt>
                    <dd>{entry.value}</dd>
                  </div>
                ))}
              </dl>
              {proposal.texts.map((entry) => (
                <details key={entry.label} open={entry.open}>
                  <summary>{entry.label}</summary>
                  <pre className="agenthq-proposal-text">{entry.text}</pre>
                </details>
              ))}
              <button
                type="button"
                className="mod-cta"
                onClick={() =>
                  void perform(() => workspace.approveProposal(id, proposal.id))
                }
              >
                Approve
              </button>
              <button
                type="button"
                onClick={() => workspace.rejectProposal(id, proposal.id)}
              >
                Reject
              </button>
            </div>
          ))}
        </div>
      )}
      <form
        className="agenthq-chat-compose"
        {...attachment.handlers}
        onSubmit={(event) => {
          event.preventDefault();
          const typed = draft;
          if (
            !hasSendableContent(typed, attachment.images.length) ||
            attachment.saving ||
            closing ||
            !chat
          )
            return;
          setDraft('');
          const images = attachment.images;
          attachment.clear();
          const attached = notes;
          setNotes([]);
          void perform(async () => {
            const text = await runSlash(typed);
            if (text === null) return;
            await workspace.sendMessage(
              id,
              withAttachments(text, attached),
              images,
              projectPickerState(
                projectId,
                projectChoices,
                snapshot.projects ?? [],
              ).sendId,
            );
          });
        }}
      >
        <AttachmentPreviews
          images={attachment.images}
          onRemove={attachment.remove}
        />
        {attachment.saving && <p role="status">Saving image…</p>}
        {attachment.error && (
          <p role="alert" className="agenthq-warning">
            {attachment.error}
          </p>
        )}
        {notes.map((item) => (
          <span
            key={`${item.kind ?? 'note'}:${item.path}`}
            className="agenthq-note-chip"
            title="You attached this. An agent without vault access gets it only because you attached it. Long content is cut."
          >
            {item.kind === 'folder' ? '📁' : item.kind === 'chat' ? '💬' : '📎'}{' '}
            {item.path}
            {item.truncated ? ' (cut)' : ''}{' '}
            <button
              type="button"
              aria-label={`Remove ${item.path}`}
              onClick={() => setNotes(notes.filter((other) => other !== item))}
            >
              ✕
            </button>
          </span>
        ))}
        {info && <pre className="agenthq-slash-info">{info}</pre>}
        {(() => {
          const wanted = mentionQuery(draft, caret);
          const offered = wanted
            ? workspace.mentionCandidates(id, wanted.query)
            : [];
          return (
            wanted &&
            offered.length > 0 && (
              <ul
                className="agenthq-slash-popup"
                role="listbox"
                aria-label="Mentions"
              >
                {offered.map((candidate) => (
                  <li
                    key={`${candidate.kind}:${candidate.path}`}
                    role="option"
                    aria-selected={false}
                  >
                    <button
                      type="button"
                      title="You choose what an agent sees: it gets this only because you attached it."
                      onClick={() => chooseMention(candidate, wanted.start)}
                    >
                      {candidate.kind === 'folder'
                        ? '📁'
                        : candidate.kind === 'chat'
                          ? '💬'
                          : '📎'}{' '}
                      <strong>{candidate.label}</strong>
                      {candidate.label === candidate.path
                        ? ''
                        : ` ${candidate.path}`}
                    </button>
                  </li>
                ))}
              </ul>
            )
          );
        })()}
        {slashMatches(draft).length > 0 && parseSlash(draft) === null && (
          <ul
            className="agenthq-slash-popup"
            role="listbox"
            aria-label="Commands"
          >
            {slashMatches(draft).map((command) => (
              <li key={command.name} role="option" aria-selected={false}>
                <button
                  type="button"
                  onClick={() => setDraft(`/${command.name} `)}
                >
                  <strong>{command.usage}</strong> {command.hint}
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          aria-label="Message"
          placeholder="Message this agent…"
          value={draft}
          disabled={closing}
          onChange={(event) => {
            setDraft(event.target.value);
            setCaret(event.target.selectionStart);
          }}
          onClick={(event) => setCaret(event.currentTarget.selectionStart)}
          onKeyUp={(event) => setCaret(event.currentTarget.selectionStart)}
          onKeyDown={(event) => {
            const wanted = mentionQuery(draft, caret);
            const offered = wanted
              ? workspace.mentionCandidates(id, wanted.query)
              : [];
            if (
              wanted &&
              offered.length > 0 &&
              (event.key === 'Tab' ||
                enterSendsMessage(event.nativeEvent, enterToSend))
            ) {
              event.preventDefault();
              chooseMention(offered[0]!, wanted.start);
              return;
            }
            const matches = slashMatches(draft);
            if (
              (event.key === 'Tab' ||
                enterSendsMessage(event.nativeEvent, enterToSend)) &&
              matches.length > 0 &&
              parseSlash(draft) === null
            ) {
              event.preventDefault();
              setDraft(`/${matches[0]!.name} `);
              return;
            }
            if (enterSendsMessage(event.nativeEvent, enterToSend)) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <div className="agenthq-chat-actions">
          {!enterToSend && (
            <button
              className="mod-cta"
              type="submit"
              disabled={
                !hasSendableContent(draft, attachment.images.length) ||
                attachment.saving ||
                closing ||
                !chat
              }
            >
              {busy ? 'Queue message' : 'Send'}
            </button>
          )}
          {projectChoices.length > 0 && (
            <ProjectMenu
              choices={projectChoices}
              known={snapshot.projects ?? []}
              selectedId={projectId}
              onChange={setProjectId}
            />
          )}
          {loop && (
            <span className="agenthq-loop-round">
              Round {loop.round}/{loop.rounds}
            </span>
          )}
          <ModelLabel
            app={app}
            workspace={workspace}
            agentId={id}
            disabled={busy}
            setTab={setTab}
          />
          <button
            type="button"
            aria-label="Attach current note"
            title="Attach the note you have open to this message"
            disabled={closing || !chat}
            onClick={() => {
              void perform(async () => {
                const current = await workspace.currentNote();
                if (!current)
                  throw new Error('Open a note in the editor first.');
                setNotes([
                  ...notes.filter(
                    (other) =>
                      !(other.kind !== 'folder' && other.path === current.path),
                  ),
                  { ...current, kind: 'note' },
                ]);
              });
            }}
          >
            📎
          </button>
          <button
            type="button"
            aria-label="Repeat"
            title={loopBlockedReason ?? 'Repeat this message in a loop'}
            disabled={!!loopBlockedReason}
            onClick={(event) => openLoopMenu(event.currentTarget)}
          >
            🔁
          </button>
          <button
            type="button"
            disabled={!busy && !loop}
            onClick={() => {
              void perform(() => workspace.stopAgent(id));
            }}
          >
            Stop
          </button>
          <button
            type="button"
            className="agenthq-chat-menu"
            aria-label="More chat actions"
            title="More actions"
            onClick={(event) => openMenu(event.currentTarget)}
          >
            ⚙
          </button>
        </div>
      </form>
    </section>
  );
}

/** The path of the chat a fork came from, or null for a conversation that is not a fork. */
function forkSource(note: NoteDocument): string | null {
  const forked = (
    note.frontmatter as { forkedFrom?: { path?: unknown } } | null
  )?.forkedFrom;
  return typeof forked?.path === 'string' ? forked.path : null;
}

function startedLabel(note: NoteDocument): string {
  const started = (note.frontmatter as { started?: unknown } | null)?.started;
  return typeof started === 'string' ? new Date(started).toLocaleString() : '';
}

/** Floating ↓ that appears only after the reader has scrolled away from the bottom of the panel. */
export function JumpToBottom() {
  const marker = useRef<HTMLSpanElement>(null);
  const [away, setAway] = useState(false);
  useEffect(() => {
    const panel = marker.current?.closest<HTMLElement>('.agenthq-panel');
    if (!panel) return;
    const update = () => setAway(!isAtBottom(panel));
    update();
    panel.addEventListener('scroll', update, { passive: true });
    return () => panel.removeEventListener('scroll', update);
  }, []);
  return (
    <>
      <span ref={marker} hidden />
      {away && (
        <button
          type="button"
          className="agenthq-jump-bottom"
          aria-label="Jump to bottom"
          title="Jump to bottom"
          onClick={() =>
            marker.current
              ?.closest<HTMLElement>('.agenthq-panel')
              ?.scrollTo({ top: Number.MAX_SAFE_INTEGER, behavior: 'smooth' })
          }
        >
          ↓
        </button>
      )}
    </>
  );
}

export function HistoryContent({
  workspace,
  id,
  setTab = (tab) => workspace.setAgentTab(tab),
  chats,
  scope,
}: {
  workspace: WorkspaceActions;
  id: string;
  chats: AgentChatSnapshot[];
  scope: HistoryScope;
  setTab?: (tab: AgentTab) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const groupId = scope.startsWith('group:') ? scope.slice(6) : null;
  const rows = historyRows(chats, scope, id);
  async function run(action: () => Promise<void>) {
    setError('');
    setBusy(true);
    try {
      await action();
      setSelected([]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Action failed.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <h3>Chat history</h3>
      <ul className="agenthq-history">
        {rows.map((row) => (
          <li key={row.note.path}>
            <input
              type="checkbox"
              aria-label={`Select ${conversationTitle(row.note)}`}
              checked={selected.includes(row.note.path)}
              onChange={(event) =>
                setSelected(
                  event.currentTarget.checked
                    ? [...selected, row.note.path]
                    : selected.filter((path) => path !== row.note.path),
                )
              }
            />
            <button
              className="agenthq-history-row"
              onClick={() => {
                void workspace
                  .openNote(row.note.path)
                  .catch((error: unknown) => workspace.reportError(error));
              }}
            >
              <strong>{conversationTitle(row.note)}</strong>
              {forkSource(row.note) && (
                <button
                  type="button"
                  className="agenthq-fork-mark"
                  onClick={() => {
                    void workspace
                      .openNote(forkSource(row.note)!)
                      .catch((caught: unknown) =>
                        workspace.reportError(caught),
                      );
                  }}
                >
                  forked
                </button>
              )}
              {scope === 'agent' ? (
                <small>{startedLabel(row.note)}</small>
              ) : (
                <small>
                  <span
                    className={`agenthq-status agenthq-status-${row.status}`}
                  />{' '}
                  {`${row.agent.name} · ${startedLabel(row.note)}`}
                </small>
              )}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await workspace.continueChat(row.agent.id, row.note.path);
                  if (row.agent.id === id) setTab('chat');
                  else workspace.selectAgent(row.agent.id, 'chat');
                })
              }
            >
              Continue
            </button>
            <button
              type="button"
              onClick={() =>
                void workspace.renameChat(
                  row.agent.id,
                  row.note.path,
                  conversationTitle(row.note),
                )
              }
            >
              Rename
            </button>
            <button
              type="button"
              aria-label={`Delete ${conversationTitle(row.note)}`}
              title="Delete this conversation"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  workspace.deleteChatNotes(row.agent.id, [row.note.path]),
                )
              }
            >
              🗑
            </button>
          </li>
        ))}
      </ul>
      {!rows.length && <p className="agenthq-help">No conversations yet.</p>}
      {!!selected.length && (
        <button
          type="button"
          className="mod-warning"
          disabled={busy}
          onClick={() =>
            void run(() => workspace.deleteChatNotes(null, selected))
          }
        >
          {`Delete selected (${selected.length})`}
        </button>
      )}
      <div className="agenthq-history-danger">
        <button
          type="button"
          className="mod-warning"
          disabled={busy || !rows.length}
          onClick={() =>
            void run(() =>
              scope === 'agent'
                ? workspace.deleteAgentHistory(id)
                : groupId
                  ? workspace.deleteGroupHistory(groupId)
                  : workspace.deleteAllHistory(),
            )
          }
        >
          {scope === 'agent'
            ? 'Delete all history for this agent'
            : groupId
              ? 'Delete all history for this group'
              : 'Delete all chat notes'}
        </button>
      </div>
      {error && (
        <p role="alert" className="agenthq-warning">
          {error}
        </p>
      )}
      <JumpToBottom />
    </section>
  );
}
