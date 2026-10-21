/**
 * The helper programs (browser, Microsoft 365, Hermes bridge) are built into main.js in a release build, because a
 * release is only three files. At load the plugin writes any that are missing or different beside main.js.
 */
declare const __AGENTHQ_HELPERS__: Record<string, string> | undefined;

/** Name → text. Empty in development builds, which write the files themselves. */
export function embeddedHelpers(): Record<string, string> {
  return typeof __AGENTHQ_HELPERS__ === 'undefined' ? {} : __AGENTHQ_HELPERS__;
}

export interface HelperIo {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, text: string): Promise<void>;
}

/** Writes each helper that is missing or has different text; returns the names written. */
export async function installHelpers(
  files: Record<string, string>,
  dir: string,
  io: HelperIo,
): Promise<string[]> {
  const written: string[] = [];
  for (const [name, text] of Object.entries(files)) {
    const path = `${dir}/${name}`;
    if ((await io.exists(path)) && (await io.read(path)) === text) continue;
    await io.write(path, text);
    written.push(name);
  }
  return written;
}
