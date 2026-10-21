function relativePath(path: string): string {
  const normalized = path.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    normalized.includes(':') ||
    [...normalized].some((character) => character.charCodeAt(0) < 32) ||
    normalized.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error(
      'Obi-I paths must be non-empty vault-relative paths without traversal.',
    );
  }
  return normalized;
}

export function vaultRoot(folder: string, configDir: string): string {
  const root = relativePath(folder);
  const config = relativePath(configDir).toLowerCase();
  const comparison = root.toLowerCase();
  if (comparison === config || comparison.startsWith(`${config}/`)) {
    throw new Error(
      'The Obi-I folder cannot be inside the vault configuration directory.',
    );
  }
  return root;
}

export function managedPath(root: string, path: string): string {
  const normalized = relativePath(path);
  if (normalized !== root && !normalized.startsWith(`${root}/`)) {
    throw new Error('The note path must be inside the Obi-I folder.');
  }
  return normalized;
}
