import {
  TFile,
  TFolder,
  Vault,
  getFrontMatterInfo,
  parseYaml,
  stringifyYaml,
  type App,
} from 'obsidian';
import { z } from 'zod';
import {
  groupSchema,
  type Agent,
  type AgentCollection,
  type Group,
  type Skill,
} from '../core/model';
import {
  frontmatterDescription,
  parseAgentNotes,
  type NoteDocument,
} from '../core/notes';
import { managedPath, vaultRoot } from '../core/paths';
import type { Store } from '../core/store';
import {
  agentPatchToFrontmatter,
  newAgentNote,
  setupPatchSchema,
  type AgentSetupPatch,
} from '../core/setup';
import { reparentAgent } from '../core/orgchart';

type Layout = Record<string, { x: number; y: number }>;
interface PluginData {
  read(): Promise<unknown>;
  write(data: Record<string, unknown>): Promise<void>;
}

const layoutSchema = z.record(
  z.string(),
  z.object({ x: z.number(), y: z.number() }),
);
const pinsSchema = z.array(z.string());
const pluginDataSchema = z.record(z.string(), z.unknown());

/** The only persistent note implementation: all note I/O uses the Vault API. */
export class ObsidianStore implements Store {
  readonly root: string;

  constructor(
    private readonly app: App,
    root: string,
    private readonly pluginData: PluginData,
  ) {
    this.root = vaultRoot(root, app.vault.configDir);
  }

  exists(path: string): Promise<boolean> {
    return Promise.resolve(
      this.app.vault.getAbstractFileByPath(managedPath(this.root, path)) !==
        null,
    );
  }

