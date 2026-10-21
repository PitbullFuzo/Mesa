import { Modal, Notice, Setting, type App } from 'obsidian';
import type { Skill } from '../core/model';
import { skillUsers } from '../core/skills';
import type { WorkspaceActions } from '../core/workspace';

const TEMPLATE =
  '## Steps\n1. Describe the first step.\n2. Describe the next step.\n\n## Notes\nAnything the agent should keep in mind.';

/** The form for a new skill: name, description and instructions, from a small template. */
export function openSkillForm(app: App, workspace: WorkspaceActions): void {
  class SkillForm extends Modal {
    onOpen(): void {
      this.setTitle('New skill');
      const draft = { name: '', description: '', instructions: TEMPLATE };
      new Setting(this.contentEl)
        .setName('Name')
        .setDesc('Its file name, for example sales-follow-up.')
        .addText((text) =>
          text.setValue(draft.name).onChange((value) => (draft.name = value)),
        );
      new Setting(this.contentEl)
        .setName('Description')
        .addText((text) =>
          text
            .setValue(draft.description)
            .onChange((value) => (draft.description = value)),
        );
      new Setting(this.contentEl)
        .setName('Instructions')
        .addTextArea((area) => {
          area
            .setValue(draft.instructions)
            .onChange((value) => (draft.instructions = value));
          area.inputEl.rows = 10;
        });
      new Setting(this.contentEl)
        .addButton((button) =>
          button.setButtonText('Cancel').onClick(() => this.close()),
        )
        .addButton((button) =>
          button
            .setButtonText('Create skill')
            .setCta()
            .onClick(() => {
              if (!draft.name.trim()) {
                new Notice('Give the skill a name.');
                return;
              }
              this.close();
              void workspace
                .createSkill({
                  name: draft.name.trim(),
                  description: draft.description.trim(),
                  instructions: draft.instructions,
                })
                .then(
                  (path) => {
                    new Notice(`Skill created: ${path}`);
                    workspace.openNote(path).catch((error: unknown) => {
                      workspace.reportError(error);
                    });
                  },
                  (error: unknown) => {
                    workspace.reportError(error);
                  },
                );
            }),
        );
    }
    onClose(): void {
      this.contentEl.empty();
    }
  }
  new SkillForm(app).open();
}

/** Assign a skill: tick the agents and projects that should have it. Unticking removes it from them. */
export function openAssignSkill(
  app: App,
  workspace: WorkspaceActions,
  skill: Skill,
): void {
  class AssignForm extends Modal {
    onOpen(): void {
      this.setTitle(`Assign ${skill.name}`);
      const snapshot = workspace.getSnapshot();
      const users = skillUsers(skill, snapshot.agents, snapshot.projects ?? []);
      const agentIds = new Set(users.agents.map((agent) => agent.id));
      const projectIds = new Set(users.projects.map((project) => project.id));
      const wantAgents = new Set(agentIds);
      const wantProjects = new Set(projectIds);
      new Setting(this.contentEl).setName('Agents').setHeading();
      for (const agent of snapshot.agents)
        new Setting(this.contentEl).setName(agent.name).addToggle((toggle) =>
          toggle.setValue(agentIds.has(agent.id)).onChange((on) => {
            if (on) wantAgents.add(agent.id);
            else wantAgents.delete(agent.id);
          }),
        );
      new Setting(this.contentEl).setName('Projects').setHeading();
      for (const project of snapshot.projects ?? [])
        new Setting(this.contentEl).setName(project.name).addToggle((toggle) =>
          toggle.setValue(projectIds.has(project.id)).onChange((on) => {
            if (on) wantProjects.add(project.id);
            else wantProjects.delete(project.id);
          }),
        );
      new Setting(this.contentEl)
        .addButton((button) =>
          button.setButtonText('Cancel').onClick(() => this.close()),
        )
        .addButton((button) =>
          button
            .setButtonText('Save')
            .setCta()
            .onClick(() => {
              const add = (ids: Set<string>, base: Set<string>) =>
                [...ids].filter((id) => !base.has(id));
              const remove = (ids: Set<string>, base: Set<string>) =>
                [...base].filter((id) => !ids.has(id));
              this.close();
              void (async () => {
                await workspace.assignSkill(skill.path, {
                  agentIds: add(wantAgents, agentIds),
                  projectIds: add(wantProjects, projectIds),
                  add: true,
                });
                await workspace.assignSkill(skill.path, {
                  agentIds: remove(wantAgents, agentIds),
                  projectIds: remove(wantProjects, projectIds),
                  add: false,
                });
                new Notice('Skill assignments saved.');
              })().catch((error: unknown) => {
                workspace.reportError(error);
              });
            }),
        );
    }
    onClose(): void {
      this.contentEl.empty();
    }
  }
  new AssignForm(app).open();
}
