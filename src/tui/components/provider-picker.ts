/**
 * Provider picker — turns live provider readiness into a `SelectList` for the
 * TUI `/provider` and `jeo setup` flows. Ready providers are listed first and
 * the recommended choice is the first ready provider. Pure builders.
 */
import { SelectList, renderSelectList, type SelectItem, type RenderSelectOptions } from "./select-list";
import type { ProviderStatus } from "../../ai/provider-status";
import type { ProviderName } from "../../ai/types";
import { companyLabel } from "../../ai/model-catalog";
import { SUBSCRIPTION_PROVIDER_NAMES } from "../../ai/providers/openai-compatible-catalog";

/** True for subscription/plan-tier providers (coding-plan, portal, token-plan, code). */
export function isSubscriptionProvider(name: ProviderName): boolean {
  return (SUBSCRIPTION_PROVIDER_NAMES as readonly string[]).includes(name);
}

/** Right-aligned hint for a provider row: credential kind + base URL + readiness. */
export function providerHint(s: ProviderStatus, unicode = true): string {
  const parts: string[] = [s.label];
  if (s.baseUrl) parts.push(s.baseUrl);
  parts.push(s.ready ? (unicode ? "\u2713 ready" : "ready") : (unicode ? "\u00b7 setup" : "setup"));
  return parts.join(" \u00b7 ");
}

/** Build provider choices, ready providers first (stable within each group). When
 *  `current` is given, that provider's row is marked `· ● current` so the active
 *  provider is obvious in the picker (gjc-style). */
export function buildProviderChoices(statuses: ProviderStatus[], unicode = true, current?: ProviderName): SelectItem<ProviderName>[] {
  const sorted = [...statuses].sort((a, b) => (a.ready === b.ready ? 0 : a.ready ? -1 : 1));
  return sorted.map(s => ({
    value: s.name,
    label: `${s.name} (${companyLabel(s.name)})`,
    group: s.ready ? "ready" : "needs setup",
    hint: s.name === current ? `${providerHint(s, unicode)} · ${unicode ? "●" : "*"} current` : providerHint(s, unicode),
  }));
}

/** The recommended provider: the first ready provider, or the first overall. */
export function recommendedProvider(statuses: ProviderStatus[]): ProviderName | undefined {
  return (statuses.find(s => s.ready) ?? statuses[0])?.name;
}

/** Construct a ready-to-drive `SelectList` of providers. */
export function providerPicker(statuses: ProviderStatus[], unicode = true): SelectList<ProviderName> {
  return new SelectList(buildProviderChoices(statuses, unicode));
}

/** Render a provider picker `SelectList` with a sensible default title. */
export function renderProviderPicker(list: SelectList<ProviderName>, opts: RenderSelectOptions = {}): string[] {
  return renderSelectList(list, { title: "Select a provider", rows: 8, ...opts });
}
/** Relative expiry label for a stored OAuth token, e.g. "expires in 42m" / "expired". */
export function loginExpiryLabel(expires: number | undefined, now: number = Date.now()): string | undefined {
  if (!expires) return undefined;
  const ms = expires - now;
  if (ms <= 0) return "expired";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `expires in ${mins}m`;
  return `expires in ${Math.round(mins / 60)}h`;
}

/** Right-aligned hint for a `/login` row: live OAuth login status (account + expiry)
 *  rather than generic readiness. Logged-in providers show a check + account/expiry;
 *  others show a muted "not logged in". gjc-parity for the login selector. */
export function loginHint(s: ProviderStatus, unicode = true): string {
  if (!s.loggedIn) return unicode ? "\u00b7 not logged in" : "not logged in";
  const parts: string[] = [unicode ? "\u2713 logged in" : "logged in"];
  if (s.oauthEmail) parts.push(s.oauthEmail);
  const expiry = loginExpiryLabel(s.oauthExpires);
  if (expiry) parts.push(expiry);
  return parts.join(" \u00b7 ");
}

/** Build `/login` choices: logged-in providers first, each row badged with its live
 *  OAuth login status (account/expiry). Pure builder mirroring gjc's OAuth selector. */
export function buildLoginChoices(statuses: ProviderStatus[], unicode = true): SelectItem<ProviderName>[] {
  const sorted = [...statuses].sort((a, b) => (!!a.loggedIn === !!b.loggedIn ? 0 : a.loggedIn ? -1 : 1));
  return sorted.map(s => ({
    value: s.name,
    label: `${s.name} (${companyLabel(s.name)})`,
    group: s.loggedIn ? "logged in" : "not logged in",
    hint: loginHint(s, unicode),
  }));
}

/** Construct a ready-to-drive `SelectList` for the `/login` flow. */
export function loginPicker(statuses: ProviderStatus[], unicode = true): SelectList<ProviderName> {
  return new SelectList(buildLoginChoices(statuses, unicode));
}

/** Right-aligned hint for a subscription-provider row: whether its key/token is stored,
 *  plus the env var that seeds it. Subscriptions authenticate by token, not OAuth. */
export function subscriptionHint(s: ProviderStatus, unicode = true): string {
  const set = s.kind === "api_key";
  const badge = set ? (unicode ? "\u2713 active" : "active") : (unicode ? "\u00b7 no token" : "no token");
  return s.envVar ? `${badge} \u00b7 ${s.envVar}` : badge;
}

