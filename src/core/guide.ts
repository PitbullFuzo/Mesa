import { WHAT_EACH_AGENT_NEEDS } from './setupNeeds';
import type { Store } from './store';

/**
 * The one guide text: the welcome tour, Guide.md and Obi's prompt all come from here.
 * Rule for every later step: a feature that changes what agents can do updates these sections in the same step.
 * Bump GUIDE_VERSION when the text changes, so Guide.md is refreshed in existing vaults.
 */
export const GUIDE_VERSION = 28;

/** The owner's site: how-tos and feedback. A plain link, nothing is sent from the plugin. */
export const HELP_URL = 'https://trabalhoia.com';

export const GUIDE_SECTIONS: { title: string; body: string }[] = [
  {
    title: 'What Mesa is',
    body: 'Mesa runs AI agents inside Obsidian. Each agent is a note in the Mesa folder. You talk to them in Chat, and they answer with the AI tool you installed (Claude Code, Codex, OpenCode or Hermes), which uses your own account and plan.',
  },
  {
    title: 'What you need',
    body: [
      '- Obsidian desktop, on Windows or Mac: https://obsidian.md',
      '- At least one AI tool, installed and signed in. Claude Code (a Claude plan or an API key): https://code.claude.com/docs/en/setup . Codex CLI (a ChatGPT plan; version 0.160.0 or newer; a newer version is checked once by Mesa, then used): https://github.com/openai/codex . OpenCode (version 1.19.1 or newer, checked the same way): https://opencode.ai . Hermes: see the Hermes section of the README.',
      '- Node.js, only for browser control: https://nodejs.org',
      '- Python comes with Hermes; you do not install it yourself.',
      '- Git is optional, for backups: https://git-scm.com',
      '- No coding languages are needed to use Mesa itself.',
    ].join('\n'),
  },
  {
    title: 'Agents, groups and the CEO',
    body: 'Agents are team members with a role, instructions and a manager. Groups organise them on the AI Graph. The starter team has a CEO who leads, a Coder who writes and a Reviewer who checks. A manager can pass work to its direct reports, and the results come back to you.',
  },
  {
    title: 'Projects, memory and costs',
    body: 'A project groups agents and skills around a goal, with its own log and memory. A project cost limit stops its runs when the limit is reached. Every run uses your own AI plan or account, so costs can add up: the cost is shown on each reply, and your provider has the full bill.',
  },
  {
    title: 'Schedules and loops',
    body: "A schedule runs an agent's message at a set time. A loop repeats a message until the reviewer passes it or a count is reached. Both run only while Obsidian is open, and both stop at their cost caps.",
  },
  {
    title: 'Safety in plain words',
    body: [
      '- Agents write only to their Work folder, plus the outside folders you tick for that agent in its Setup. Settings lists the folders you allow; an agent with none ticked has no outside folders.',
      '- A project can have an Output folder for its finished work. Only that project’s runs may write there; drafts stay in Work.',
      '- Settings can hide Mesa from search and the graph (Obsidian’s Excluded files). Show again undoes it.',
      '- "Read & write vault" lets an agent change your notes. Turn it on only when you need it.',
      '- Vault access together with web access could let a bad web page trick an agent into sending your notes out. Use web access only when you need it.',
      '- Codex can read the whole computer, not only the vault.',
      '- The browser uses a clean profile with no logins. It works with Claude Code, Hermes, OpenCode and Codex. For Codex it needs its own extra tick box, because Codex can also read files anywhere on this computer.',
      '- "Reorganise vault" moves notes only after you review a plan and apply it. Moves update links, nothing is deleted, and "Undo last reorganisation" puts the files back. Back up first.',
      '- Only notes (.md) are moved. Images and other files stay where they are.',
      '- Run commands is off for every agent until you set it. Allow freely lets an agent run commands as you, with a warning and a tick box: Claude Code, OpenCode and Hermes get a command tool only then. Codex always runs its own commands, so for Codex Off keeps them inside its sandbox (only the folders you allow, no internet) and Allow freely removes the sandbox: no folder limits and internet on. Ask me each time (OpenCode and Hermes only) shows an Approve or Reject card in the agent’s chat for every command; nothing runs until you approve, nothing is remembered, and a scheduled or looping run waits and adds an Inbox item. Claude Code and Codex cannot hold a command for approval, so they have only Off and Allow freely.',
      "- AI costs come from your own plans. Project cost limits help, but check your provider's dashboard.",
      '- Back up your vault before you give agents write access or reorganise notes.',
    ].join('\n'),
  },
  {
    title: "What agents can and can't do",
    body: [
      '- Edit files in the folders you allow: yes. Set it per agent in Setup.',
      '- Web and browser: yes, when web access or browser control is on. Only the owner switches these on, in Setup.',
      '- Run programs: only when Run commands is set to Allow freely (every runtime) or Ask me each time (OpenCode and Hermes) in that agent’s Setup. Codex also runs sandboxed commands when Off. Off is the default.',
      '- Word, Excel and PowerPoint files: they need Run commands on Allow freely or Ask me each time, and a tool that can make them.',
      '- Note destinations: Settings → Note destinations maps note types (Meeting notes → Meetings/, Research → Research/, Wiki → Wiki/, Permanent notes → Permanent/, and ones you add) to folders in your own vault. In an agent’s Setup you tick which types it may write; only those folders become writable for it, nothing else in your vault, and without Read & write vault. Each built-in type has a note skill (template, naming, links) on the Skills page that you can edit. Agents link people, projects and existing notes with [[ ]] so notes join your graph, and update a wiki page instead of duplicating it. Agents have no note destinations until you tick them.',
      '- Microsoft 365 (Outlook mail, calendar, OneDrive): Settings → Connectors. Just press Sign in: a window shows a code and a button that opens Microsoft’s own page. Microsoft may call the app “unverified” on its screen until the publisher is verified. You can instead paste your own app registration’s client ID first; Mesa never sees your password. The sign-in is kept in a file outside your vault, not encrypted. Then tick Can use Microsoft 365 for each agent (Claude Code, OpenCode and Hermes; not Codex). Agents can read and create drafts. Sending, replying, forwarding, deleting, answering invitations, creating events, sharing and writing files each show an Approve card with the full content first, and nothing is remembered. Disconnect removes the saved sign-in; to end Microsoft’s access too, remove the app in your Microsoft account’s app permissions. Mail and files are untrusted text. Do not combine it with Run commands: Allow freely. Google/Gmail is not available yet.',
      '- Your vault notes (not Mesa’s own): an agent with vault access reads a map of your vault first, then sees the passages that best match your message. It opens only the notes it needs.',
      '- Earlier chats: an agent keeps its conversation going in the same chat; a new chat starts with a short summary of the last one; History lets you open an old chat and continue it; project memory keeps decisions for a project. Chat recall adds to these: when your message looks back ("last time", "we discussed", "remember when", "da última vez", "falámos"), Mesa searches that agent’s own past chats (never other agents’, never the current chat) with plain keyword search, no AI and no cost, and gives it the best matching passages with the chat title and date. Messages that don’t look back add nothing. Obi recalls its own chats the same way.',
      '- Chat extras: above the messages a small bar shows how much of the model’s context the chat uses (a tip suggests a new chat or Fork above about 80%; it says unknown, or shows only tokens, when the runtime does not report the window). For Claude Code agents it also shows your plan’s usage (for example “5h 11% · week 42%”); click it for the reset times. It updates after each reply. The 📎 button attaches the note you have open: a chip shows it and can be removed, and an agent without vault access sees that note only because you attached it. In the message box, type / for commands: /new, /compact (a new chat that starts with a short summary of this one), /fork (a new chat from the last message), /skill <name> <message> (use a skill for that one message), /project <name> and /help. /side <question> (or /btw) asks the same agent a side question in a fresh session that only sees the end of this chat; the answer appears in a box under the chat, and “Add to main chat” puts it, quoted, in your message box. Type @ to attach a note, a folder (its list of notes) or another agent’s chat: it becomes a chip you can remove, and an agent without vault access sees it only because you chose it. Anything else you type with a / is sent as ordinary text.',
      '- Edit selection with an agent: select text in a note (or put the cursor in a paragraph) and run the command Edit selection with an agent from the command palette, or right-click and choose Edit with an agent… (no hotkey is set; you can give the command one). Choose an agent and say what should change; the agent works read-only and sees only that text and a little around it. You get a preview with the cost: changed phrases show the old words faded and struck through next to the new words, and when most of the text changed (a rewrite or a translation) the preview shows Before and After instead, with a button to switch that is remembered. and nothing is written until you press Accept. Accept replaces exactly that text, and Ctrl+Z undoes it; Reject and Try again change nothing.',
      '- When an agent cannot read or write a folder, it tells you the Mesa step (for example “Open Coder → Setup → Note destinations → tick Wiki”, or “Setup → Permission → Edit”), never a command-line flag. A delegated task that wrote nothing shows as Needs you, not Passed.',
      '- Anything else: change it in Setup. Obi can propose changes, and you approve each one.',
    ].join('\n'),
  },
  {
    title: 'Graph map and overview',
    body: [
      '- Graph map (Graph map.md in the Mesa folder): built from your links with no AI. It lists hubs (most linked notes), clusters (notes that link to each other), bridges (notes that join clusters) and orphans (no links). It is rebuilt a few minutes after your vault changes, and it is written only when it changes.',
      '- Vault overview (ribbon icon, or the command "Open vault overview"): every note is a dot and links are lines. The dots move and settle into clusters, coloured by cluster; hubs are bigger, bridge notes have a ring, and notes with no links sit grey at the edge. Drag a dot and its neighbours react. Scroll to zoom, drag the background to pan, hover to see a note and its links, click a dot to open the note. Search highlights matching notes, Fit shows everything, and clicking a legend item zooms to that cluster. Dots and lines are small, with note names fading in as you zoom, and dragging a dot pulls its neighbours along like elastic. The gear at the top right opens Display & forces: sliders for node size, line thickness, and the centre, repel and link forces and link distance, plus Show labels, Show orphans, Show cluster list and Reset. Names are short (no folder, date or id), and the clusters sit in a closed “Clusters (N)” dropdown showing the 12 biggest, with Show all. Your choices are remembered. It uses no AI and no cost, and it stops moving once settled.',
      '- Graph overview.canvas is no longer written. You can delete that file; the vault overview replaces it.',
      '- The maps save AI tokens: Vault map.md and Graph map.md are what agents read first, instead of searching your whole vault. They update themselves. Please don’t delete or move them; if you do, Mesa rebuilds them.',
      '- AI concepts (optional, off by default, Settings → Graph AI concepts): a cheap model reads notes with few links once per change and suggests concepts and related notes. Every suggestion must name a real note and a phrase from the note, or it is dropped. Free models’ providers may keep or train on what they read. Don’t use them on private notes.',
      '- For code projects or piles of documents, the Graphify skill (an agent with Run commands: Allow freely) builds a deeper code and concept graph. It runs outside Mesa’s walls and costs tokens.',
    ].join('\n'),
  },
];

