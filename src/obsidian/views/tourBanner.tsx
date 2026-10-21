import { useEffect, useState, useSyncExternalStore } from 'react';
import { DISCLAIMER, GUIDE_SECTIONS } from '../../core/guide';
import { setupLine } from '../../core/setupCheck';
import type { WorkspaceActions } from '../../core/workspace';

type Stage = 'ask' | 'tidy' | 'disclaimer' | number;

const SETUP_STAGE = GUIDE_SECTIONS.length;
const MARK = {
  ready: '✅',
  missing: '❌',
  unavailable: '⚠',
  'wrong-version': '⚠',
} as const;

/**
 * Obi's welcome tour, shown at the top of Obi's Chat: a question, the guide sections, the setup page,
 * then the graph-tidy question, then the disclaimer. It is hidden once finished or declined for good, and for this session after "Maybe later".
 */
export function TourBanner({ workspace }: { workspace: WorkspaceActions }) {
  const state = useSyncExternalStore(
    workspace.subscribe,
    workspace.getSnapshot,
  );
  const [stage, setStage] = useState<Stage>('ask');
  const [choice, setChoice] = useState<'hidden' | 'visible' | null>(null);
  const hidden = state.tourDone === true || state.tourDismissed === true;
  // A tour started again begins at the question, not where the last one stopped.
  useEffect(() => {
    if (hidden) {
      setStage('ask');
      setChoice(null);
    }
  }, [hidden]);
  // Opening the setup page checks the tools on this PC, so the page shows their real status.
  useEffect(() => {
    if (stage === SETUP_STAGE)
      void workspace
        .runSetupCheck()
        .catch((error: unknown) => workspace.reportError(error));
  }, [stage, workspace]);
  if (hidden) return null;
  const finish = () =>
    void workspace
      .finishTour()
      .catch((error: unknown) => workspace.reportError(error));
  return (
    <section className="agenthq-tour" aria-label="Welcome tour">
      {stage === 'ask' && (
        <>
          <p>Hi, I&apos;m Obi. Want a 2-minute tour of how this works?</p>
          <div className="agenthq-tour-actions">
            <button className="mod-cta" onClick={() => setStage(0)}>
              Yes, show me
            </button>
            <button onClick={() => workspace.dismissTour()}>Maybe later</button>
            <button onClick={() => setStage('disclaimer')}>
              I know it already
            </button>
          </div>
        </>
      )}
      {typeof stage === 'number' && stage < SETUP_STAGE && (
        <>
          <h4>{GUIDE_SECTIONS[stage]?.title}</h4>
          <p className="agenthq-tour-body">{GUIDE_SECTIONS[stage]?.body}</p>
          <div className="agenthq-tour-actions">
            <button disabled={stage === 0} onClick={() => setStage(stage - 1)}>
              Back
            </button>
            <button className="mod-cta" onClick={() => setStage(stage + 1)}>
              Next
            </button>
          </div>
        </>
      )}
      {stage === SETUP_STAGE && (
        <>
          <h4>Your setup</h4>
          {state.setupChecking ? (
            <p>Checking the tools on this computer…</p>
          ) : (
            <ul>
              {(state.setup ?? []).map((check) => (
                <li key={check.id}>
                  {MARK[check.status]} {setupLine(check)}
                </li>
              ))}
            </ul>
          )}
          <div className="agenthq-tour-actions">
            <button onClick={() => void workspace.runSetupCheck()}>
              Check again
            </button>
            <button
              title="Clears the stored safety results and checks the newer Codex or OpenCode again"
              onClick={() =>
                void workspace
                  .rerunSafetyCheck()
                  .catch((error: unknown) => workspace.reportError(error))
              }
            >
              Re-run safety check
            </button>
            <button onClick={() => setStage(SETUP_STAGE - 1)}>Back</button>
            <button className="mod-cta" onClick={() => setStage('tidy')}>
              Next
            </button>
          </div>
        </>
      )}
      {stage === 'tidy' && (
        <>
          <h4>Keep your graph tidy?</h4>
          {workspace.agentFolderHidden() || choice === 'hidden' ? (
            <p className="agenthq-tour-body">
              Obi-I is hidden from your graph and search. You can change this
              any time in Settings.
            </p>
          ) : (
            <p className="agenthq-tour-body">
              {choice === 'visible'
                ? 'Obi-I stays visible in your graph and search. You can change this any time in Settings.'
                : 'Obi-I keeps its agents, chats and tasks in the Obi-I folder. Hide that folder from Obsidian’s graph and search, so your graph shows only your own notes? You can change this any time in Settings.'}
            </p>
          )}
          <div className="agenthq-tour-actions">
            <button onClick={() => setStage(SETUP_STAGE)}>Back</button>
            {!workspace.agentFolderHidden() && choice === null && (
              <>
                <button
                  className="mod-cta"
                  onClick={() => {
                    workspace.setAgentFolderHidden(true);
                    setChoice('hidden');
                  }}
                >
                  Hide it (recommended)
                </button>
                <button onClick={() => setChoice('visible')}>
                  Keep it visible
                </button>
              </>
            )}
            {(workspace.agentFolderHidden() || choice !== null) && (
              <button
                className="mod-cta"
                onClick={() => setStage('disclaimer')}
              >
                Next
              </button>
            )}
          </div>
        </>
      )}
      {stage === 'disclaimer' && (
        <>
          <p className="agenthq-tour-body">{DISCLAIMER}</p>
          <div className="agenthq-tour-actions">
            <button className="mod-cta" onClick={finish}>
              I understand
            </button>
          </div>
        </>
      )}
    </section>
  );
}