/** Build the combined "OAuth / subscription" login choices: OAuth providers (logged-in
 *  first, badged with account/expiry) followed by subscription-tier providers (active
 *  first, badged with token status). Pure builder mirroring gjc's onboarding selector. */
export function buildSubscriptionLoginChoices(
  oauthStatuses: ProviderStatus[],
  subscriptionStatuses: ProviderStatus[],
  unicode = true,
): SelectItem<ProviderName>[] {
  const oauth = [...oauthStatuses]
    .sort((a, b) => (!!a.loggedIn === !!b.loggedIn ? 0 : a.loggedIn ? -1 : 1))
    .map(s => ({
      value: s.name,
      label: `${s.name} (${companyLabel(s.name)})`,
      group: "OAuth login",
      hint: loginHint(s, unicode),
    }));
  const subs = [...subscriptionStatuses]
    .sort((a, b) => ((a.kind === "api_key") === (b.kind === "api_key") ? 0 : a.kind === "api_key" ? -1 : 1))
    .map(s => ({
      value: s.name,
      label: `${s.name} (${companyLabel(s.name)})`,
      group: "subscription / plan",
      hint: subscriptionHint(s, unicode),
    }));
  return [...oauth, ...subs];
}

/** Construct a ready-to-drive `SelectList` for the combined OAuth / subscription login flow. */
export function subscriptionLoginPicker(
  oauthStatuses: ProviderStatus[],
  subscriptionStatuses: ProviderStatus[],
  unicode = true,
): SelectList<ProviderName> {
  return new SelectList(buildSubscriptionLoginChoices(oauthStatuses, subscriptionStatuses, unicode));
}

/** Render a login picker `SelectList` with a sensible default title. */
export function renderLoginPicker(list: SelectList<ProviderName>, opts: RenderSelectOptions = {}): string[] {
  return renderSelectList(list, { title: "Select provider to login", rows: 8, ...opts });
}

/** The ways to onboard a provider, mirroring gjc's `/provider` onboarding selector:
 *  log in to an OAuth/subscription provider, register an API-compatible endpoint, or
 *  store an API key for one of the bundled API-key-only providers (groq, deepseek, …). */
export type OnboardingAction = "oauth-login" | "api-key" | "api-add";

/** Build the bare-`/provider` onboarding choices (gjc-parity interactive selector).
 *  Pure builder: OAuth-login first (the common path), then API-key providers, then a
 *  custom API-compatible endpoint. */
export function buildOnboardingChoices(unicode = true): SelectItem<OnboardingAction>[] {
  const arrow = unicode ? "\u2192 " : "";
  return [
    {
      value: "oauth-login",
      label: "Login with OAuth / subscription",
      hint: `${arrow}OAuth providers + subscription / plan tokens`,
    },
    {
      value: "api-key",
      label: "Set an API key for a provider",
      hint: `${arrow}groq, deepseek, mistral, openrouter, …`,
    },
    {
      value: "api-add",
      label: "Add an API-compatible endpoint",
      hint: `${arrow}/provider add --base-url <url>`,
    },
  ];
}

/** Construct a ready-to-drive `SelectList` for the bare-`/provider` onboarding flow. */
export function onboardingPicker(unicode = true): SelectList<OnboardingAction> {
  return new SelectList(buildOnboardingChoices(unicode));
}

/** Render the onboarding picker `SelectList` with a sensible default title. */
export function renderOnboardingPicker(list: SelectList<OnboardingAction>, opts: RenderSelectOptions = {}): string[] {
  return renderSelectList(list, { title: "Provider onboarding  \u2191\u2193 move \u00b7 Enter select \u00b7 Esc cancel", rows: 4, ...opts });
}

/** Right-aligned hint for an API-key provider row: whether a key is stored, plus the
 *  env var that seeds it. Mirrors `loginHint` but for keyed (no-OAuth) providers. */
export function apiKeyHint(s: ProviderStatus, unicode = true): string {
  const set = s.kind === "api_key";
  const badge = set ? (unicode ? "\u2713 key set" : "key set") : (unicode ? "\u00b7 no key" : "no key");
  return s.envVar ? `${badge} \u00b7 ${s.envVar}` : badge;
}

/** Build `/provider` API-key choices: providers with a stored key first, each badged with
 *  its key status + env var. Pure builder mirroring the OAuth login selector. */
export function buildApiKeyChoices(statuses: ProviderStatus[], unicode = true): SelectItem<ProviderName>[] {
  const sorted = [...statuses].sort((a, b) => (a.kind === "api_key") === (b.kind === "api_key") ? 0 : a.kind === "api_key" ? -1 : 1);
  return sorted.map(s => ({
    value: s.name,
    label: `${s.name} (${companyLabel(s.name)})`,
    group: s.kind === "api_key" ? "key set" : "needs key",
    hint: apiKeyHint(s, unicode),
  }));
}

/** Construct a ready-to-drive `SelectList` for the API-key onboarding flow. */
export function apiKeyPicker(statuses: ProviderStatus[], unicode = true): SelectList<ProviderName> {
  return new SelectList(buildApiKeyChoices(statuses, unicode));
}

/** Render the API-key provider picker `SelectList` with a sensible default title. */
export function renderApiKeyPicker(list: SelectList<ProviderName>, opts: RenderSelectOptions = {}): string[] {
  return renderSelectList(list, { title: "Select a provider to key", rows: 8, ...opts });
}
