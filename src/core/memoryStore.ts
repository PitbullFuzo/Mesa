import {
  groupSchema,
  type Agent,
  type AgentCollection,
  type Group,
  type Skill,
} from './model';
import {
  frontmatterDescription,
  parseAgentNotes,
  type NoteDocument,
} from './notes';
import type { Store } from './store';
import {
  agentPatchToFrontmatter,
  newAgentNote,
  setupPatchSchema,
  type AgentSetupPatch,
} from './setup';
import { reparentAgent } from './orgchart';
import { managedPath } from './paths';

export class MemoryStore implements Store {
  public readonly notes = new Map<string, NoteDocument>();
  public readonly folders = new Set<string>();
  public readonly texts = new Map<string, string>();

  constructor(readonly root = 'Obi-I') {
    managedPath(root, root);
  }

  private async agentNote(id: string): Promise<NoteDocument> {
    const agent = (await this.loadAgents()).agents.find(
      (entry) => entry.id === id,
    );
    if (!agent) throw new Error(`Unknown agent: ${id}`);
    managedPath(this.root, agent.path);
    return this.notes.get(agent.path)!;
  }

  private wikiLink(path: string): string {
    const target = this.notes.get(path);
    if (!target) throw new Error(`Missing linked note: ${path}`);
    const unique =
      [...this.notes.values()].filter((note) => note.name === target.name)
        .length === 1;
    return `[[${unique ? target.name : target.path.replace(/\.md$/, '')}]]`;
  }

  async patchAgent(id: string, input: AgentSetupPatch): Promise<void> {
    const patch = setupPatchSchema.parse(input);
    const note = await this.agentNote(id);
    const { agents } = await this.loadAgents();
    const fields = agentPatchToFrontmatter(
      patch,
      (targetId) => {
        const agent = agents.find((entry) => entry.id === targetId);
        if (!agent) throw new Error(`Unknown agent reference: ${targetId}`);
        return this.wikiLink(agent.path);
      },
      (path) => this.wikiLink(path),
    );
    if (patch.name !== undefined && patch.name !== note.name) {
      const oldPath = note.path;
      const newPath = managedPath(
        this.root,
        `${oldPath.slice(0, oldPath.lastIndexOf('/'))}/${patch.name}.md`,
      );
      if (
        [...this.notes.keys(), ...this.folders].some(
          (path) =>
            path.toLowerCase() === newPath.toLowerCase() && path !== oldPath,
        )
      )
        throw new Error(`Path already exists: ${newPath}`);
      // Match resolved targets before renaming; preserve aliases and heading fragments.
      const rewrite = (value: unknown): unknown => {
        if (typeof value === 'string')
          return value.replace(
            /\[\[([^\]#|]+)((?:#[^\]|]*)?(?:\|[^\]]*)?)\]\]/g,
            (whole: string, target: string, suffix: string) => {
              const matches = [...this.notes.values()].filter(
                (entry) =>
                  entry.path === target ||
                  entry.path.replace(/\.md$/, '') === target ||
                  entry.name === target,
              );
              if (matches.length !== 1 || matches[0]?.path !== oldPath)
                return whole;
              const replacement = target.includes('/')
                ? newPath.replace(/\.md$/, '')
                : patch.name!;
              return `[[${replacement}${suffix}]]`;
            },
          );
        if (Array.isArray(value)) return value.map(rewrite);
        if (value && typeof value === 'object')
          return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [key, rewrite(item)]),
          );
        return value;
      };
      const rewritten = [...this.notes.values()].map((entry) => ({
        entry,
        frontmatter: rewrite(entry.frontmatter),
        body: rewrite(entry.body) as string,
      }));
      for (const update of rewritten) {
        update.entry.frontmatter = update.frontmatter;
        update.entry.body = update.body;
      }
      // New patch links may also point to the renamed agent itself.
      Object.assign(fields, rewrite(fields));
      this.notes.delete(oldPath);
      note.path = newPath;
      note.name = patch.name;
      this.notes.set(newPath, note);
    }
    Object.assign(
      note.frontmatter as Record<string, unknown>,
      structuredClone(fields),
    );
    if (patch.instructions !== undefined) note.body = patch.instructions;
  }

  async createAgent(name: string): Promise<string> {
    const note = await newAgentNote(
      this.root,
      name,
      this.folderNotes('Agents'),
      (path) =>
        Promise.resolve(
          [...this.notes.keys(), ...this.folders].some(
            (existing) => existing.toLowerCase() === path.toLowerCase(),
          ),
        ),
    );
    this.folders.add(this.root);
    this.folders.add(`${this.root}/Agents`);
    await this.createNote(
      note.path,
      note.frontmatter as Record<string, unknown>,
      note.body,
    );
    return (note.frontmatter as { id: string }).id;
  }

  async setManager(id: string, managerId: string | null): Promise<void> {
    const { agents } = await this.loadAgents();
    reparentAgent(agents, id, managerId);
    const note = await this.agentNote(id);
    const target = agents.find((agent) => agent.id === managerId);
    (note.frontmatter as Record<string, unknown>).reportsTo = target
      ? this.wikiLink(target.path)
      : null;
  }

  async deleteAgent(id: string): Promise<void> {
    const note = await this.agentNote(id);
    const { agents } = await this.loadAgents();
    const parent =
      (note.frontmatter as Record<string, unknown>).reportsTo ?? null;
    for (const report of agents.filter((agent) => agent.reportsTo === id)) {
      const child = this.notes.get(report.path)!;
      (child.frontmatter as Record<string, unknown>).reportsTo =
        structuredClone(parent);
    }
    this.notes.delete(note.path);
  }

  async exists(path: string): Promise<boolean> {
    return this.notes.has(path) || this.folders.has(path);
  }

  async createFolder(path: string): Promise<void> {
    if (await this.exists(path))
      throw new Error(`Path already exists: ${path}`);
    this.folders.add(path);
  }

  async createNote(
    path: string,
    frontmatter: Record<string, unknown>,
    body: string,
  ): Promise<void> {
    if (await this.exists(path))
      throw new Error(`Path already exists: ${path}`);
    await this.saveNote(path, frontmatter, body);
  }

  async readText(path: string): Promise<string | null> {
    return this.texts.get(managedPath(this.root, path)) ?? null;
  }

  async writeText(path: string, text: string): Promise<void> {
    this.texts.set(managedPath(this.root, path), text);
  }

  async renameNote(path: string, newPath: string): Promise<void> {
    managedPath(this.root, path);
    managedPath(this.root, newPath);
    const note = this.notes.get(path);
    if (!note) throw new Error(`Missing note: ${path}`);
    if (await this.exists(newPath))
      throw new Error(`Path already exists: ${newPath}`);
    this.notes.delete(path);
    note.path = newPath;
    note.name = newPath.split('/').pop()!.replace(/\.md$/, '');
    this.notes.set(newPath, note);
  }

  async saveNote(
    path: string,
    frontmatter: Record<string, unknown>,
    body: string,
  ): Promise<void> {
    const name = path.split('/').pop()?.replace(/\.md$/, '') ?? path;
    this.notes.set(path, {
      path,
      name,
      frontmatter: structuredClone(frontmatter),
      body,
    });
  }

  async loadAgents(): Promise<AgentCollection> {
    return parseAgentNotes(
      structuredClone(
        [...this.notes.values()].filter((note) =>
          note.path.startsWith(`${this.root}/Agents/`),
        ),
      ),
      (link) => {
        const direct = this.notes.get(link) ?? this.notes.get(`${link}.md`);
        if (direct) return direct.path;
        const matches = [...this.notes.values()].filter(
          (note) =>
            note.name === link || note.path === `${this.root}/${link}.md`,
        );
        return matches.length === 1 ? (matches[0]?.path ?? null) : null;
      },
    );
  }

  private layout: Record<string, { x: number; y: number }> = {};
  private pins: string[] = [];

  async saveAgent(agent: Agent): Promise<void> {
    const { agents } = await this.loadAgents();
    const reference = (id: string | null): string | null => {
      if (id === null) return null;
      const target = agents.find((candidate) => candidate.id === id);
      if (!target) throw new Error(`Unknown agent reference: ${id}`);
      const unique =
        [...this.notes.values()].filter((note) => note.name === target.name)
          .length === 1;
      return `[[${unique ? target.name : target.path.replace(/\.md$/, '')}]]`;
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
        model: agent.model,
        permission: agent.permission,
        workdir: agent.workdir,
        verifier: reference(agent.verifier),
        skills: agent.skills.map((path) => `[[${path.replace(/\.md$/, '')}]]`),
      },
      agent.instructions,
    );
  }

