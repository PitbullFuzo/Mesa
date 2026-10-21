# Install Mesa (instructions for an AI assistant)

> This repository is private for now; releases come later.

You are an AI assistant (Claude Code, Codex or similar). The user gave you this page so you
can install the Mesa Obsidian plugin for them. Follow these steps in order. Ask the user
whenever a step needs a decision.

1. **Ask which vault.** Ask the user for the full folder path of the Obsidian vault to install
   into. Never guess it. Never touch any other vault or folder.

2. **Download three files.** Download `main.js`, `manifest.json` and `styles.css` from the
   latest release of https://github.com/PitbullFuzo/Mesa (or the Mesa zip from
   https://trabalhoia.com, if the user gives you that link; it holds the same three files)
   into `.obsidian/plugins/mesa/` inside your vault folder. Create that folder if it is missing. Download
   nothing else. Do not run any downloaded file.

3. **Do not edit Obsidian's settings.** Do not edit `community-plugins.json`, the restricted
   mode setting, `app.json` or any other Obsidian settings file. Instead, tell the user:
   - Open Obsidian → Settings → Community plugins.
   - If Obsidian asks, turn off **Restricted mode**.
   - Turn on **Mesa** yourself.

4. **Check the setup.** Tell the user to press Ctrl+P (Cmd+P on Mac), run
   **"Mesa: Check my setup"**, and read which AI tools are ready. Then tell them to take
   **Obi's tour** inside Mesa.

5. **Recommend a backup.** Before the user gives any agent write access, tell them to back up
   the vault. Link the disclaimer: https://github.com/PitbullFuzo/Mesa#disclaimer
