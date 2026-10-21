/**
 * The version rule for CLIs Mesa has a sandbox policy for. The verified version is the one the policy was
 * written and tested against. Older versions are blocked. A newer version must pass the free self-test
 * (runtimes/selfTest.ts) once before it is allowed.
 */
export const VERIFIED_VERSIONS = {
  codex: '0.160.0',
  opencode: '1.19.1',
} as const;

export type VersionVerdict = 'verified' | 'newer' | 'older' | 'unknown';

/** The first x.y.z in a version line such as "codex-cli 0.163.0", or undefined. */
export function parseVersion(text: string): string | undefined {
  return /(\d+)\.(\d+)\.(\d+)/.exec(text)?.[0];
}

/** Negative, zero or positive, comparing dotted numbers part by part. */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Compares a reported version line with the verified one for the same tool. */
export function versionVerdict(
  reported: string,
  verified: string,
): VersionVerdict {
  const found = parseVersion(reported);
  if (!found) return 'unknown';
  const order = compareVersions(found, verified);
  if (order === 0) return 'verified';
  return order > 0 ? 'newer' : 'older';
}
