import { Modal, Notice, Setting, type App } from 'obsidian';
import { pickableProjects, type Project } from '../core/projects';
import {
  previewLine,
  type Schedule,
  type ScheduleInput,
  type ScheduleRule,
} from '../core/schedules';
import type { WorkspaceActions } from '../core/workspace';

const DAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

export interface ScheduleFormOptions {
  /** Editing this schedule; null creates a new one. */
  existing?: Schedule | null;
  agentId?: string;
  projectId?: string;
  message?: string;
}

/**
 * The schedule form, for creating and editing. The preview line is the next run the scheduler will use. "Run now"
 * saves, then runs the schedule once through the queue without changing its regular next run.
 */
export function openScheduleForm(
  app: App,
  workspace: WorkspaceActions,
  options: ScheduleFormOptions,
): void {
  class ScheduleForm extends Modal {
    onOpen(): void {
      const snapshot = workspace.getSnapshot();
      const existing = options.existing ?? null;
      const agents = snapshot.agents;
      const projects: Project[] = snapshot.projects ?? [];
      this.setTitle(existing ? `Schedule: ${existing.name}` : 'New schedule');
      const rule = existing?.rule;
      // A project's schedule starts with an agent that is assigned to that project.
      const assignedAgentId = options.projectId
        ? agents.find((agent) =>
            pickableProjects(projects, agent.id, agents, snapshot.groups).some(
              (project) => project.id === options.projectId,
            ),
          )?.id
        : undefined;
      const draft = {
        name: existing?.name ?? 'Scheduled message',
        agentId:
          existing?.agentId ??
          options.agentId ??
          assignedAgentId ??
          agents[0]?.id ??
          '',
        projectId: existing?.projectId ?? options.projectId ?? '',
        message: existing?.message ?? options.message ?? '',
        kind: rule?.kind ?? 'daily',
        time: rule && 'time' in rule ? rule.time : '09:00',
        day: rule?.kind === 'weekly' ? rule.day : 1,
        hours: String(rule?.kind === 'every' ? rule.hours : 4),
        cap: existing?.costCapUsd?.toString() ?? '',
        missedRun: existing?.missedRun ?? 'skip',
        enabled: existing?.enabled ?? true,
      };

      new Setting(this.contentEl).setName('Name').addText((text) => {
        text
          .setValue(draft.name)
          .setDisabled(!!existing)
          .onChange((value) => (draft.name = value));
      });
      new Setting(this.contentEl).setName('Agent').addDropdown((drop) => {
        for (const agent of agents) drop.addOption(agent.id, agent.name);
        drop.setValue(draft.agentId).onChange((value) => {
          draft.agentId = value;
          // A project belongs to the picker only when this agent is assigned to it.
          if (
            !pickableProjects(projects, value, agents, snapshot.groups).some(
              (p) => p.id === draft.projectId,
            )
          )
            draft.projectId = '';
          renderProjects();
        });
      });
      const projectBox = this.contentEl.createDiv();
      const renderProjects = () => {
        projectBox.empty();
        const choices = pickableProjects(
          projects,
          draft.agentId,
          agents,
          snapshot.groups,
        );
        new Setting(projectBox)
          .setName('Project')
          .setDesc('Only projects this agent is assigned to.')
          .addDropdown((drop) => {
            drop.addOption('', 'No project');
            for (const project of choices)
              drop.addOption(project.id, project.name);
            drop
              .setValue(draft.projectId)
              .onChange((value) => (draft.projectId = value));
          });
      };
      renderProjects();
      new Setting(this.contentEl)
        .setName('Message')
        .setDesc('Sent to the agent on each run.')
        .addTextArea((area) => {
          area
            .setValue(draft.message)
            .onChange((value) => (draft.message = value));
          area.inputEl.rows = 4;
        });
      new Setting(this.contentEl).setName('Repeat').addDropdown((drop) => {
        drop
          .addOption('daily', 'Every day')
          .addOption('weekdays', 'Weekdays')
          .addOption('weekly', 'Once a week')
          .addOption('every', 'Every N hours')
          .setValue(draft.kind)
          .onChange((value) => {
            draft.kind = value as ScheduleRule['kind'];
            refreshPreview();
          });
      });
      new Setting(this.contentEl)
        .setName('At (clock time)')
        .setDesc(
          '24-hour clock time, for example 09:30. Used for daily, weekday and weekly repeats.',
        )
        .addText((text) =>
          text.setValue(draft.time).onChange((value) => {
            draft.time = value;
            refreshPreview();
          }),
        );
      new Setting(this.contentEl)
        .setName('Day (once a week)')
        .addDropdown((drop) => {
          for (const [index, day] of DAYS.entries())
            drop.addOption(String(index), day);
          drop.setValue(String(draft.day)).onChange((value) => {
            draft.day = Number(value);
            refreshPreview();
          });
        });
      new Setting(this.contentEl).setName('Every N hours').addText((text) =>
        text.setValue(draft.hours).onChange((value) => {
          draft.hours = value;
          refreshPreview();
        }),
      );
      const preview = new Setting(this.contentEl).setName('Preview');
      const refreshPreview = () => {
        const built = ruleFrom(draft);
        preview.setDesc(
          typeof built === 'string' ? built : previewLine(built, new Date()),
        );
      };
      refreshPreview();
      new Setting(this.contentEl)
        .setName('Cost cap per run, USD (optional)')
        .setDesc('A run is held once the previous run reached this amount.')
        .addText((text) =>
          text.setValue(draft.cap).onChange((value) => (draft.cap = value)),
        );
      new Setting(this.contentEl)
        .setName('Missed runs')
        .setDesc('When Obsidian was closed at the run time.')
        .addDropdown((drop) => {
          drop
            .addOption('skip', 'Skip them')
            .addOption('run-once', 'Run once when Obsidian opens')
            .setValue(draft.missedRun)
            .onChange(
              (value) => (draft.missedRun = value as 'skip' | 'run-once'),
            );
        });
      new Setting(this.contentEl)
        .setName('Enabled')
        .setDesc('Schedules run only while Obsidian is open.')
        .addToggle((toggle) =>
          toggle
            .setValue(draft.enabled)
            .onChange((value) => (draft.enabled = value)),
        );

      const build = ():
        { input: ScheduleInput; rule: ScheduleRule } | string => {
        const rule = ruleFrom(draft);
        if (typeof rule === 'string') return rule;
        const cap = draft.cap.trim() ? Number(draft.cap) : undefined;
        if (cap !== undefined && (!Number.isFinite(cap) || cap <= 0))
          return 'The cost cap must be a positive number.';
        if (!draft.agentId) return 'Pick an agent.';
        if (!draft.message.trim()) return 'Write the message first.';
        return {
          rule,
          input: {
            name: draft.name.trim() || 'Scheduled message',
            agentId: draft.agentId,
            projectId: draft.projectId || undefined,
            message: draft.message.trim(),
            rule,
            costCapUsd: cap,
            missedRun: draft.missedRun,
            enabled: draft.enabled,
          },
        };
      };
      const save = async (runAfter: boolean): Promise<void> => {
        const built = build();
        if (typeof built === 'string') {
          new Notice(built);
          return;
        }
        this.close();
        const path = existing
          ? existing.path
          : await workspace.createSchedule(built.input);
        if (existing) {
          const { name: _name, ...rest } = built.input;
          await workspace.updateSchedule(path, rest);
        }
        if (runAfter) await workspace.runScheduleNow(path);
        new Notice(existing ? 'Schedule saved.' : 'Schedule created.');
      };
      new Setting(this.contentEl)
        .addButton((button) =>
          button.setButtonText('Cancel').onClick(() => this.close()),
        )
        .addButton((button) =>
          button.setButtonText('Run now').onClick(() => {
            void save(true).catch((error: unknown) =>
              workspace.reportError(error),
            );
          }),
        )
        .addButton((button) =>
          button
            .setButtonText('Save')
            .setCta()
            .onClick(() => {
              void save(false).catch((error: unknown) =>
                workspace.reportError(error),
              );
            }),
        );
    }
    onClose(): void {
      this.contentEl.empty();
    }
  }
  new ScheduleForm(app).open();
}

/** Checks the repeat fields and builds the rule, or returns the message to show. */
function ruleFrom(draft: {
  kind: ScheduleRule['kind'];
  time: string;
  day: number;
  hours: string;
}): ScheduleRule | string {
  if (draft.kind === 'every') {
    const hours = Number(draft.hours);
    if (!Number.isInteger(hours) || hours < 1 || hours > 168)
      return 'Use a whole number of hours from 1 to 168.';
    return { kind: 'every', hours };
  }
  const clock = draft.time.trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(clock))
    return 'Use a clock time like 09:30.';
  if (draft.kind === 'weekly')
    return { kind: 'weekly', day: draft.day, time: clock };
  return { kind: draft.kind, time: clock };
}
