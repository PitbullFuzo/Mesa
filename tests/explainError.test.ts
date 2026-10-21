import { describe, expect, it } from 'vitest';
import {
  explainError,
  explanationLine,
  formatExplanation,
} from '../src/core/explainError';
import { BLOCKED_RULE, FAILURE_RULE } from '../src/core/prompt';
import { describeAction, type ObiAction } from '../src/core/obi';
import { GUIDE_BODY } from '../src/core/guide';
import { setupNeeds } from '../src/core/setupNeeds';

const FLAGS = /--add-dir|--restricted|--[a-z-]+ flag/i;

describe('failures in plain language', () => {
  const cases: [string, RegExp][] = [
    ['Path is outside the allowed working directories', /Note destinations/],
    ['Edit denied: file is read-only', /Permission/],
    ['Web access is off', /Web access/],
    ['Runtime claude: command not found', /Install/],
    ['Please run login: not logged in', /sign in/i],
    ['429 rate limit exceeded', /usage limit|credit/],
    ['Request timed out after 120s', /smaller piece/],
    ['The command line is too long', /shorter message/],
    ['AADSTS70000 invalid_grant', /Connectors/],
    ['Playwright browser not set up', /Browser control/],
  ];
  it.each(cases)('explains %s with what, why and what to do', (raw, todo) => {
    const found = explainError(raw, 'Writer');
    expect(found.happened).not.toBe('');
    expect(found.why).not.toBe('');
    expect(found.todo).toMatch(todo);
    expect(`${found.happened}${found.why}${found.todo}`).not.toMatch(FLAGS);
    const markdown = formatExplanation(found);
    expect(markdown).toContain('**What happened:**');
    expect(markdown).toContain('**Why:**');
    expect(markdown).toContain('**What to do:**');
    expect(explanationLine(found)).not.toContain('**');
  });
  it('names the agent in the click path', () => {
    expect(explainError('Edit denied: read-only', 'Writer').todo).toContain(
      'Open Writer → Setup',
    );
  });
  it('gives unknown errors a plain sentence and collapsible technical details', () => {
    const found = explainError('weird ```boom``` 0xDEAD');
    expect(found.happened).toMatch(/went wrong/);
    const markdown = formatExplanation(found);
    expect(markdown).toContain('<summary>Technical details</summary>');
    expect(markdown).toContain('0xDEAD');
    expect(markdown.match(/```/g)).toHaveLength(2);
  });
  it('the shared prompt rules cover failures and blocked work', () => {
    expect(FAILURE_RULE).toMatch(/what failed/);
    expect(BLOCKED_RULE).toMatch(/Setup/);
  });
});

describe('Obi recommends the Setup an agent needs', () => {
  it.each([
    ['SEO Writer', 'Writes blog posts', /Web access|Permission: Edit/],
    ['Researcher', 'Finds news', /Web access/],
    ['Scraper', 'Browses sites', /Browser control/],
    ['Mail helper', 'Reads my email and calendar', /Microsoft 365/],
    ['Builder', 'Runs scripts', /Run commands/],
  ])('%s', (name, role, expected) => {
    expect(setupNeeds(name, role).join('|')).toMatch(expected);
  });
  it('adds nothing for a job that needs no switch', () => {
    expect(setupNeeds('Greeter', 'Says hello')).toEqual([]);
  });
  it('shows the list on the createAgent proposal card, and the guide has the table', () => {
    const action: ObiAction = {
      type: 'createAgent',
      name: 'SEO Researcher',
      role: 'Research keywords and news',
    };
    const card = describeAction(action, {
      agents: [],
      groups: [],
      projects: [],
      schedules: [],
      skills: [],
    });
    const needs = card.fields.find(
      (entry) => entry.label === 'You will need to turn on',
    );
    expect(needs?.value).toContain('Open SEO Researcher → Setup → Web access');
    expect(GUIDE_BODY).toContain('What each agent needs');
    expect(GUIDE_BODY).toContain('| Do SEO, research or news | Web access |');
  });
});