/** The disclaimer, shown once at the end of the tour. The same text is in the README. */
export const DISCLAIMER =
  "Mesa lets AI agents read and change files you allow. It is provided as-is, without warranty. We aren't responsible for data loss or AI costs. Please back up your vault before giving agents write access or reorganising notes.";

/**
 * Kept out of the welcome tour so the tour stays short: it is in Guide.md and in Obi's prompt. The three options are
 * the ones Obi answers from when the owner asks how to hide chats.
 */
const HELP_AND_FEEDBACK = {
  title: 'Help and feedback',
  body: `How-tos and feedback: trabalhoia.com (${HELP_URL}). Settings → Mesa → Help & feedback opens it in your browser.`,
};

const GRAPH_AND_SEARCH = {
  title: 'Keeping your graph and search tidy',
  body: [
    '- Hide all of Mesa from search and the graph: the welcome tour asks once ("Keep your graph tidy?", Hide it / Keep it visible), or use Settings → Mesa → "Hide Mesa from search & graph" any time. "Show again" reverses it. The Vault overview never shows Mesa’s notes either way.',
    '- Hide only chats, everywhere (search and graph too): Settings → Files and links → Excluded files → Manage, then add the Chats folder inside your Mesa folder (Mesa/Chats by default).',
    '- Hide chats from the graph only, still searchable: open the graph, its settings icon, Filters, then type -path:Mesa/Chats (use the name of your folder if you changed it).',
  ].join('\n'),
};

