import { useRef, useState, useSyncExternalStore } from 'react';
import type { WorkspaceActions } from '../../core/workspace';

export function StopAllButton({ workspace }: { workspace: WorkspaceActions }) {
  const state = useSyncExternalStore(
    workspace.subscribe,
    workspace.getSnapshot,
  );
  const [stopping, setStopping] = useState(false);
  const locked = useRef(false);
  return (
    <button
      type="button"
      className="mod-warning"
      disabled={!state.chat || stopping}
      onClick={() => {
        if (locked.current) return;
        locked.current = true;
        setStopping(true);
        void workspace
          .stopAll()
          .catch((error: unknown) => workspace.reportError(error))
          .finally(() => {
            locked.current = false;
            setStopping(false);
          });
      }}
    >
      {stopping ? 'Stopping…' : 'Stop all'}
    </button>
  );
}