  async loadGroups(): Promise<Group[]> {
    const fm = this.notes.get(`${this.root}/Groups.md`)?.frontmatter;
    const parsed = groupSchema
      .array()
      .safeParse(
        typeof fm === 'object' && fm !== null && 'groups' in fm
          ? fm.groups
          : [],
      );
    return parsed.success ? parsed.data : [];
  }

  async saveGroups(groups: Group[]): Promise<void> {
    await this.saveNote(
      `${this.root}/Groups.md`,
      { agenthq: 'groups', groups },
      '',
    );
  }

  async loadSkills(): Promise<Skill[]> {
    return this.folderNotes('Skills').map(
      ({ path, name, body, frontmatter }) => ({
        path,
        name,
        body,
        description: frontmatterDescription(frontmatter),
      }),
    );
  }

  async loadLayout(): Promise<Record<string, { x: number; y: number }>> {
    return structuredClone(this.layout);
  }

  async saveLayout(
    layout: Record<string, { x: number; y: number }>,
  ): Promise<void> {
    this.layout = structuredClone(layout);
  }

  async loadPins(): Promise<string[]> {
    return [...this.pins];
  }

  async savePins(pins: string[]): Promise<void> {
    this.pins = [...pins];
  }

  private folderNotes(folder: string): NoteDocument[] {
    return structuredClone(
      [...this.notes.values()].filter((note) =>
        note.path.startsWith(`${this.root}/${folder}/`),
      ),
    );
  }

  async loadProjects(): Promise<NoteDocument[]> {
    return this.folderNotes('Projects');
  }

  async loadChats(): Promise<NoteDocument[]> {
    return this.folderNotes('Chats');
  }

  loadNote(path: string): Promise<NoteDocument | null> {
    const note = this.notes.get(path);
    return Promise.resolve(note ? structuredClone(note) : null);
  }
  loadNotesUnder(folder: string): Promise<NoteDocument[]> {
    return Promise.resolve(
      structuredClone(
        [...this.notes.values()].filter((note) =>
          note.path.startsWith(`${folder}/`),
        ),
      ),
    );
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
    this.notes.delete(path);
  }
  async loadTasks(): Promise<NoteDocument[]> {
    return this.folderNotes('Tasks');
  }
  async loadActivity(): Promise<NoteDocument[]> {
    return this.folderNotes('Activity');
  }
}
