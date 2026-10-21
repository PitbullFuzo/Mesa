import { blockedHint } from './blockedHints';

export interface TurnTool {
  name: string;
  summary: string;
}

const EDIT_TOOLS = /edit|write|patch|file_change|create/i;
const NOT_EDITS = /denied|read|search|grep|glob/i;
const COMMAND_TOOLS = /^(?:bash|command|command_execution|shell|run)\b/i;
const WRITE_WORDS = /\b(?:write|create|save|edit|append|draft|rename)\b/i;
const CANNOT_WORDS =
  /\b(?:i (?:could not|couldn['’]t|can['’]t|cannot|was unable to|wasn['’]t able to|am unable to|am not able to|don['’]t have (?:permission|access))|unable to (?:write|create|save|edit|access)|(?:was|were|is|are) (?:blocked|denied|not permitted|not allowed)|permission denied|read[- ]only)\b/i;

/** Paths of the files the worker edited or wrote this turn, from the runtime's tool events. */
export function changedFiles(tools: TurnTool[]): string[] {
  return [
    ...new Set(
      tools
        .filter(
          (tool) => EDIT_TOOLS.test(tool.name) && !NOT_EDITS.test(tool.name),
        )
        .map((tool) => tool.summary.trim())
        .filter((path) => path !== ''),
    ),
  ];
}

export interface TaskProblem {
  kind: 'cannot' | 'nothing-written';
  /** One plain sentence for the task note and the Inbox. */
  message: string;
}

/**
 * Did a delegated task end without doing its work? Only when nothing was edited: either the answer says the
 * work could not be done, or a task that asks for writing ended with no edit and no command that could have written.
 */
export function taskProblem(
  taskText: string,
  answer: string,
  tools: TurnTool[],
): TaskProblem | undefined {
  if (changedFiles(tools).length > 0) return undefined;
  if (CANNOT_WORDS.test(answer)) {
    const hint = blockedHint(answer);
    return {
      kind: 'cannot',
      message: `The agent says it could not do this task.${hint ? ` ${hint}` : ' Open its answer to see why.'}`,
    };
  }
  const ranCommand = tools.some((tool) => COMMAND_TOOLS.test(tool.name));
  if (WRITE_WORDS.test(taskText) && !ranCommand)
    return {
      kind: 'nothing-written',
      message:
        'This task asked for writing, but no file was changed. Check the agent’s Setup (Permission and the ticked folders), then retry.',
    };
  return undefined;
}
