import type { ChatService } from './chat';
import type { Store } from './store';
import { managedPath } from './paths';

export async function askAboutNote(
  chat: Pick<ChatService, 'newConversation' | 'send'>,
  agentId: string,
  path: string,
  content: string,
): Promise<void> {
  await chat.newConversation(agentId);
  await chat.send(
    agentId,
    `Please help me with this note.\n\nNote path: ${path}\n\nNote contents:\n${content}`,
  );
}

export interface ImportedSkill {
  name: string;
  body: string;
}
export async function importSkills(
  store: Store,
  root: string,
  skills: ImportedSkill[],
) {
  const folder = managedPath(root, `${root}/Skills`);
  if (!(await store.exists(folder))) await store.createFolder(folder);
  const used = new Set(
    (await store.loadSkills()).map((skill) => skill.path.toLowerCase()),
  );
  const imported: string[] = [];
  const skipped: { name: string; reason: string }[] = [];
  for (const skill of skills) {
    if (
      !skill.name.trim() ||
      /[<>:"/\\|?*#^[\]]/.test(skill.name) ||
      [...skill.name].some((character) => character.charCodeAt(0) < 32) ||
      /[. ]$/.test(skill.name)
    ) {
      skipped.push({ name: skill.name, reason: 'Unsafe note name' });
      continue;
    }
    const path = managedPath(root, `${folder}/${skill.name}.md`);
    if (used.has(path.toLowerCase()) || (await store.exists(path))) {
      skipped.push({
        name: skill.name,
        reason: 'Already exists; kept unchanged',
      });
      continue;
    }
    try {
      await store.createNote(path, {}, skill.body);
      used.add(path.toLowerCase());
      imported.push(path);
    } catch (error) {
      skipped.push({
        name: skill.name,
        reason:
          error instanceof Error ? error.message : 'Could not import skill',
      });
    }
  }
  return { imported, skipped };
}
