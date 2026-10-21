import { useState } from 'react';
import type { Project } from '../../core/projects';

/**
 * What the picker shows and sends. A selected project that was deleted shows "(deleted project)";
 * one that is no longer assigned to this agent or target is dropped, so nothing is sent for it.
 */
export function projectPickerState(
  selectedId: string,
  choices: Project[],
  known: Project[],
): { badge: string; sendId: string | undefined } {
  const chosen = choices.find((project) => project.id === selectedId);
  const deleted =
    selectedId !== '' && !known.some((project) => project.id === selectedId);
  return {
    badge: deleted ? '(deleted project)' : (chosen?.name ?? ''),
    sendId: chosen?.id,
  };
}

/** A project icon button for the composer. Its menu lists "No project" and the assigned projects, with a tick on the current one. */
export function ProjectMenu({
  choices,
  known,
  selectedId,
  onChange,
}: {
  choices: Project[];
  known: Project[];
  selectedId: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { badge, sendId } = projectPickerState(selectedId, choices, known);
  const items = [{ id: '', name: 'No project' }, ...choices];
  return (
    <span className="agenthq-project-picker">
      <button
        type="button"
        aria-label="Project"
        title="Project"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        🗂
      </button>
      {badge && <span className="agenthq-project-badge">{badge}</span>}
      {open && (
        <ul role="menu" className="agenthq-project-menu">
          {items.map((item) => {
            const checked =
              item.id === '' ? sendId === undefined : item.id === sendId;
            return (
              <li key={item.id || 'none'} role="none">
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={checked}
                  onClick={() => {
                    onChange(item.id);
                    setOpen(false);
                  }}
                >
                  {checked ? '✓ ' : ''}
                  {item.name}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </span>
  );
}
