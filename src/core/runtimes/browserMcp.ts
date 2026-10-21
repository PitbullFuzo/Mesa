import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { killProcessTree } from './processTree';
const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
const allowed = new Set([
  'browser_navigate',
  'browser_navigate_back',
  'browser_click',
  'browser_close',
  'browser_console_messages',
  'browser_handle_dialog',
  'browser_drag',
  'browser_evaluate',
  'browser_fill_form',
  'browser_hover',
  'browser_press_key',
  'browser_select_option',
  'browser_snapshot',
  'browser_take_screenshot',
  'browser_tabs',
  'browser_type',
  'browser_wait_for',
  'browser_resize',
]);
export function filterBrowserTools(tools: unknown[]): unknown[] {
  return tools.filter((t) => allowed.has(String(record(t).name)));
}
export function browserClientMessage(value: unknown): {
  forward?: Record<string, unknown>;
  error?: string;
} {
  const message = record(value),
    params = record(message.params);
  if (message.method === 'initialize')
    return { forward: { ...message, params: { ...params, capabilities: {} } } };
  if (message.method === 'tools/call') {
    if (!allowed.has(String(params.name)))
      return { error: 'Browser tool disabled by Obi-I policy.' };
    const args = { ...record(params.arguments) };
    delete args._meta;
    if (
      args.filename !== undefined ||
      args.fileName !== undefined ||
      args.path !== undefined ||
      args.paths !== undefined
    )
      return {
        error:
          'Browser files are disabled; automatic output stays in the private temporary workspace.',
      };
    if (args.url !== undefined) {
      try {
        if (
          typeof args.url !== 'string' ||
          !['http:', 'https:'].includes(new URL(args.url).protocol)
        )
          throw Error();
      } catch {
        return { error: 'Only http/https browser URLs are allowed.' };
      }
    }
    return { forward: { ...message, params: { ...params, arguments: args } } };
  }
  return { forward: message };
}
async function main() {
  const arg = (name: string) => {
    const i = process.argv.indexOf(name);
    if (i < 0 || !process.argv[i + 1])
      throw Error('Missing browser launch option');
    return process.argv[i + 1]!;
  };
  if (!process.argv.includes('--isolated'))
    throw Error('An isolated browser is required.');
  const server = arg('--server'),
    browser = arg('--browser'),
    runDir = arg('--run-dir'),
    cache = arg('--cache');
  const metadata = JSON.parse(
    await readFile(join(dirname(server), 'package.json'), 'utf8'),
  ) as { version?: string };
  if (metadata.version !== '0.0.83')
    throw Error('Unsupported Playwright MCP policy version.');
  const env: NodeJS.ProcessEnv = {};
  for (const k of [
    'PATH',
    'Path',
    'SystemRoot',
    'WINDIR',
    'HOME',
    'USERPROFILE',
    'LOCALAPPDATA',
    'APPDATA',
    'TMPDIR',
    'TEMP',
    'TMP',
  ])
    if (process.env[k]) env[k] = process.env[k];
  env.PLAYWRIGHT_BROWSERS_PATH = cache;
  const child = spawn(
    process.execPath,
    [
      server,
      '--isolated',
      '--no-webmcp',
      '--block-service-workers',
      '--executable-path',
      browser,
      '--output-dir',
      runDir,
      '--image-responses',
      'omit',
      '--codegen',
      'none',
    ],
    {
      cwd: runDir,
      shell: false,
      windowsHide: true,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let closed = false;
  let shutting: Promise<void> | undefined;
  const shutdown = () =>
    (shutting ??= (async () => {
      if (child.pid && !closed) {
        try {
          await killProcessTree(child.pid);
        } catch {
          if (!closed) process.exitCode = 1;
        }
      }
    })());
  child.stderr.pipe(process.stderr);
  const output = (v: unknown) => process.stdout.write(JSON.stringify(v) + '\n');
  const client = createInterface({ input: process.stdin });
  client.on('line', (line) => {
    try {
      if (line.length > 8 * 1024 * 1024) throw Error();
      const m = JSON.parse(line) as unknown;
      const result = browserClientMessage(m);
      if (result.error)
        output({
          jsonrpc: '2.0',
          id: record(m).id,
          result: {
            isError: true,
            content: [{ type: 'text', text: result.error }],
          },
        });
      else child.stdin.write(JSON.stringify(result.forward) + '\n');
    } catch {
      void shutdown();
    }
  });
  const backend = createInterface({ input: child.stdout });
  backend.on('line', (line) => {
    try {
      const m = record(JSON.parse(line));
      const result = record(m.result);
      if (Array.isArray(result.tools))
        m.result = { ...result, tools: filterBrowserTools(result.tools) };
      output(m);
    } catch {
      void shutdown();
    }
  });
  client.on('close', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
  child.on('error', () => {
    process.exitCode = 1;
    client.close();
  });
  child.once('close', () => {
    closed = true;
    client.close();
    process.stdin.destroy();
  });
  child.stdin.on('error', () => void shutdown());
  process.stdout.on('error', () => void shutdown());
}
if (process.argv.includes('--agenthq-browser'))
  void main().catch(() => {
    process.stderr.write(
      'Obi-I isolated browser could not start. Check browser setup.\n',
    );
    process.exitCode = 1;
  });
