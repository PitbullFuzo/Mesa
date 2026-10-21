// React DOM 19 can create <script> elements at runtime to hoist `<script src>` resources. Mesa never renders a
// <script> or calls ReactDOM.preinit, so those three code paths are unreachable. Obsidian's store review flags the
// call, so the bundle refuses it with a clear error instead (see DECISIONS.md, Step 38b).

const CALL = 'createElement("script")';

/** React DOM's client build with every script-element creation replaced by a call that throws. */
export function refuseScriptElements(source) {
  if (!source.includes(CALL)) return source;
  return (
    source.split(CALL).join('createElement(mesaRefusesScriptElements())') +
    '\nfunction mesaRefusesScriptElements() {\n  throw new Error("Mesa does not create script elements.");\n}\n'
  );
}

/** True when the text still contains a script-element creation (used on the built main.js). */
export const createsScriptElements = (text) => text.includes(CALL);

/** An esbuild plugin applying the rewrite to React DOM's client build. */
export const noScriptElementsPlugin = {
  name: 'no-script-elements',
  setup(build) {
    build.onLoad(
      { filter: /react-dom[\\/]cjs[\\/]react-dom[a-z.-]*\.js$/ },
      async (args) => {
        const { readFile } = await import('node:fs/promises');
        return {
          contents: refuseScriptElements(await readFile(args.path, 'utf8')),
          loader: 'js',
        };
      },
    );
  },
};
