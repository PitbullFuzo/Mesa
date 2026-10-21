import type { Store } from './store';
import { DEFAULT_RUNTIME_ID } from './runtimes/ids';

// Upstream skill body and original MIT notice are retained together.
const KARPATHY_GUIDELINES =
  '# Karpathy Guidelines\n\nBehavioral guidelines to reduce common LLM coding mistakes.\n\n**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.\n\n## 1. Think Before Coding\n\n**Don\'t assume. Don\'t hide confusion. Surface tradeoffs.**\n\nBefore implementing:\n- State assumptions explicitly. If uncertain, ask.\n- If multiple interpretations exist, present them—don\'t pick silently.\n- If a simpler approach exists, say so. Push back when warranted.\n- If something is unclear, stop. Name what\'s confusing. Ask.\n\n## 2. Simplicity First\n\n**Minimum code that solves the problem. Nothing speculative.**\n\n- No features beyond what was asked.\n- No abstractions for single-use code.\n- No "flexibility" or "configurability" that wasn\'t requested.\n- No error handling for edge cases the prompt doesn\'t mention. Don\'t pre-handle blank lines, missing fields, or malformed input unless asked.\n- No docstrings or type annotations unless the surrounding code already uses them or the user asks. Documentation is a feature—don\'t add it speculatively.\n- If 200 lines could be 50, rewrite it.\n\n**Test:** Re-read the user\'s request. Can you justify every line you wrote by pointing to something they asked for? If not, delete it.\n\n## 3. Surgical Changes\n\n**Touch only what you must. Clean up only your own mess.**\n\nWhen editing existing code:\n- Don\'t "improve" adjacent code, comments, or formatting.\n- Don\'t refactor things that aren\'t broken.\n- Match existing style, even if you\'d do it differently.\n- If you notice unrelated dead code, mention it—don\'t delete it.\n\nWhen your changes create orphans:\n- Remove imports/variables/functions that YOUR changes made unused.\n- Don\'t remove pre-existing dead code unless asked.\n\n**Test:** Every changed line should trace directly to the user\'s request.\n\n## 4. Goal-Driven Execution\n\n**Define success criteria. Loop until verified.**\n\nTransform tasks into verifiable goals:\n- "Add validation" → Write tests for invalid inputs, then make them pass\n- "Fix the bug" → Write a test that reproduces it, then make it pass\n- "Refactor X" → Ensure tests pass before and after\n\nFor multi-step tasks, state a brief plan:\n```\n1. [Step] → verify: [check]\n2. [Step] → verify: [check]\n```\n\nStrong success criteria enable independent looping. Weak criteria ("make it work") require constant clarification.\n\n---\n\n**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.\n\n## Source and license\n\nSource: https://raw.githubusercontent.com/chrisliu298/karpathy-guidelines/main/SKILL.md\n\nMIT License\n\nCopyright (c) 2025 chrisliu298\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and\nassociated documentation files (the "Software"), to deal in the Software without restriction, including\nwithout limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the\nfollowing conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial\nportions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT\nLIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO\nEVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER\nIN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE\nUSE OR OTHER DEALINGS IN THE SOFTWARE.\n';

/** Every Mesa subfolder. Checked on every start, so vaults made by older versions get the missing ones. */
export const AGENTHQ_FOLDERS = [
  'Agents',
  'Skills',
  'Chats',
  'Tasks',
  'Activity',
  'Projects',
  'Schedules',
  'Work',
  'Attachments',
] as const;

/** Creates each missing Mesa subfolder under root. Existing folders and their content are left alone. */
export async function ensureAgentHqFolders(
  store: Store,
  root: string,
): Promise<void> {
  for (const folder of AGENTHQ_FOLDERS) {
    const path = `${root}/${folder}`;
    if (!(await store.exists(path))) await store.createFolder(path);
  }
}

export async function initializeStarterTeam(
  store: Store,
  root: string,
): Promise<boolean> {
  if (await store.exists(root)) return false;
  await store.createFolder(root);
  await ensureAgentHqFolders(store, root);
  const common = {
    agenthq: 'agent',
    group: 'core',
    runtime: DEFAULT_RUNTIME_ID,
    model: '',
    workdir: '',
    outsideFolders: [],
  };
  await store.createNote(
    `${root}/Agents/CEO.md`,
    {
      ...common,
      id: 'ceo',
      role: 'Lead',
      reportsTo: null,
      permission: 'read-only',
      verifier: null,
      skills: [],
    },
    'You plan, break goals into tasks, delegate to your team, and report back clearly.',
  );
  await store.createNote(
    `${root}/Agents/Coder.md`,
    {
      ...common,
      id: 'coder',
      role: 'Software engineer',
      reportsTo: '[[CEO]]',
      permission: 'edit',
      verifier: '[[Reviewer]]',
      skills: ['[[karpathy-guidelines]]'],
    },
    'You write clean, minimal code. Explain what you changed and how to test it.',
  );
  await store.createNote(
    `${root}/Agents/Reviewer.md`,
    {
      ...common,
      id: 'reviewer',
      role: 'Reviewer',
      reportsTo: '[[CEO]]',
      permission: 'read-only',
      verifier: null,
      skills: [],
    },
    'You check work strictly and return a verdict. Explain any failures with specific, actionable feedback.',
  );
  await store.saveGroups([{ id: 'core', name: 'Core team', color: '#7c3aed' }]);
  await store.createNote(
    `${root}/Skills/karpathy-guidelines.md`,
    { license: 'MIT' },
    KARPATHY_GUIDELINES,
  );
  await store.createNote(
    `${root}/Welcome.md`,
    {},
    '# Welcome to Mesa\n\nClick CEO in the AI Graph and tell it what you need.\n\n1. Use the network ribbon to open AI Graph. Click CEO (or choose Open Team panel from the command palette) and type in Chat.\n2. The starter team is ready: [[CEO]] leads, [[Coder]] writes, [[Reviewer]] verifies. Agents use their default Work folders without changing Settings. Real replies use your installed runtime account and may cost money.\n3. Right-click any Markdown note or its editor and choose **Ask an agent about this note…** for a fresh conversation with its content.\n4. In Settings → Mesa, import installed skills, choose other allowed folders, or set a runtime path override if detection fails. Offline/sign-in guidance appears in Chat.\n5. Tasks, Chats and monthly Activity are ordinary notes. Use Inbox for failed reviews and Stop all to cancel work. Full permission is unavailable; protected folders cannot be edited by agents.\n\nAfter rebuilding the plugin, switch it off and on in Community plugins (or restart Obsidian). Existing team folders and notes are never overwritten.',
  );
  return true;
}
