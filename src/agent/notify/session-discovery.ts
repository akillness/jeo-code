/** Validate private discovery data before dialing an authenticated loopback socket. */
export function parseSessionEndpoint(raw: string): { url: string; token: string; pid: number; cwd: string } | undefined {
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const { url, token, pid, cwd } = value;
    if (typeof url !== "string" || typeof token !== "string" || !token.trim() ||
        !Number.isSafeInteger(pid) || pid <= 0 || typeof cwd !== "string" || !cwd) return undefined;
    const parsed = new URL(url);
    if (parsed.protocol !== "ws:" || parsed.hostname !== "127.0.0.1" || !parsed.port ||
        parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return undefined;
    return { url: parsed.origin, token, pid, cwd };
  } catch {
    return undefined;
  }
}
