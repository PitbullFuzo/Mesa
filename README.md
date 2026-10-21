# Mesa for Obsidian

🇵🇹 [Ler em português](README.pt.md)

## What is Mesa

Mesa runs AI agents inside Obsidian. Each agent is a note in the Mesa folder.
You talk to them in Chat, and they answer with the AI tool you installed (Claude Code,
Codex, OpenCode or Hermes), which uses your own account and plan. You can give an
agent a team with an editable org chart, Tasks, History, broadcasts and a reviewer
that checks its work.

Made by Marcio Vieira — guides, how-tos, downloads and feedback at [trabalhoia.com](https://trabalhoia.com).

## What you need

- Obsidian desktop, on Windows or Mac: https://obsidian.md
- At least one AI tool, installed and signed in. Claude Code (a Claude plan or an API key): https://code.claude.com/docs/en/setup . Codex CLI (a ChatGPT plan; version 0.160.0 or newer; a newer version is checked once by Mesa, then used): https://github.com/openai/codex . OpenCode (version 1.19.1 or newer, checked the same way): https://opencode.ai . Hermes: see the Hermes section below.
- Node.js, only for browser control: https://nodejs.org
- Python comes with Hermes; you do not install it yourself.
- Git is optional, for backups: https://git-scm.com
- No coding languages are needed to use Mesa itself.

## Install

The plugin's folder is called obi-i (its original ID); the plugin is Mesa.

This repository is private for now; releases come later.

**a) Community plugin store:** coming soon.

**b) Download from trabalhoia.com:** download the Mesa zip (it contains the three
files) from [trabalhoia.com](https://trabalhoia.com). Unzip it into
`.obsidian/plugins/obi-i/` inside your vault folder (create the folder), then follow the same steps
as the manual route below.

**c) BRAT:** install the BRAT community plugin, then add `PitbullFuzo/Mesa`
as a beta plugin. BRAT installs from GitHub releases, so this works once the
repository is public and has a release.

**d) Manual:** download `main.js`, `manifest.json` and `styles.css` from the latest
GitHub release into `.obsidian/plugins/obi-i/` inside your vault folder (create the folder). Then
open Obsidian → Settings → Community plugins and enable **Mesa**.

**e) Ask your AI to install it:** give your AI assistant (Claude Code, Codex or
similar) this link and it will follow the steps: [INSTALL.md](INSTALL.md).

## Help and feedback

How-tos and a feedback form are at [trabalhoia.com](https://trabalhoia.com). Bugs can
also be reported as GitHub issues once the repository is public.

## Chat extras

- **Context bar:** shows how much of the model's context the chat uses (a tip suggests a new chat or Fork above about 80%); "unknown" or tokens only when the runtime does not report the window.
- **Plan usage (Claude Code):** "5h 11% · week 42%" from the usage Claude Code itself reports in its output; click for the reset times. Mesa never reads your Claude sign-in.
- **📎 Attach current note:** adds the open note to your message, with a chip you can remove. Long notes are cut.
- **Slash commands:** type `/` for `/new`, `/compact`, `/fork`, `/skill Research summarise this` and `/project Website` and `/help`.

## Windows and macOS

- **Windows** is the tested platform.
- **macOS** is not yet tested on a real Mac. The code has macOS branches with unit
  tests only, so treat macOS as unverified.
- Claude Code is detected on PATH and in known Windows/macOS install locations. Codex
  is checked on PATH, the Windows desktop bin, Windows npm packages, `~/.local/bin`,
  `~/.npm-global/bin`, Homebrew and `/usr/local/bin`. OpenCode is checked in npm's
  Windows location, `~/.opencode/bin`, `~/.local/bin`, Homebrew and `/usr/local/bin`.
  Hermes is checked on PATH, `AppData/Local/hermes/bin`, its install venv and common
  macOS/home locations.
- If detection misses a tool, Settings → Mesa → Runtime path override accepts the
  full path to its program.

## Releases are built by GitHub Actions

Every release is built from its tag by the workflow in `.github/workflows/release.yml`, not on a developer's computer. The workflow checks that the tag equals the version in `manifest.json`, runs the tests, builds the plugin, signs `main.js`, `styles.css` and `manifest.json` with build provenance attestations (GitHub's proof of which source and workflow produced them), attaches them to a draft release and then publishes it. You can check a downloaded file with `gh attestation verify main.js --repo PitbullFuzo/Mesa`.

