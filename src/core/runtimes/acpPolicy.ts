import { realpath } from 'node:fs/promises';
import { win32, posix } from 'node:path';
import { pathWithin } from '../workdir';
import type { RunRequest } from './types';
export const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
export async function canonicalFile(path: string): Promise<string> {
  const api = /^[a-z]:[\\/]/i.test(path) ? win32 : posix;
  const parts: string[] = [];
  let cursor = path;
  for (;;) {
    try {
      return api.join(await realpath(cursor), ...parts).replace(/\\/g, '/');
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== 'ENOENT' ||
        api.dirname(cursor) === cursor
      )
        throw error;
      parts.unshift(api.basename(cursor));
      cursor = api.dirname(cursor);
    }
  }
}
export async function approveAcpEdit(
  request: RunRequest,
  value: unknown,
  canonical = canonicalFile,
): Promise<boolean> {
  try {
    if (request.permission !== 'edit' || !request.protectedPaths?.length)
      return false;
    const call = record(value),
      raw = record(call.rawInput),
      args = record(raw.arguments);
    if (
      call.kind !== 'edit' ||
      !['write_file', 'patch'].includes(String(raw.tool)) ||
      (raw.tool === 'patch' &&
        args.mode !== undefined &&
        args.mode !== 'replace') ||
      typeof args.path !== 'string'
    )
      return false;
    const api = /^[a-z]:[\\/]/i.test(request.cwd) ? win32 : posix;
    const safe = (path: string) =>
      ![...path].some(
        (character) =>
          character.charCodeAt(0) < 32 || '*?{}[],~$%'.includes(character),
      ) &&
      !path.startsWith('\\\\') &&
      !path.startsWith('//') &&
      (!/^[a-z]:/i.test(request.cwd) ||
        !path
          .split(/[\\/]/)
          .some(
            (p, i) =>
              /[. ]$/.test(p) ||
              (p.includes(':') && !(i === 0 && /^[a-z]:$/i.test(p))),
          ));
    if (!safe(args.path) || (api === posix && /^[a-z]:/i.test(args.path)))
      return false;
    const lexical = api.resolve(request.cwd, args.path).replace(/\\/g, '/');
    const comparable = (path: string) =>
      api === win32 ? path.toLowerCase() : path;
    const target = await canonical(lexical);
    const diffs = Array.isArray(call.content)
      ? call.content.map(record).filter((item) => item.type === 'diff')
      : [];
    if (
      !diffs.length ||
      diffs.some(
        (item) =>
          typeof item.path !== 'string' ||
          comparable(
            api.resolve(request.cwd, item.path).replace(/\\/g, '/'),
          ) !== comparable(lexical),
      )
    )
      return false;
    if (
      Array.isArray(call.locations) &&
      call.locations.some((item) => {
        const path = record(item).path;
        // The same file may be written with \ or /; compare where they resolve to, as the diffs are compared.
        return (
          typeof path !== 'string' ||
          comparable(api.resolve(request.cwd, path).replace(/\\/g, '/')) !==
            comparable(lexical)
        );
      })
    )
      return false;
    if (
      request.protectedPaths.some(
        (path) => pathWithin(target, path) || pathWithin(lexical, path),
      )
    )
      return false;
    return (
      [request.cwd, ...(request.extraDirs ?? [])].some((path) =>
        pathWithin(target, path),
      ) &&
      [request.cwd, ...(request.extraDirs ?? [])].some((path) =>
        pathWithin(lexical, path),
      )
    );
  } catch {
    return false;
  }
}
