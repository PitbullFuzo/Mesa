export function bumpedFiles(
  version: string,
  files: { manifest: string; pkg: string; versions: string },
): { manifest: string; pkg: string; versions: string };
export function makeZip(entries: { name: string; data: Buffer }[]): Buffer;
