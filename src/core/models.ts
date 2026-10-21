import { RUNTIME_OPTIONS } from './runtimes/ids';

/** Sentinel select value that reveals the free-text model field. */
export const OTHER_MODEL = '__other__';

export interface ModelChoice {
  value: string;
  label: string;
}

/** Claude Code aliases, confirmed against the installed CLI's --model help (no paid call). */
const CLAUDE_MODELS: ModelChoice[] = [
  { value: '', label: 'Default (runtime default)' },
  { value: 'haiku', label: 'Haiku: fastest, cheapest' },
  { value: 'sonnet', label: 'Sonnet: balanced' },
  { value: 'opus', label: 'Opus: most capable' },
];

/**
 * Models offered for a runtime. Claude Code has fixed aliases. OpenCode and Codex add the
 * list read from their own CLI (see runtimes/modelLists.ts); Hermes has none, so Default only.
 */
export function modelChoices(
  runtime: string,
  loaded: ModelChoice[] = [],
): ModelChoice[] {
  if (runtime === 'claude-code') return CLAUDE_MODELS;
  return [{ value: '', label: 'Default' }, ...loaded];
}

/** Select options: the runtime's list, a "Custom" entry keeping an unlisted saved value, then Other. */
export function modelSelectOptions(
  runtime: string,
  saved: string,
  loaded: ModelChoice[] = [],
): ModelChoice[] {
  const listed = modelChoices(runtime, loaded);
  const custom =
    saved !== '' && !listed.some((choice) => choice.value === saved)
      ? [{ value: saved, label: `Custom: ${saved}` }]
      : [];
  return [
    ...listed,
    ...custom,
    { value: OTHER_MODEL, label: 'Other… (type a model name)' },
  ];
}

/** The short model name for the chat label: "Haiku" for "Haiku: fastest, cheapest", "default" when empty. */
export function modelShortLabel(
  runtime: string,
  model: string,
  loaded: ModelChoice[] = [],
): string {
  if (model === '') return 'default';
  const choice = modelChoices(runtime, loaded).find(
    (entry) => entry.value === model,
  );
  return choice ? (choice.label.split(':')[0]?.trim() ?? choice.label) : model;
}

/** "Claude Code · Haiku", "Codex · default": the runtime and model an agent uses. */
export function runtimeModelLabel(
  runtime: string,
  model: string,
  loaded: ModelChoice[] = [],
): string {
  return `${RUNTIME_OPTIONS.find((option) => option.id === runtime)?.label ?? runtime} · ${modelShortLabel(runtime, model, loaded)}`;
}

/** Lines of `opencode models` are provider/model ids; ids marked free are labelled so the owner can see them. */
export function parseOpenCodeModels(stdout: string): ModelChoice[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[\w.-]+\/\S+$/.test(line))
    .map((id) => ({
      value: id,
      label: /free/i.test(id) ? `${id} (free)` : id,
    }));
}

/** Only the models marked free, for places that should suggest nothing that costs money. */
export function freeModels(list: ModelChoice[]): ModelChoice[] {
  return list.filter((choice) => choice.label.endsWith('(free)'));
}

/** `codex debug models` renders the local model catalog as JSON; only models listed for users are offered. */
export function parseCodexModels(json: string): ModelChoice[] {
  let catalog: unknown;
  try {
    catalog = JSON.parse(json);
  } catch {
    return [];
  }
  const models =
    catalog !== null && typeof catalog === 'object' && 'models' in catalog
      ? catalog.models
      : undefined;
  if (!Array.isArray(models)) return [];
  return models.flatMap((entry: unknown) => {
    if (entry === null || typeof entry !== 'object') return [];
    const {
      slug,
      visibility,
      display_name: name,
    } = entry as Record<string, unknown>;
    if (typeof slug !== 'string' || visibility !== 'list') return [];
    return [
      {
        value: slug,
        label: typeof name === 'string' ? `${name} (${slug})` : slug,
      },
    ];
  });
}
