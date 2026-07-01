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
// Loopback callback host. `localhost` (not the 127.0.0.1 IP literal) is the intentional
// default — providers register their redirect URIs against `localhost`, so the dynamic
// loopback flows (Anthropic / Google / Antigravity) must match. Keep this as `localhost`.
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

// "jeo" wordmark — bold forged monospace lettering on a neon blue→violet→pink
// gradient (the mascot's synthwave palette), generated via god-tibo-imagen and
// matching jeo-pi's bold-wordmark typographic treatment. Embedded as a data URI
// (not a served static file) so the callback page renders standalone even from
// a bundled/compiled `jeo` binary with no static-asset pipeline.
const JEO_WORDMARK_DATA_URI =
  "data:image/webp;base64,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";

const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>jeo — status</title>
<style>:root{color-scheme:dark}*{box-sizing:border-box}
body{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#0b0a10;color:#e7e7ec;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{text-align:center;padding:2.5rem 3rem;border:1px solid #2a2a35;border-radius:20px;background:#12131c;max-width:26rem}
.wordmark{width:88px;height:88px;display:block;margin:0 auto 1.25rem;border-radius:14px}
h1{margin:0 0 .5rem;font-size:1.1rem;font-weight:600}
h1.ok{color:#22d3ee}h1.fail{color:#f472b6}
p{margin:.25rem 0;color:#8b8b96;font-size:.92rem}
button{margin-top:1.5rem;padding:.55rem 1.6rem;border-radius:999px;border:1px solid #2a2a35;background:transparent;color:#e7e7ec;font:inherit;font-size:.88rem;cursor:pointer}
button:hover{background:#1b1c27}
.hint{margin-top:.9rem;font-size:.78rem;color:#5f5f6b}</style></head>
<body><div class="card">
<img class="wordmark" alt="jeo" src="${JEO_WORDMARK_DATA_URI}">
<h1 class="__STATUS__">__TITLE__</h1>
<p>__MSG__</p>
<button id="jeo-close" type="button">Close</button>
<p class="hint">Closing automatically in <span id="jeo-countdown">__SECONDS__</span>s…</p>
</div>
<script>__SCRIPT__</script>
</body></html>`;

// Seconds before the tab auto-closes — applies to BOTH the success and the
// failure page now (previously only success auto-closed). Pressing "Close"
// closes immediately without waiting out the countdown. `window.close()` only
// succeeds on tabs the script itself opened; browsers may ignore it for
// OS-launched OAuth tabs, so the button remains as the reliable fallback.
const AUTO_CLOSE_SECONDS = 5;

function renderHtml(ok: boolean, msg: string): string {
  const script = `(function(){
    var n=${AUTO_CLOSE_SECONDS},el=document.getElementById("jeo-countdown"),btn=document.getElementById("jeo-close"),t;
    function closeNow(){clearInterval(t);window.close();}
    t=setInterval(function(){n-=1;if(el)el.textContent=String(Math.max(n,0));if(n<=0)closeNow();},1000);
    if(btn)btn.addEventListener("click",closeNow);
  })();`;
  return PAGE_HTML
    .replace("__STATUS__", ok ? "ok" : "fail")
    .replace("__TITLE__", ok ? "Login complete \u2713" : "Login failed")
    .replace("__MSG__", msg)
    .replace("__SECONDS__", String(AUTO_CLOSE_SECONDS))
    .replace("__SCRIPT__", script);
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
      message = "Authentication succeeded. Return to the terminal — jeo is ready.";
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
