import { describe, expect, it } from 'vitest';
import { blockedHint } from '../src/core/blockedHints';
import { BLOCKED_RULE, buildSystemPrompt } from '../src/core/prompt';
import { changedFiles, taskProblem } from '../src/core/taskOutcome';
import { OBI_ROLE } from '../src/core/obi';
import { GUIDE_BODY } from '../src/core/guide';
import { MemoryStore } from '../src/core/memoryStore';

const FLAGS = /--add-dir|--restricted|sandbox/i;

describe('blocked work is explained in Mesa terms', () => {
  it('the shared prompt carries the rule and no flag names', async () => {
    expect(BLOCKED_RULE).toContain('Setup');
    expect(BLOCKED_RULE).not.toMatch(/--add-dir|--restricted/);
    const store = new MemoryStore();
    await store.createAgent('A');
    const agent = (await store.loadAgents()).agents[0]!;
    expect(buildSystemPrompt(agent, [agent], [])).toContain(BLOCKED_RULE);
  });
  it('maps runtime wording to a Mesa hint without flags', () => {
    for (const text of [
      'Path is outside the allowed working directories (use --add-dir)',
      'Edit denied: file is read-only',
      'Operation not permitted by sandbox',
    ]) {
      const hint = blockedHint(text)!;
      expect(hint).toContain('Setup');
      expect(hint).not.toMatch(FLAGS);
    }
    expect(blockedHint('All good')).toBeUndefined();
  });
  it('the guide and Obi role use Mesa wording', () => {
    expect(GUIDE_BODY).toContain('Note destinations → tick Wiki');
    expect(OBI_ROLE).toBe('Your Mesa assistant');
  });
});

describe('a task that did nothing is not passed', () => {
  const edit = [{ name: 'Edit', summary: 'Wiki/Page.md' }];
  it('lists changed files and ignores denied or read tools', () => {
    expect(
      changedFiles([
        ...edit,
        { name: 'Edit denied', summary: 'x.md' },
        { name: 'Read', summary: 'y.md' },
      ]),
    ).toEqual(['Wiki/Page.md']);
  });
  it('flags an answer that says it could not, with a Mesa hint', () => {
    const problem = taskProblem(
      'Write the page',
      'I could not write there: permission denied',
      [],
    );
    expect(problem?.kind).toBe('cannot');
    expect(problem?.message).not.toMatch(FLAGS);
  });
  it('flags a write task with no edit and no command', () => {
    expect(taskProblem('Create a note about X', 'Done!', [])?.kind).toBe(
      'nothing-written',
    );
  });
  it('accepts real edits, commands and read-only tasks', () => {
    expect(taskProblem('Create a note', 'Done', edit)).toBeUndefined();
    expect(
      taskProblem('Create a file', 'Done', [{ name: 'Bash', summary: 'echo' }]),
    ).toBeUndefined();
    expect(
      taskProblem('Summarise the notes', 'Here it is', []),
    ).toBeUndefined();
  });
});