  async createFolder(path: string): Promise<void> {
    const target = managedPath(this.root, path);
    let current = '';
    for (const part of target.split('/')) {
      current = current ? `${current}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (!existing) await this.app.vault.createFolder(current);
      else if (!(existing instanceof TFolder))
        throw new Error(`A file blocks the folder ${current}.`);
    }
  }

  async createNote(
    path: string,
    frontmatter: Record<string, unknown>,
    body: string,
  ): Promise<void> {
    const target = this.notePath(path);
    if (this.app.vault.getAbstractFileByPath(target))
      throw new Error(`The note already exists: ${target}`);
    await this.app.vault.create(
      target,
      `---\n${stringifyYaml(frontmatter)}---\n${body}`,
    );
  }

  async renameNote(path: string, newPath: string): Promise<void> {
    const file = this.app.vault.getFileByPath(this.notePath(path));
    if (!file) throw new Error(`Missing note: ${path}`);
    const target = this.notePath(newPath);
    if (this.app.vault.getAbstractFileByPath(target))
      throw new Error(`The note already exists: ${target}`);
    await this.app.fileManager.renameFile(file, target);
  }

  async readText(path: string): Promise<string | null> {
    const file = this.app.vault.getFileByPath(managedPath(this.root, path));
    return file ? this.app.vault.read(file) : null;
  }

  /** Writes a plugin file that is not a note. Only the kept graph AI results use it; agents never edit them. */
  async writeText(path: string, text: string): Promise<void> {
    const target = managedPath(this.root, path);
    const file = this.app.vault.getFileByPath(target);
    if (file) await this.app.vault.process(file, () => text);
    else await this.app.vault.create(target, text);
  }

  async saveNote(
    path: string,
    frontmatter: Record<string, unknown>,
    body: string,
  ): Promise<void> {
    const target = this.notePath(path);
    const existing = this.app.vault.getAbstractFileByPath(target);
    if (!existing) {
      await this.createNote(target, frontmatter, body);
      return;
    }
    if (!(existing instanceof TFile))
      throw new Error(`The note path is a folder: ${target}`);
    await this.app.fileManager.processFrontMatter(
      existing,
      (data: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(frontmatter))
          data[key] = value;
      },
    );
    await this.app.vault.process(existing, (content) => {
      const info = getFrontMatterInfo(content);
      return `${content.slice(0, info.contentStart)}${body}`;
    });
  }

  async loadAgents(): Promise<AgentCollection> {
    const notes: NoteDocument[] = [];
    const invalidAgents: AgentCollection['invalidAgents'] = [];
    for (const file of this.filesIn('Agents')) {
      try {
        notes.push(await this.readNote(file));
      } catch (error) {
        invalidAgents.push({
          path: file.path,
          name: file.basename,
          reason:
            error instanceof Error
              ? error.message
              : 'Cannot read agent frontmatter.',
        });
      }
    }
    const result = parseAgentNotes(
      notes,
      (link, sourcePath) =>
        this.app.metadataCache.getFirstLinkpathDest(link, sourcePath)?.path ??
        null,
    );
    return {
      agents: result.agents,
      invalidAgents: [...result.invalidAgents, ...invalidAgents],
    };
  }

  async saveAgent(agent: Agent): Promise<void> {
    const { agents } = await this.loadAgents();
    const wikiLink = (path: string): string => {
      const file = this.app.vault.getFileByPath(path);
      if (!file) throw new Error(`Missing linked note: ${path}`);
      return `[[${this.app.metadataCache.fileToLinktext(file, agent.path, true)}]]`;
    };
    const reference = (id: string | null): string | null => {
      if (!id) return null;
      const target = agents.find((entry) => entry.id === id);
      if (!target) throw new Error(`Unknown agent reference: ${id}`);
      return wikiLink(target.path);
    };
    await this.saveNote(
      agent.path,
      {
        agenthq: 'agent',
        id: agent.id,
        role: agent.role,
        reportsTo: reference(agent.reportsTo),
        group: agent.group,
        runtime: agent.runtime,
        model: agent.model || null,
        permission: agent.permission,
        workdir: agent.workdir || null,
        verifier: reference(agent.verifier),
        skills: agent.skills.map(wikiLink),
      },
      agent.instructions,
    );
  }

  private agentFile(agents: Agent[], id: string): TFile {
    const agent = agents.find((entry) => entry.id === id);
    if (!agent) throw new Error(`Unknown agent: ${id}`);
    const file = this.app.vault.getFileByPath(this.notePath(agent.path));
    if (!file) throw new Error(`Missing agent note: ${agent.path}`);
    return file;
  }

  private wikiLink(file: TFile, source: TFile): string {
    return `[[${this.app.metadataCache.fileToLinktext(file, source.path, true)}]]`;
  }

  async patchAgent(id: string, input: AgentSetupPatch): Promise<void> {
    const patch = setupPatchSchema.parse(input);
    const { agents } = await this.loadAgents();
    const file = this.agentFile(agents, id);
    const agentLink = (targetId: string): string =>
      this.wikiLink(
        targetId === id ? file : this.agentFile(agents, targetId),
        file,
      );
    const skillLink = (path: string): string => {
      const skill = this.app.vault.getFileByPath(path);
      if (!skill) throw new Error(`Missing linked note: ${path}`);
      return this.wikiLink(skill, file);
    };
    // Validate new references before renaming; unrelated broken references are never read.
    agentPatchToFrontmatter(patch, agentLink, skillLink);
    if (patch.name !== undefined && patch.name !== file.basename) {
      const target = this.notePath(
        `${file.path.slice(0, file.path.lastIndexOf('/'))}/${patch.name}.md`,
      );
      const existing = this.app.vault.getAbstractFileByPath(target);
      if (existing && existing !== file)
        throw new Error(`The note already exists: ${target}`);
      await this.app.fileManager.renameFile(file, target);
    }
    const fields = agentPatchToFrontmatter(patch, agentLink, skillLink);
    if (Object.keys(fields).length > 0) {
      await this.app.fileManager.processFrontMatter(
        file,
        (data: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(fields)) data[key] = value;
        },
      );
    }
    if (patch.instructions !== undefined) {
      await this.app.vault.process(file, (content) => {
        const info = getFrontMatterInfo(content);
        return `${content.slice(0, info.contentStart)}${patch.instructions}`;
      });
    }
  }

  async setManager(id: string, managerId: string | null): Promise<void> {
    const { agents } = await this.loadAgents();
    reparentAgent(agents, id, managerId);
    const file = this.agentFile(agents, id);
    const reportsTo =
      managerId === null
        ? null
        : this.wikiLink(this.agentFile(agents, managerId), file);
    await this.app.fileManager.processFrontMatter(
      file,
      (data: Record<string, unknown>) => {
        data.reportsTo = reportsTo;
      },
    );
  }

  async createAgent(name: string): Promise<string> {
    const notes: NoteDocument[] = [];
    for (const file of this.filesIn('Agents')) {
      try {
        notes.push(await this.readNote(file));
      } catch {
        // Unparseable notes still reserve their path through exists below.
      }
    }
    const note = await newAgentNote(this.root, name, notes, (path) =>
      this.exists(path),
    );
    await this.createFolder(`${this.root}/Agents`);
    await this.createNote(
      note.path,
      note.frontmatter as Record<string, unknown>,
      note.body,
    );
    return (note.frontmatter as { id: string }).id;
  }

  async deleteAgent(id: string): Promise<void> {
    const { agents } = await this.loadAgents();
    const file = this.agentFile(agents, id);
    const note = await this.readNote(file);
    // Keep the raw wikilink even when its destination is currently broken/missing.
    const reportsTo =
      (note.frontmatter as Record<string, unknown>).reportsTo ?? null;
    for (const report of agents.filter((agent) => agent.reportsTo === id)) {
      const child = this.agentFile(agents, report.id);
      await this.app.fileManager.processFrontMatter(
        child,
        (data: Record<string, unknown>) => {
          data.reportsTo = reportsTo;
        },
      );
    }
    // Caller owns confirmation. Trashing respects the user's Obsidian preference.
    await this.app.fileManager.trashFile(file);
  }

  async loadGroups(): Promise<Group[]> {
    const file = this.app.vault.getFileByPath(`${this.root}/Groups.md`);
    if (!file) return [];
    const note = await this.readNote(file);
    const result = z
      .object({ groups: z.array(groupSchema) })
      .safeParse(note.frontmatter);
    if (!result.success)
      throw new Error('Groups.md has invalid group frontmatter.');
    return result.data.groups;
  }

  async saveGroups(groups: Group[]): Promise<void> {
    await this.saveNote(
      `${this.root}/Groups.md`,
      { agenthq: 'groups', groups: z.array(groupSchema).parse(groups) },
      '# Groups\n',
    );
  }

  async loadSkills(): Promise<Skill[]> {
    const notes = await this.readFolder('Skills');
    return notes.map((note) => ({
      path: note.path,
      name: note.name,
      body: note.body,
      description: frontmatterDescription(note.frontmatter),
    }));
  }

  async loadLayout(): Promise<Layout> {
    const data = pluginDataSchema.safeParse(await this.pluginData.read());
    const result = layoutSchema.safeParse(
      data.success ? data.data.layout : undefined,
    );
    return result.success ? result.data : {};
  }

  async saveLayout(layout: Layout): Promise<void> {
    const data = pluginDataSchema.safeParse(await this.pluginData.read());
    await this.pluginData.write({
      ...(data.success ? data.data : {}),
      layout: layoutSchema.parse(layout),
    });
  }

  async loadPins(): Promise<string[]> {
    const data = pluginDataSchema.safeParse(await this.pluginData.read());
    const result = pinsSchema.safeParse(
      data.success ? data.data.pins : undefined,
    );
    return result.success ? result.data : [];
  }

  async savePins(pins: string[]): Promise<void> {
    const data = pluginDataSchema.safeParse(await this.pluginData.read());
    await this.pluginData.write({
      ...(data.success ? data.data : {}),
      pins: pinsSchema.parse(pins),
    });
  }

  async loadNote(path: string): Promise<NoteDocument | null> {
    const file = this.app.vault.getFileByPath(path);
    return file ? this.readNote(file) : null;
  }

  loadNotesUnder(folder: string): Promise<NoteDocument[]> {
    const files: TFile[] = [];
    const parent = this.app.vault.getFolderByPath(folder);
    if (parent)
      Vault.recurseChildren(parent, (file) => {
        if (file instanceof TFile && file.extension === 'md') files.push(file);
      });
    return Promise.all(files.map((file) => this.readNote(file)));
  }

  loadProjects(): Promise<NoteDocument[]> {
    return this.readFolder('Projects');
  }

  loadChats(): Promise<NoteDocument[]> {
    return this.readFolder('Chats');
  }

  async trashNote(path: string): Promise<void> {
    if (
      !path.startsWith(`${this.root}/Chats/`) &&
      !path.startsWith(`${this.root}/Projects/`) &&
      !path.startsWith(`${this.root}/Schedules/`) &&
      !path.startsWith(`${this.root}/Skills/`)
    )
      throw new Error(
        'Only chat, project, schedule and skill notes can be trashed here.',
      );
    const file = this.app.vault.getFileByPath(path);
    // Caller owns confirmation. Trashing respects the user's Obsidian preference.
    if (file) await this.app.fileManager.trashFile(file);
  }
  loadTasks(): Promise<NoteDocument[]> {
    return this.readFolder('Tasks');
  }
  loadActivity(): Promise<NoteDocument[]> {
    return this.readFolder('Activity');
  }

  private notePath(path: string): string {
    const target = managedPath(this.root, path);
    if (!target.endsWith('.md'))
      throw new Error('Mesa notes must be Markdown files.');
    return target;
  }

  private filesIn(folder: string): TFile[] {
    const result: TFile[] = [];
    const parent = this.app.vault.getFolderByPath(`${this.root}/${folder}`);
    if (parent)
      Vault.recurseChildren(parent, (file) => {
        if (file instanceof TFile && file.extension === 'md') result.push(file);
      });
    return result.sort((a, b) => a.path.localeCompare(b.path));
  }

  private async readNote(file: TFile): Promise<NoteDocument> {
    const content = await this.app.vault.read(file);
    const info = getFrontMatterInfo(content);
    const frontmatter: unknown = info.exists ? parseYaml(info.frontmatter) : {};
    return {
      path: file.path,
      name: file.basename,
      frontmatter,
      body: content.slice(info.contentStart),
    };
  }

  private async readFolder(folder: string): Promise<NoteDocument[]> {
    return Promise.all(this.filesIn(folder).map((file) => this.readNote(file)));
  }
}
