/**
 * Local OAuth callback server + flow base class.
 *
 * Pure-TS / Bun.serve reimplementation of gjc's
 * `packages/ai/src/utils/oauth/callback-server.ts`. Handles:
 *  - preferred-port binding with random fallback (unless a fixed redirectUri is required)
 *  - CSRF state validation
 *  - browser callback OR manual paste of the redirect URL / code (whichever lands first)
 */
import type { OAuthController, OAuthCredentials } from "./types";
import { generateState } from "./pkce";

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_HOSTNAME = "localhost";
const DEFAULT_CALLBACK_PATH = "/callback";

export interface OAuthCallbackFlowOptions {
  preferredPort: number;
  callbackPath?: string;
  callbackHostname?: string;
  /** Exact redirect URI advertised to the provider; disables port fallback when set. */
  redirectUri?: string;
}

export type CallbackResult = { code: string; state: string };

const SUCCESS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>jeo — login complete</title>
<style>body{font-family:system-ui,sans-serif;background:#0d1117;color:#e6edf3;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{text-align:center;padding:2rem 3rem;border:1px solid #30363d;border-radius:12px;background:#161b22}
h1{margin:0 0 .5rem;font-size:1.4rem}p{margin:0;color:#8b949e}</style></head>
<body><div class="card"><h1>__TITLE__</h1><p>__MSG__</p></div></body></html>`;

function renderHtml(ok: boolean, msg: string): string {
  return SUCCESS_HTML
    .replace("__TITLE__", ok ? "Login complete \u2713" : "Login failed")
    .replace("__MSG__", msg);
}

export abstract class OAuthCallbackFlow {
  protected ctrl: OAuthController;
  protected preferredPort: number;
  protected callbackPath: string;
  protected callbackHostname: string;
  protected fixedRedirectUri?: string;
  #resolve?: (r: CallbackResult) => void;
  #reject?: (e: Error) => void;

  constructor(ctrl: OAuthController, opts: number | OAuthCallbackFlowOptions, callbackPath = DEFAULT_CALLBACK_PATH) {
    this.ctrl = ctrl;
    if (typeof opts === "number") {
      this.preferredPort = opts;
      this.callbackPath = callbackPath;
      this.callbackHostname = DEFAULT_HOSTNAME;
      return;
    }
    this.preferredPort = opts.preferredPort;
    this.callbackPath = opts.callbackPath ?? DEFAULT_CALLBACK_PATH;
    this.callbackHostname = opts.callbackHostname ?? DEFAULT_HOSTNAME;
    this.fixedRedirectUri = opts.redirectUri;
  }

  abstract generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string; instructions?: string }>;
  abstract exchangeToken(code: string, state: string, redirectUri: string): Promise<OAuthCredentials>;

  async login(): Promise<OAuthCredentials> {
    const state = generateState();
    const { server, redirectUri } = this.#startServer(state);
    try {
      const { url, instructions } = await this.generateAuthUrl(state, redirectUri);
      this.ctrl.onAuth?.({ url, instructions });
      this.ctrl.onProgress?.("Waiting for browser authentication...");
      const { code, state: returnedState } = await this.#waitForCallback(state);
      this.ctrl.onProgress?.("Exchanging authorization code for tokens...");
      return await this.exchangeToken(code, returnedState || state, redirectUri);
    } finally {
      server.stop();
    }
  }

  #startServer(expectedState: string): { server: Bun.Server<unknown>; redirectUri: string } {
    const serve = (port: number) =>
      Bun.serve({
        hostname: this.callbackHostname,
        port,
        fetch: req => this.#handle(req, expectedState),
      });
    try {
      const server = serve(this.preferredPort);
      const redirectUri =
        this.fixedRedirectUri ?? `http://${this.callbackHostname}:${server.port}${this.callbackPath}`;
      return { server, redirectUri };
    } catch {
      if (this.fixedRedirectUri) {
        throw new Error(
          `OAuth callback port ${this.preferredPort} unavailable and this provider requires a fixed redirect URI.`
        );
      }
      const server = serve(0);
      const redirectUri = `http://${this.callbackHostname}:${server.port}${this.callbackPath}`;
      this.ctrl.onProgress?.(`Port ${this.preferredPort} busy; using ${server.port}.`);
      return { server, redirectUri };
    }
  }

  #handle(req: Request, expectedState: string): Response {
    const url = new URL(req.url);
    if (url.pathname !== this.callbackPath) return new Response("Not Found", { status: 404 });

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") || "";
    const error = url.searchParams.get("error");
    const errorDesc = url.searchParams.get("error_description") || error;

    let ok = false;
    let message: string;
    if (error) message = `Authorization failed: ${errorDesc}`;
    else if (!code) message = "Missing authorization code";
    else if (expectedState && state !== expectedState) message = "State mismatch — possible CSRF attack";
    else {
      ok = true;
      message = "You can close this tab and return to the terminal.";
    }

    const resolve = this.#resolve;
    const reject = this.#reject;
    queueMicrotask(() => {
      if (ok && code) resolve?.({ code, state });
      else reject?.(new Error(message));
    });

    return new Response(renderHtml(ok, message), {
      status: ok ? 200 : 400,
      headers: { "content-type": "text/html" },
    });
  }

  #waitForCallback(expectedState: string): Promise<CallbackResult> {
    const timeout = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
    const signal = this.ctrl.signal ? AbortSignal.any([this.ctrl.signal, timeout]) : timeout;

    const callbackPromise = new Promise<CallbackResult>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
      signal.addEventListener("abort", () => {
        this.#resolve = undefined;
        this.#reject = undefined;
        reject(new Error(`OAuth callback cancelled: ${signal.reason}`));
      });
    });

    if (this.ctrl.onManualCodeInput) {
      const ask = this.ctrl.onManualCodeInput;
      const manualPromise = (async (): Promise<CallbackResult> => {
        while (true) {
          // Cooperative cancellation: once the controller signal aborts (the
          // caller finished or failed the login), STOP re-prompting. Without
          // this guard an aborted `ask()` rejects instantly, the catch maps it
          // to null, and the loop spins re-asking forever.
          if (signal.aborted) return callbackPromise;
          const result = await Promise.race<CallbackResult | null>([
            callbackPromise,
            ask()
              .then(input => {
                const parsed = parseCallbackInput(input);
                if (!parsed.code) return null;
                if (expectedState && parsed.state !== expectedState) return null; // reject missing OR mismatched state
                return { code: parsed.code, state: parsed.state ?? "" } as CallbackResult;
              })
              .catch(() => null),
          ]);
          if (result) return result;
        }
      })();
      return Promise.race([callbackPromise, manualPromise]);
    }

    return callbackPromise;
  }
}

/** Parse a pasted redirect URL or bare `code#state` into its parts. */
export function parseCallbackInput(input: string): { code?: string; state?: string } {
  const value = input.trim();
  if (!value) return {};
  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch {
    /* not a URL */
  }
  if (value.includes("code=")) {
    const params = new URLSearchParams(value.replace(/^[?#]/, ""));
    return { code: params.get("code") ?? undefined, state: params.get("state") ?? undefined };
  }
  const [code, state] = value.split("#", 2);
  return { code, state };
}
