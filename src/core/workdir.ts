/* eslint obsidianmd/hardcoded-config-path: off -- Pure policy must protect the default directory as well as the supplied host configDir. */
import { protectedAgentHqPaths } from './protectedFolders';

export interface WorkdirOptions {
  agentId: string;
  workdir: string;
  vaultBasePath: string;
  managedRoot: string;
  configDir?: string;
  allowedFolders: string[];
  vaultAccess?: 'off' | 'read' | 'write';
  resolvePath?: (absolutePath: string) => Promise<string>;
}

function absolute(path: string, base: string): string {
  const value = path.replace(/\\/g, '/');
  if (/^[a-z]:(?:[^/]|$)/i.test(value) || /^\/\/[?.]\//.test(value))
    throw new Error(
      'Working folder uses an ambiguous or unsupported Windows path',
    );
  const joined = /^(?:[a-z]:\/|\/)/i.test(value) ? value : `${base}/${value}`;
  const windows = /^[a-z]:\//i.test(joined) || joined.startsWith('//');
  const parts = joined.replace(/\\/g, '/').split('/');
  if (
    windows &&
    parts.some(
      (part, index) =>
        part !== '.' &&
        part !== '..' &&
        (/[ .]$/.test(part) ||
          (part.includes(':') && !(index === 0 && /^[a-z]:$/i.test(part)))),
    )
  )
    throw new Error('Working folder uses an ambiguous Windows path');
  const prefix = joined.startsWith('//')
    ? '//'
    : joined.startsWith('/')
      ? '/'
      : '';
  const floor = /^[a-z]:\//i.test(joined) ? 1 : prefix === '//' ? 2 : 0;
  const segments: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (segments.length > floor) segments.pop();
    } else segments.push(part);
  }
  const normalized = prefix + segments.join('/');
  return /^[a-z]:$/i.test(normalized) ? `${normalized}/` : normalized;
}

export function pathWithin(path: string, folder: string): boolean {
  const windows = /^[a-z]:\//i.test(folder) || folder.startsWith('//');
  const clean = (value: string) => (windows ? value.toLowerCase() : value);
  const parent = clean(folder).replace(/\/$/, '');
  const child = clean(path);
  return child === parent || child.startsWith(`${parent}/`);
}

export async function resolveWorkdir(options: WorkdirOptions): Promise<{
  cwd: string;
  extraDirs: string[];
  readDirs: string[];
  protectedPaths: string[];
}> {
  const base = absolute(options.vaultBasePath, '');
  if (base.startsWith('//')) throw new Error('UNC vault paths are unsupported');
  const canonical = async (path: string) =>
    absolute(
      options.resolvePath ? await options.resolvePath(path) : path,
      base,
    );
  const canonicalBase = await canonical(base);
  if (canonicalBase.startsWith('//'))
    throw new Error('UNC vault paths are unsupported');
  const lexicalCwd = absolute(
    options.workdir || `${options.managedRoot}/Work/${options.agentId}`,
    base,
  );
  if (lexicalCwd.startsWith('//'))
    throw new Error('UNC working folders are unsupported');
  const cwd = await canonical(lexicalCwd);
  if (cwd.startsWith('//'))
    throw new Error('UNC working folders are unsupported');
  const extraDirs = await Promise.all(
    [
      `${options.managedRoot}/Work`,
      `${options.managedRoot}/Attachments`,
      ...(options.vaultAccess === 'write' ? [base] : []),
    ].map(async (folder) => {
      const resolved = await canonical(absolute(folder, base));
      if (resolved.startsWith('//'))
        throw new Error('UNC agent folders are unsupported');
      if (
        folder !== base &&
        (!pathWithin(resolved, canonicalBase) ||
          pathWithin(canonicalBase, resolved))
      )
        throw new Error(
          'Managed agent folder resolves outside its vault subfolder boundary; choose a vault-local managed root.',
        );
      return resolved;
    }),
  );
  const lexicalProtected = [
    // Core exception: Protect the default directory in addition to the host's configDir.
    '.obsidian',
    ...(options.configDir ? [options.configDir] : []),
    ...protectedAgentHqPaths(options.managedRoot),
  ].map((folder) => absolute(folder, base));
  const resolvedProtected = await Promise.all(lexicalProtected.map(canonical));
  const protectedPaths = [
    ...new Set([...lexicalProtected, ...resolvedProtected]),
  ];
  if (
    protectedPaths.some((folder) => pathWithin(cwd, folder)) ||
    lexicalProtected.some((folder) => pathWithin(lexicalCwd, folder))
  )
    throw new Error('Working folder is protected and cannot be used');
  for (const folder of options.allowedFolders.filter((entry) => entry.trim())) {
    const lexical = absolute(folder, base);
    if (lexical.startsWith('//'))
      throw new Error('UNC allowed folders are unsupported');
    const resolved = await canonical(lexical);
    if (resolved.startsWith('//'))
      throw new Error('UNC allowed folders are unsupported');
    if (pathWithin(base, lexical) || pathWithin(canonicalBase, resolved))
      throw new Error(
        'A listed folder contains the vault; list a narrower work area instead.',
      );
    if (
      protectedPaths.some(
        (protectedPath) =>
          pathWithin(protectedPath, lexical) ||
          pathWithin(protectedPath, resolved) ||
          pathWithin(lexical, protectedPath) ||
          pathWithin(resolved, protectedPath),
      )
    )
      throw new Error(
        'A listed folder contains or overlaps a protected folder; choose a narrower work area.',
      );
    extraDirs.unshift(resolved);
  }
  const writable = [...new Set(extraDirs)];
  if (!writable.some((folder) => pathWithin(cwd, folder)))
    throw new Error(
      'Working folder is outside allowed folders. Add it to folders agents may touch in Settings.',
    );
  return {
    cwd,
    extraDirs: writable,
    readDirs: options.vaultAccess === 'read' ? [canonicalBase] : [],
    protectedPaths,
  };
}