## Privacy & network

- **Mesa itself sends nothing to its author.** There is no telemetry, no analytics, no account and no update check.
- **AI tools talk to their own providers.** Claude Code, Codex, OpenCode and Hermes are separate programs on your computer. Mesa starts them
  with your message and the notes you allow; they send that to the provider you signed in with, under that provider's terms. Web access and
  browser control are off until you switch them on for an agent.
- **Microsoft 365 only when connected.** When you press Sign in under Settings → Connectors (with the app that comes with Mesa, or your own app registration if you paste its ID), Mesa contacts
  `login.microsoftonline.com` (sign-in) and `graph.microsoft.com` (mail, calendar, OneDrive), through Obsidian's `requestUrl`. Nothing is sent
  before you connect, and every send, delete or write waits for your Approve card.
- **Browser only when enabled.** The browser helper starts a browser on your computer only for an agent with Can use browser switched on.
- **The help link only when clicked.** "Open trabalhoia.com" opens your web browser; nothing is sent from Obsidian.
- **Files outside your vault.** Run folders with temporary files (including the Microsoft 365 sign-in while connected) are created in your
  system temp folder and removed when the run ends. The Microsoft sign-in is kept in a file outside the vault, not encrypted.
- **Helper files next to `main.js`.** When the plugin loads it writes `browser_mcp.cjs`, `m365_mcp.cjs` and `hermes_acp.py` into its own folder
  (`.obsidian/plugins/obi-i/` inside your vault folder) if they are missing or changed. They are small programs the AI tools run for browser control,
  Microsoft 365 and Hermes; they are built from this repository's source.
- **Why Mesa lists your vault files.** The vault map, the graph map, the vault overview, vault search and the organiser need the list of your notes and their links. It is read on your computer and kept in files in the Mesa folder; nothing about it is sent anywhere by Mesa. An agent sees it only when you give that agent vault access.
- **Agents run programs and edit files** only where Setup allows (see Safety above). Source code is open (MIT).

## Safety in plain words

- Note destinations (Settings) let an agent you tick write notes into specific folders of your vault (Meetings/, Research/, Wiki/, Permanent/ by default), and only those. Off for every agent until you tick it.
- Agents write only to their Work folder, plus the outside folders you tick for that agent in its Setup. Settings lists the folders you allow; an agent with none ticked has no outside folders.
- A project can have an Output folder for its finished work. Only that project’s runs may write there; drafts stay in Work.
- Settings can hide Mesa from search and the graph (Obsidian’s Excluded files). Show again undoes it.
- "Read & write vault" lets an agent change your notes. Turn it on only when you need it.
- Vault access together with web access could let a bad web page trick an agent into sending your notes out. Use web access only when you need it.
- Codex can read the whole computer, not only the vault.
- The browser uses a clean profile with no logins. It works with Claude Code, Hermes, OpenCode and Codex. For Codex it needs its own extra tick box, because Codex can also read files anywhere on this computer.
- "Reorganise vault" moves notes only after you review a plan and apply it. Moves update links, nothing is deleted, and "Undo last reorganisation" puts the files back. Back up first.
- Only notes (.md) are moved. Images and other files stay where they are.
- Run commands is off for every agent until you set it. Allow freely lets an agent run commands as you, with a warning and a tick box: Claude Code, OpenCode and Hermes get a command tool only then. Codex always runs its own commands, so for Codex Off keeps them inside its sandbox (only the folders you allow, no internet) and Allow freely removes the sandbox: no folder limits and internet on. Ask me each time (OpenCode and Hermes only) shows an Approve or Reject card in the agent’s chat for every command; nothing runs until you approve, nothing is remembered, and a scheduled or looping run waits and adds an Inbox item. Claude Code and Codex cannot hold a command for approval, so they have only Off and Allow freely.
- AI costs come from your own plans. Project cost limits help, but check your provider's dashboard.
- Back up your vault before you give agents write access or reorganise notes.

