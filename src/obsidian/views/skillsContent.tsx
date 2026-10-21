import { useState, useSyncExternalStore } from 'react';
import type { Skill } from '../../core/model';
import { skillDescription, skillSize, skillUsers } from '../../core/skills';
import type { WorkspaceActions } from '../../core/workspace';

type Props = {
  workspace: WorkspaceActions;
  openCreate: () => void;
  openAssign: (skill: Skill) => void;
  confirmDelete: (skill: Skill) => Promise<boolean>;
  importSkills: () => Promise<void>;
};

/** Every skill in Mesa/Skills, with its size and where it is used. */
export function SkillsContent({
  workspace,
  openCreate,
  openAssign,
  confirmDelete,
  importSkills,
}: Props) {
  const state = useSyncExternalStore(
    workspace.subscribe,
    workspace.getSnapshot,
  );
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const skills = (state.skills ?? []).filter(
    (skill) =>
      skill.name.toLowerCase().includes(needle) ||
      skillDescription(skill).toLowerCase().includes(needle),
  );
  async function run(action: () => Promise<void>) {
    try {
      await action();
    } catch (error) {
      workspace.reportError(error);
    }
  }
  return (
    <div className="agenthq-projects">
      <header className="agenthq-projects-header">
        <h3>Skills</h3>
        <div>
          <button onClick={() => void run(importSkills)}>
            Import my Claude skills
          </button>{' '}
          <button className="mod-cta" onClick={openCreate}>
            + Skill
          </button>
        </div>
      </header>
      <div className="agenthq-projects-filter">
        <input
          type="search"
          placeholder="Search skills"
          aria-label="Search skills"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {skills.length === 0 && (
        <p className="agenthq-projects-empty">
          No skills match. Choose + Skill, or import your Claude skills.
        </p>
      )}
      <ul className="agenthq-schedule-list">
        {skills.map((skill) => {
          const size = skillSize(skill);
          const users = skillUsers(skill, state.agents, state.projects ?? []);
          const usedBy = [
            ...users.agents.map((agent) => agent.name),
            ...users.projects.map((project) => `project ${project.name}`),
          ];
          return (
            <li key={skill.path} className="agenthq-schedule-row">
              <strong>{skill.name}</strong>
              <span className="agenthq-schedule-message">
                {skillDescription(skill) || 'No description'}
              </span>
              <small>
                {size.words} words · about {size.tokens} tokens added to a
                prompt (estimate)
              </small>
              <small>
                Used by: {usedBy.length ? usedBy.join(', ') : 'nothing yet'}
              </small>
              <span className="agenthq-schedule-actions">
                <button
                  onClick={() => void run(() => workspace.openNote(skill.path))}
                >
                  Edit
                </button>
                <button onClick={() => openAssign(skill)}>Assign</button>
                <button
                  className="mod-warning"
                  onClick={() =>
                    void run(async () => {
                      if (await confirmDelete(skill))
                        await workspace.deleteSkill(skill.path);
                    })
                  }
                >
                  Delete
                </button>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
