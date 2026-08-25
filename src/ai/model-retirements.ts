/**
 * Retired model ids and where they went.
 *
 * A model id that a provider has sunset does not fail *nicely*: the id is simply
 * unknown at the API, so the call comes back as a 404 / "model not found" from deep
 * inside the adapter. That is a bad failure for jeo specifically, because model ids get
 * **pinned in three durable places** — `config.defaultModel`, per-role
 * `config.subagents.<role>.model`, and `config.roles.*` — and a pinned id keeps failing
 * every turn until the user works out which of the three is stale. The live catalog
 * refresh does not help: discovery only reports what still EXISTS, so a retired pin has
 * nothing to match against and silently stays broken.
 *
 * This table maps a retired id to its documented successor so the manager can (a) route
 * the call to something that works and (b) tell the user exactly which pin to update.
 * It is deliberately small and hand-curated: only ids jeo itself shipped in its catalog
 * or aliases, so nobody's config can be silently rewritten to a model they never chose.
 *
 * Rules for entries:
 *  - `replacement` MUST be a currently-catalogued id, and MUST stay on the SAME provider.
 *    Silently moving a user to a different vendor (different pricing, different data
 *    handling, different account) is not a substitution jeo gets to make on its own.
 *  - `note` is shown to the user once per session, so it should name the successor and
 *    read as an explanation, not a warning banner.
 */

export interface ModelRetirement {
  /** The retired id, exactly as it appeared in jeo's catalog/aliases. */
  readonly retired: string;
  /** Current catalog id that serves the same role on the SAME provider. */
  readonly replacement: string;
  /** One-line reason surfaced to the user. */
  readonly note: string;
}

export const MODEL_RETIREMENTS: readonly ModelRetirement[] = [
  {
    retired: "antigravity/gemini-3.1-pro-high",
    replacement: "antigravity/gemini-pro-agent",
    note: "Antigravity retired gemini-3.1-pro-high; gemini-pro-agent is its code-agent successor.",
  },
  {
    retired: "gemini-3.1-pro-high",
    replacement: "antigravity/gemini-pro-agent",
    note: "Antigravity retired gemini-3.1-pro-high; gemini-pro-agent is its code-agent successor.",
  },
] as const;

const BY_RETIRED = new Map(MODEL_RETIREMENTS.map(r => [r.retired.toLowerCase(), r]));

/** The retirement record for `model`, or undefined when the id is still current. */
export function findRetirement(model: string | undefined): ModelRetirement | undefined {
  const key = model?.trim().toLowerCase();
  return key ? BY_RETIRED.get(key) : undefined;
}

/** True when `model` names an id jeo knows has been sunset. */
export function isRetiredModel(model: string | undefined): boolean {
  return findRetirement(model) !== undefined;
}

/**
 * Map a possibly-retired id onto a working one.
 *
 * Returns the input unchanged when it is current, so this is safe to call on every
 * resolution path. Chains are followed (a successor that was itself later retired)
 * with a hard bound, so a malformed table can never spin here.
 */
export function resolveRetiredModel(model: string): { model: string; retirement?: ModelRetirement } {
  let current = model;
  let first: ModelRetirement | undefined;
  for (let hop = 0; hop < 4; hop++) {
    const hit = findRetirement(current);
    if (!hit) break;
    first ??= hit;
    if (hit.replacement.toLowerCase() === current.toLowerCase()) break; // self-reference guard
    current = hit.replacement;
  }
  return first ? { model: current, retirement: first } : { model };
}

/**
 * Which durable config pins still name a retired model, and what to change them to.
 * Used by `jeo doctor` and by the launch banner so the user is told *where* the stale
 * id lives rather than just that some call failed.
 */
export interface RetiredPin {
  /** Human-readable location, e.g. `defaultModel` or `subagents.executor.model`. */
  location: string;
  retired: string;
  replacement: string;
  note: string;
}

export function findRetiredPins(config: {
  defaultModel?: string;
  roles?: Record<string, string | undefined>;
  subagents?: Record<string, { model?: string } | undefined>;
}): RetiredPin[] {
  const pins: RetiredPin[] = [];
  const add = (location: string, model: string | undefined) => {
    const hit = findRetirement(model);
    if (hit) pins.push({ location, retired: model!, replacement: hit.replacement, note: hit.note });
  };
  add("defaultModel", config.defaultModel);
  for (const [role, model] of Object.entries(config.roles ?? {})) add(`roles.${role}`, model);
  for (const [role, cfg] of Object.entries(config.subagents ?? {})) add(`subagents.${role}.model`, cfg?.model);
  return pins;
}

/** One-time-per-session dedupe so a retired pin explains itself once, not every turn. */
const announced = new Set<string>();

export function shouldAnnounceRetirement(retired: string): boolean {
  const key = retired.toLowerCase();
  if (announced.has(key)) return false;
  announced.add(key);
  return true;
}

/** Test hook — clears the per-session announce dedupe. */
export function resetRetirementAnnouncements(): void {
  announced.clear();
}
