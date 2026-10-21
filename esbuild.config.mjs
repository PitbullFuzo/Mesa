// Based on the official obsidianmd/obsidian-sample-plugin build setup.
import esbuild from 'esbuild';
import { builtinModules } from 'node:module';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { noScriptElementsPlugin } from './scripts/noScriptElements.mjs';

const prod = process.argv[2] === 'production';
const outdir = 'test-vault/.obsidian/plugins/obi-i';
await mkdir(outdir, { recursive: true });

// A release is only main.js, manifest.json and styles.css, so the helper programs travel inside main.js and the plugin
// writes them beside it when it loads (src/core/helpers.ts). Development builds write them to disk instead.
const helperBundle = async (entry) =>
  (
    await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node18',
      minify: true,
      write: false,
    })
  ).outputFiles[0].text;
const helpers = prod
  ? {
      'browser_mcp.cjs': await helperBundle('src/core/runtimes/browserMcp.ts'),
      'm365_mcp.cjs': await helperBundle('src/core/m365/mcpServer.ts'),
      'hermes_acp.py': await readFile(
        'src/core/runtimes/hermes_acp.py',
        'utf8',
      ),
    }
  : {};
const context = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: [
    'obsidian',
    'electron',
    ...builtinModules,
    ...builtinModules.map((name) => `node:${name}`),
  ],
  format: 'cjs',
  target: 'es2021',
  logLevel: 'info',
  sourcemap: prod ? false : 'inline',
  treeShaking: true,
  outfile: `${outdir}/main.js`,
  minify: prod,
  define: {
    'process.env.NODE_ENV': JSON.stringify(prod ? 'production' : 'development'),
    __AGENTHQ_HELPERS__: JSON.stringify(helpers),
  },
  plugins: [
    noScriptElementsPlugin,
    {
      name: 'copy-plugin-assets',
      setup(build) {
        build.onEnd(async (result) => {
          if (result.errors.length === 0) {
            await Promise.all([
              esbuild.build({
                entryPoints: ['src/core/runtimes/browserMcp.ts'],
                bundle: true,
                platform: 'node',
                format: 'cjs',
                target: 'node18',
                minify: prod,
                outfile: `${outdir}/browser_mcp.cjs`,
              }),
              esbuild.build({
                entryPoints: ['src/core/m365/mcpServer.ts'],
                bundle: true,
                platform: 'node',
                format: 'cjs',
                target: 'node18',
                minify: prod,
                outfile: `${outdir}/m365_mcp.cjs`,
              }),
              copyFile('manifest.json', `${outdir}/manifest.json`),
              copyFile(
                'src/core/runtimes/hermes_acp.py',
                `${outdir}/hermes_acp.py`,
              ),
              copyFile(`${outdir}/main.css`, `${outdir}/styles.css`),
            ]);
          }
        });
      },
    },
  ],
});
if (prod) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