const AGENT_NEEDS = {
  title: 'What each agent needs',
  body: `Obi lists these when it proposes an agent, and never turns them on itself. You switch them on in the agent’s Setup.\n\n${WHAT_EACH_AGENT_NEEDS}`,
};

/** The guide as Markdown, without frontmatter. Obi's prompt and Guide.md both use it. */
export const GUIDE_BODY = [
  '# Mesa guide',
  ...[...GUIDE_SECTIONS, AGENT_NEEDS, GRAPH_AND_SEARCH, HELP_AND_FEEDBACK].map(
    (section) => `## ${section.title}\n\n${section.body}`,
  ),
].join('\n\n');

/** Creates Mesa/Guide.md, or refreshes it when the guide version changed. Other content is never kept. */
export async function syncGuideNote(store: Store, root: string): Promise<void> {
  const path = `${root}/Guide.md`;
  const frontmatter = { agenthq: 'guide', guideVersion: GUIDE_VERSION };
  const note = await store.loadNote(path);
  if (!note) {
    await store.createNote(path, frontmatter, GUIDE_BODY);
    return;
  }
  const saved = (note.frontmatter as Record<string, unknown> | null)
    ?.guideVersion;
  if (saved !== GUIDE_VERSION)
    await store.saveNote(path, frontmatter, GUIDE_BODY);
}