## Developer setup

Desktop-only plugin. Use Node.js 22.12+ and npm; Obsidian desktop 1.7.2+ is required.

```sh
npm install
npm run lint
npm run typecheck
npm test
npm run build
```

Build output: `main.js`, `manifest.json` and `styles.css` in `test-vault/.obsidian/plugins/obi-i/`, plus the helper files
(`hermes_acp.py`, `browser_mcp.cjs`, `m365_mcp.cjs`).

**Release:** `npm run version:bump 0.2.0` updates `manifest.json`, `package.json` and `versions.json` together;
`npm run package` then builds for production and writes `release/mesa-1.0.3.zip` (the number is the version) holding exactly `main.js`,
`manifest.json` and `styles.css`. In a production build the helper files are inside `main.js`, and the plugin writes them
beside it when it loads, so a three-file install is complete.
Open **only this repository's test-vault** for development; do not put experimental
builds in a personal vault. Enable community plugins and Mesa. **After every
code build, switch Mesa off/on in Community plugins (or restart Obsidian)**;
otherwise Obsidian keeps old JavaScript in memory. `npm run dev` watches source;
static-only asset changes require a build or watcher restart.

Install **Claude Code CLI** and sign in separately (`claude` in a terminal).
Mesa uses its existing account, not API keys entered in the plugin. Detection
checks PATH and known Windows/macOS locations. Chat shows install/sign-in guidance.
Settings → Mesa → Runtime path override accepts a native executable path;
edits are saved immediately and detection refreshes after typing pauses. Hermes,
OpenCode and Codex are also supported (below). macOS branches have unit
tests, not a complete real-Mac acceptance pass.

If the configured team folder is absent, startup creates CEO, Coder, Reviewer,
Core team, a licensed skill and Welcome. Existing folders are never overwritten.
Use the network ribbon to open AI Graph, click CEO and type in Chat. The default
team Work area is already allowed: no folder setup is needed for the first chat.
Real chats, summaries, delegated tasks and verifier attempts use the runtime
account and may cost money; finished replies show reported costs.

## Vault powers

- Right-click a Markdown note in the file explorer or inside its editor →
  **Ask an agent about this note…** → choose an agent. A fresh chat starts with
  the note path and full content; the previous conversation gets a best-effort
  summary. Cancelling the picker sends nothing. Note contents go to the selected
  AI provider; choose deliberately for private notes.
- Settings → Mesa → **Import my Claude skills** → Import skills copies immediate
  each skill's `SKILL.md` file under `~/.claude/skills/` into a note in `Mesa/Skills/`
  through the Vault API. The source is read-only. Existing notes, unsafe names,
  symlinks and unreadable/missing files are skipped; a Notice reports counts.
  Choose imported skills in agent Setup to use them. Import does not assign them.
- Read-only/edit agents can use WebSearch and WebFetch to search/read URLs. This
  is fetching pages, **not browser control**, and does not use your logged-in
  browser profile. Remote content, notes and skills may contain untrusted instructions.

## Browser control

Settings → Mesa → **Set up browser tools** asks permission for up to 500 MB
(typically 200–300 MB; existing cache is reused), then installs pinned Playwright
MCP 0.0.83 and Chromium outside the vault. Node.js with npm/npx must already be
installed. Only the Playwright MCP server is supplied to an opted-in Claude Code
run; no personal MCP configuration or `--chrome` integration is used.

In the agent's Setup, **Can use browser** defaults off. Save asks for separate
confirmation: browser actions can submit forms/change websites, and pages can
contain malicious instructions. Every run starts a fresh isolated browser context,
without your saved cookies/logins. Stop / Stop all and plugin unload terminate the
browser tree. Tool-level guards block host-side browser code, uploads, file URLs,
custom file output and workspace-root overrides. This is not a browser/network OS
sandbox: websites may still contact local network services; enable it only for
trusted agents and browse untrusted content cautiously.

