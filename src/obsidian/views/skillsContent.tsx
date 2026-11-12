import { useState, useSyncExternalStore } from 'react';
import { t } from '../../core/i18n';
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
        <h3>{t('skills.title')}</h3>
        <div>
          <button onClick={() => void run(importSkills)}>
            {t('skills.import')}
          </button>{' '}
          <button className="mod-cta" onClick={openCreate}>
            {t('skills.add')}
          </button>
        </div>
      </header>
      <div className="agenthq-projects-filter">
        <input
          type="search"
          placeholder={t('skills.search')}
          aria-label={t('skills.search')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {skills.length === 0 && (
        <p className="agenthq-projects-empty">{t('skills.empty')}</p>
      )}
      <ul className="agenthq-schedule-list">
        {skills.map((skill) => {
          const size = skillSize(skill);
          const users = skillUsers(skill, state.agents, state.projects ?? []);
          const usedBy = [
            ...users.agents.map((agent) => agent.name),
            ...users.projects.map((project) =>
              t('skills.project', { name: project.name }),
            ),
          ];
          return (
            <li key={skill.path} className="agenthq-schedule-row">
              <strong>{skill.name}</strong>
              <span className="agenthq-schedule-message">
                {skillDescription(skill) || t('skills.noDescription')}
              </span>
              <small>
                {t('skills.size', { words: size.words, tokens: size.tokens })}
              </small>
              <small>
                {t('skills.usedBy', {
                  names: usedBy.length
                    ? usedBy.join(', ')
                    : t('skills.nothingYet'),
                })}
              </small>
              <span className="agenthq-schedule-actions">
                <button
                  onClick={() => void run(() => workspace.openNote(skill.path))}
                >
                  {t('btn.edit')}
                </button>
                <button onClick={() => openAssign(skill)}>
                  {t('skills.assign')}
                </button>
                <button
                  className="mod-warning"
                  onClick={() =>
                    void run(async () => {
                      if (await confirmDelete(skill))
                        await workspace.deleteSkill(skill.path);
                    })
                  }
                >
                  {t('btn.delete')}
                </button>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