Playwright is supported only for Claude Code with confined reads. Browser control
is refused for Codex, any whole-computer-read agent and unverified ACP runtimes.
The **Hermes browser** choice is visibly disabled: isolated backend/profile,
confined browser code and Stop cleanup cannot yet be guaranteed. Real-profile
helpers are never used. Web access controls search/fetch, not this separate browser
permission. Enabling whole-computer reads defaults Web access off; turning Web on
again displays an explicit whole-computer-plus-web warning.

Windows detection uses PATH/native Node plus home install locations; `.cmd` files
are never spawned as shell commands. macOS Finder launches also search
`/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, `~/.npm-global/bin` and
`~/.nvm/versions/node/*/bin` for Node/npm/npx; Hermes retains its existing macOS
native discovery. Browser caches: Windows `AppData/Local/ms-playwright`, macOS
`~/Library/Caches/ms-playwright`. No macOS permission prompts are expected; no real
Mac has been tested yet. Do not infer macOS acceptance from the fake-filesystem tests.

## Hermes runtime

Setup → Runtime → **Hermes** uses the installed Hermes ACP server through a bundled
policy bootstrap (`hermes_acp.py`, shipped beside main.js). Install Hermes with ACP
support and configure its provider in Hermes first; `hermes acp --check` verifies
that installation. Detection checks PATH, Windows `AppData/Local/hermes/bin` and
its install venv, plus common macOS/home locations. The existing Runtime path
override remains for Claude Code; it does not override Hermes.

In Model, use Hermes's ACP `provider:model` syntax, e.g.
`openrouter:google/gemini-2.5-flash-lite`. Empty uses your configured Hermes model.
Credentials are resolved by Hermes; Mesa never saves provider keys. Choose a
cheap model deliberately: your configured default may be expensive.

The subprocess policy uses only read/search, file edits and web search/extraction.
Shell, code execution, native delegation, browser, skills and MCP tools are disabled.
Every edit requires Mesa's approval: read-only denies all writes, edit accepts
only canonical allowed work folders and rejects config/Agents/Tasks/Activity/
Attachments. Unknown or multi-file opaque proposals fail closed; full is unavailable.
web_extract can fetch any URL; reads are confined to the agent's folders.
Resolved read/search paths must stay inside the session's explicit roots, including
after following symlinks; missing roots, traversal and UNC/device paths are refused.
This is tool-level confinement, not an OS sandbox. The bootstrap
fails closed if its required Hermes APIs are unavailable. It changes no installed
Hermes files, user configuration or credentials.

Chat streaming, tool activity, server-assigned session IDs, session reload, Stop and
mixed-team verification use the existing shared queue. ACP history replay is not
appended twice. Hermes's native usage update is context usage, not billing; the
bootstrap forwards per-turn **estimated** cost when the installed agent provides it.
Unknown cost is left unreported, not treated as free. The native runtime still keeps
its own ACP sessions in its configured Hermes profile.

### Per-agent Vault access and Web access

Setup saves `vaultAccess: off | read | write` and `webAccess: true | false` in each
agent note; old notes default to **off / true**. **Codex is the broad-read exception:**
Vault access does not limit Codex reads, and Codex Edit refuses broad vault-write roots.

- **Off:** only the agent's work folder, team Work/Attachments and allowed folders.
- **Read:** additionally read the vault, without new writable folders.
- **Write:** additionally edit vault notes when Permission is Edit; Save asks for
  confirmation. Configuration, Agents, Tasks, Activity and Attachments remain protected.
- **Web access off:** removes web-search/fetch tools entirely. With vault read/write
  and web enabled, Setup warns that a malicious page could try to leak your notes.

Vault access governs only the vault. Settings → **Folders agents may touch** may
also explicitly list absolute outside projects (for example `D:/project`); those
are readable/writable work areas subject to Permission. Unlisted outside folders
and UNC paths are refused. A listed folder containing the vault or overlapping a
protected folder is refused with an explanation, never silently clamped.
Claude uses restricted mode plus scoped Edit allow rules and dontAsk (all other
writes denied); read-only vault additions are never writable. Hermes and OpenCode
receive separate read roots; write approvals never use read-only additions.
These read boundaries do not apply to Codex after whole-computer-read confirmation.

## OpenCode runtime

Install the **OpenCode CLI 1.19.1** separately from the desktop app (`opencode-ai`).
Detection resolves Windows npm's `opencode.cmd` to the native
`node_modules/opencode-ai/bin/opencode.exe`, without a shell. It also checks
`~/.opencode/bin`, `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin`.
A CLI installed inside Hermes's private Node may need reinstalling after a Node
update. Other CLI versions fail closed until their policy is verified.

Setup → Runtime → **OpenCode**, then Model = `provider/model`. Empty uses
`opencode/nemotron-3.5-lightning-free`; the real release checks used
`opencode/mimo-v2.6-flash-free`. Free-provider availability/latency can vary.
Mesa isolates OpenCode's config, sessions and cache under
`AppData/Local/Mesa/opencode` (or `~/.local/share/Mesa/opencode` on macOS).
It does not reuse the desktop server or normal CLI login/config. Provider keys,
if needed, must come from the inherited environment, never plugin settings.
The tested OpenCode free models need no saved provider key.

The shared ACP adapter streams text/tools, persists server session IDs, resumes
without replaying duplicate messages and subtracts cumulative USD usage for each
reply. Stop kills the process tree. Read-only denies edits; Edit approves only
single-file changes in canonical writable roots and denies protected paths.
Every read needs a correlated tool path inside explicit read roots, including
nearby instruction-file symlink checks. Unknown/opaque proposals fail closed.
Shell, native subagents, custom tools, MCP, glob/grep, LSP, formatters, snapshots,
project instructions/config and automatic title generation are disabled.
**Web access enables search only**: native URL fetching is always disabled because
OpenCode's fetch cannot guarantee private-network/redirect confinement. Web off
also disables search. Full remains unavailable. This is a pinned tool policy,
not an OS sandbox; externally changing symlinks during a check remains a race.

## Codex runtime

Install **Codex CLI 0.160.0**, including its bundled Code Mode host, and run
`codex login` separately. Mesa uses that existing ChatGPT login, not keys in
plugin settings. Detection checks native PATH executables, the Windows desktop
bin, Windows npm native packages, `~/.local/bin`, `~/.npm-global/bin`, Homebrew
and `/usr/local/bin`. It never executes a `.cmd` through a shell. Other CLI
versions are unavailable until their policy is reviewed.

**Codex can read your whole computer.** Unlike Hermes/OpenCode, its native
Windows unelevated sandbox does not confine reads to allowed folders. A narrower
read profile requires the elevated Windows backend, which Mesa does not set
up or elevate. Every Codex agent is blocked until you tick **Allow whole-computer
reads** in Setup and confirm the separate warning. Consent defaults off, can be
revoked, and the agent panel keeps a visible warning. This is saved as
`wholeComputerReadConfirmed` in the agent note. Only enable it for trusted
instructions/providers; Vault Off does **not** protect notes from Codex reads.

Read-only prevents writes. Edit uses the OS `workspace-write` sandbox for the
working folder and explicit writable additions. Roots containing or overlapping
protected config/Agents/Tasks/Activity/Attachments are refused; protected
Attachments additions are never passed as writable. Therefore **Vault Write +
Edit is unavailable for Codex**: choose a narrower work area, not the vault root.
Full is unavailable. Windows allowed/denied writes were checked with the real
model and native no-inference probes; macOS has not had live acceptance testing.

The adapter uses `exec --json` with stdin prompts, no shared daemon, ignored user
config/rules, no automatic project instructions/skill block, no MCP/native
subagents/browser/plugins/hooks, and no shell network. Web access controls
Codex's hosted web search, not command networking. The bundled Code Mode host
must remain enabled for models advertising Code Mode-only tools; its V8 tool
calls delegate to the same sandbox. No personal runtime configuration is edited.

Choose a model supported by your ChatGPT plan in Setup. Checks used the available
low-cost **`gpt-5.6-luna`** with low reasoning; empty uses the native CLI default,
not the model in the ignored user config. Chat displays native message/tool events
(message-granular, not guaranteed token-by-token), preserves the server UUID for
resume, and stops the process tree. Codex keeps its own session files for resume;
Mesa never uses `--ephemeral`. Native Usage lines are **cumulative per thread**,
including cached tokens. Codex does not report a USD charge: missing cost is
unknown, never shown as a fabricated $0. Paid reviewers report their own cost.

## Images in chat

Paste an image or drop a PNG/JPEG/GIF/WebP file into Chat or the broadcast composer.
Each file (maximum 10 MiB) is saved with a unique name in `Mesa/Attachments/`.
A thumbnail appears before sending and in the chat; transcripts use ordinary
image embeds such as `![[photo.png]]`. Absolute Read-tool hints are inference-only: they do not appear
in your chat bubbles, chat notes or broadcast summary.
Attachments are always readable by agents but explicitly protected from edits,
even for edit agents. Remove detaches a draft image; it does not delete the saved
file. Unsent images are retained in the vault. Text-only messages still work as before.

## Where files live

Under the configured `Mesa/` folder: `Agents/` (instructions/frontmatter),
`Groups.md`, `Skills/`, `Chats/` (finished messages, sessions, summaries), `Tasks/`
(answers/attempts/verdicts), `Activity/YYYY-MM.md`, `Work/` (one folder per agent), `Attachments/`,
and `Welcome.md`.
Settings, stable-ID graph positions and Inbox state live in plugin `data.json`.
Task/activity links use Obsidian's link text; old notes are not rewritten.

Agent names are note filenames. Enable Obsidian's **Automatically update internal
links** preference (or accept its rename prompt); IDs, history and positions survive
renames. Changing the team-root setting requires a plugin reload.

Select through Team or graph. Setup writes changed fields only. Drag nodes/groups;
connect manager bottom → worker top; Fit adjusts the view. Broadcast targets everyone,
a group or one agent. Stop cancels related work; graph/command **Stop all** cancels
running and queued work. Tasks/History open their notes. Retry adds exactly two
attempts and resumes with feedback; Inbox resolutions persist across reload.

## Safety and limits

- Agents run only while Obsidian is open; Stop/unload terminate process trees.
  Interrupted requests do not auto-resume. Notes and Inbox are not one transaction.
- Read-only tools: Read/Glob/Grep/WebSearch/WebFetch. Edit adds Edit/Write. Full is
  unavailable. Native subagents and MCP are disabled. Codex alone uses shell/code
  execution through its native write sandbox, with broad reads explicitly confirmed.
- The vault configuration directory and team Agents/Tasks/Activity are protected
  from agent edits. Work is always allowed; add other trusted folders explicitly.
  Only explicitly listed outside projects are allowed; UNC and broad ancestors are refused. Keep backups of editable files.
- One global queue enforces parallel limits; request runs/depth and verifier attempts
  are bounded. Auth/workdir errors create linked Inbox records. AI verdicts are not
  proof of correctness. A cancelled run without a final cost event may have unknown cost.
- Hidden developer mode offers Fake for free tests and is off by default. Automated
  tests never call real AI.

Build setup follows the official [Obsidian sample plugin](https://github.com/obsidianmd/obsidian-sample-plugin)
(TypeScript/esbuild/CommonJS; Obsidian and Electron APIs external).

## Disclaimer

Mesa lets AI agents read and change files you allow. It is provided as-is, without warranty. We aren't responsible for data loss or AI costs. Please back up your vault before giving agents write access or reorganising notes.

## Licence

MIT. See [LICENSE](LICENSE).
