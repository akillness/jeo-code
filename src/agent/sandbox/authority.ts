import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { canonicalSandboxPath, createSandboxPolicy, sandboxPathContains, windowsSystemRoot } from "./policy";
import type { SandboxConfig, SandboxMount, SandboxSupervisor, SandboxTermination } from "./types";

/** Constructed by trusted parent entry points, never from model/tool arguments. */
export interface SandboxActor {
  readonly origin: "terminal" | "discord" | "model";
  readonly sessionKey: string;
  readonly userId?: string;
}

export interface GrantRequest {
  readonly id: string;
  readonly sessionKey: string;
  readonly revision: number;
  readonly host: string;
  readonly mode: "ro" | "rw";
  readonly status: "pending" | "approved" | "denied" | "stale";
}

export interface GrantAuthoritySnapshot {
  readonly sessionKey: string;
  readonly revision: number;
  readonly grants: readonly SandboxMount[];
  readonly requests: readonly GrantRequest[];
  readonly blocked: boolean;
  readonly stateDirectory: string;
}

export interface GrantAuthority {
  requestAccess(host: string, mode: "ro" | "rw"): Promise<GrantRequest>;
  approve(requestId: string, actor: SandboxActor): Promise<GrantRequest>;
  reject(requestId: string, actor: SandboxActor): Promise<GrantRequest>;
  revoke(actor: SandboxActor): Promise<SandboxTermination>;
  snapshot(actor?: SandboxActor): GrantAuthoritySnapshot;
  awaitDecision(requestId: string, signal?: AbortSignal): Promise<GrantRequest>;
}

export interface GrantAuthorityOptions {
  sessionKey: string;
  cwd: string;
  config: SandboxConfig;
  supervisor: SandboxSupervisor;
  allowedUserIds: readonly string[];
  stateDirectory: string;
  privateRoots?: readonly string[];
}

type DecisionWaiter = { resolve(value: GrantRequest): void; reject(reason: Error): void };

const pendingPrivateDirectories = new Map<string, Promise<string>>();

/** Create app-private state, or verify existing state without widening its ACL. */
export async function ensurePrivateSandboxDirectory(directory: string): Promise<string> {
  const canonical = await canonicalSandboxPath(directory, false);
  const key = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  const active = pendingPrivateDirectories.get(key);
  if (active) return active;
  const operation = (async (): Promise<string> => {
    if (process.platform === "win32") {
      const systemRoot = windowsSystemRoot();
      await fs.mkdir(path.dirname(canonical), { recursive: true });
      // Fixed parent-owned program; paths are data, never interpolated into code.
      // Windows PowerShell 5.1 provides .NET Framework's ACL creation and SetAccessControl APIs.
      // Note: Win32 CreateDirectoryW applies explicit ACEs from SECURITY_ATTRIBUTES but strips
      // SE_DACL_PROTECTED unless SetAccessControl (SetNamedSecurityInfoW) is called afterwards.
      const script = `
$ErrorActionPreference = 'Stop'
$mutex = New-Object System.Threading.Mutex($false, 'Local\\jeo-sandbox-private-directory')
$locked = $false
try {
  try { $locked = $mutex.WaitOne(30000) } catch [System.Threading.AbandonedMutexException] { $locked = $true }
  if (-not $locked) { throw 'mutex timeout' }
  $directory = $env:JEO_SANDBOX_PRIVATE_DIRECTORY
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $sid = $identity.User
  $tokenOwner = $identity.Owner
  $inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
  $accessRule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', $inherit, 'None', 'Allow')
  $daclSecurity = New-Object System.Security.AccessControl.DirectorySecurity
  $daclSecurity.SetAccessRuleProtection($true, $false)
  $daclSecurity.AddAccessRule($accessRule)
  $created = $false
  if (-not [System.IO.Directory]::Exists($directory)) {
    $createSecurity = New-Object System.Security.AccessControl.DirectorySecurity
    $createSecurity.SetAccessRuleProtection($true, $false)
    $createSecurity.SetOwner($sid)
    $createSecurity.AddAccessRule($accessRule)
    [void][System.IO.Directory]::CreateDirectory($directory, $createSecurity)
    $created = $true
  }
  try {
    if (([System.IO.File]::GetAttributes($directory) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse point' }
    if ($created) {
      [System.IO.Directory]::SetAccessControl($directory, $daclSecurity)
      $currentOwner = [System.IO.Directory]::GetAccessControl($directory).GetOwner([System.Security.Principal.SecurityIdentifier])
      if ($currentOwner.Value -ne $sid.Value) {
        $ownerSecurity = [System.IO.Directory]::GetAccessControl($directory)
        $ownerSecurity.SetAccessRuleProtection($true, $false)
        $ownerSecurity.SetOwner($sid)
        [System.IO.Directory]::SetAccessControl($directory, $ownerSecurity)
      }
    } else {
      $existing = [System.IO.Directory]::GetAccessControl($directory)
      $existingOwner = $existing.GetOwner([System.Security.Principal.SecurityIdentifier])
      $existingRules = $existing.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
      if ($existingRules.Count -eq 1) {
        $existingRule = $existingRules[0]
        $ownerMatchesToken = ($existingOwner.Value -eq $sid.Value) -or ($null -ne $tokenOwner -and $existingOwner.Value -eq $tokenOwner.Value)
        if ($ownerMatchesToken -and $existingRule.IdentityReference.Value -eq $sid.Value -and -not $existingRule.IsInherited -and $existingRule.AccessControlType -eq 'Allow' -and $existingRule.FileSystemRights -eq 'FullControl' -and $existingRule.InheritanceFlags -eq $inherit -and $existingRule.PropagationFlags -eq 'None') {
          if (-not $existing.AreAccessRulesProtected) {
            [System.IO.Directory]::SetAccessControl($directory, $daclSecurity)
          }
          if ($existingOwner.Value -ne $sid.Value) {
            $ownerSecurity = [System.IO.Directory]::GetAccessControl($directory)
            $ownerSecurity.SetAccessRuleProtection($true, $false)
            $ownerSecurity.SetOwner($sid)
            [System.IO.Directory]::SetAccessControl($directory, $ownerSecurity)
          }
        }
      }
    }
    $actual = [System.IO.Directory]::GetAccessControl($directory)
    if (-not $actual.AreAccessRulesProtected -or $actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'owner or inheritance' }
    $rules = $actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
    if ($rules.Count -ne 1) { throw 'unexpected access rules' }
    $rule = $rules[0]
    if ($rule.IdentityReference.Value -ne $sid.Value -or $rule.IsInherited -or $rule.AccessControlType -ne 'Allow' -or $rule.FileSystemRights -ne 'FullControl' -or $rule.InheritanceFlags -ne $inherit -or $rule.PropagationFlags -ne 'None') { throw 'non-private rule' }
  } catch {
    if ($created) { try { [System.IO.Directory]::Delete($directory, $false) } catch {} }
    throw
  }
  [Console]::Out.Write('JEO_PRIVATE_DIRECTORY_VERIFIED')
  exit 0
} catch { exit 1 }
finally {
  if ($locked) { try { $mutex.ReleaseMutex() } catch {} }
  $mutex.Dispose()
}
`;
      const executable = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const child = Bun.spawn([executable, "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
        env: { SystemRoot: systemRoot, JEO_SANDBOX_PRIVATE_DIRECTORY: canonical },
        stdin: "ignore", stdout: "pipe", stderr: "ignore",
      });
      const timer = setTimeout(() => child.kill(), 30_000);
      try {
        const [exitCode, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
        if (exitCode !== 0 || output !== "JEO_PRIVATE_DIRECTORY_VERIFIED") {
          throw new Error("SANDBOX_STATE: private Windows owner-only ACL could not be verified");
        }
      } finally { clearTimeout(timer); }
    } else {
      await fs.mkdir(canonical, { recursive: true, mode: 0o700 });
    }
    const stat = await fs.lstat(canonical);
    if (!stat.isDirectory() || stat.isSymbolicLink() ||
        (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) {
      throw new Error("SANDBOX_STATE: authority state must be a private owner-only directory");
    }
    return canonical;
  })();
  pendingPrivateDirectories.set(key, operation);
  try {
    return await operation;
  } finally {
    if (pendingPrivateDirectories.get(key) === operation) pendingPrivateDirectories.delete(key);
  }
}

/** All mutable authority remains in this parent closure, outside worker mounts. */
export async function createGrantAuthority(options: GrantAuthorityOptions): Promise<GrantAuthority> {
  const sessionKey = options.sessionKey;
  const supervisor = options.supervisor;
  const allowedUserIds = new Set(options.allowedUserIds);
  const cwd = await canonicalSandboxPath(options.cwd);
  const stateDirectory = await canonicalSandboxPath(options.stateDirectory, false);
  const privatePaths = await Promise.all([stateDirectory, ...(options.privateRoots ?? [])]
    .map(value => canonicalSandboxPath(value, false)));
  if (sandboxPathContains(cwd, stateDirectory) || sandboxPathContains(stateDirectory, cwd)) {
    throw new Error("SANDBOX_STATE: authority state must be outside workspace mounts");
  }
  const initialPolicy = await createSandboxPolicy({
    sessionKey, revision: 0, cwd, config: options.config, privatePaths,
  });
  await ensurePrivateSandboxDirectory(stateDirectory);
  const config = initialPolicy.config;
  let revision = initialPolicy.revision;
  let grants: readonly SandboxMount[] = Object.freeze([]);
  const requests = new Map<string, GrantRequest>();
  const waiters = new Map<string, Set<DecisionWaiter>>();
  let failed = false;
  let transitioning = false;
  let queue: Promise<unknown> = Promise.resolve();

  function serialize<T>(operation: () => Promise<T> | T): Promise<T> {
    const next = queue.then(operation);
    queue = next.catch(() => undefined);
    return next;
  }

  function authorize(actor: SandboxActor): void {
    if (!actor || actor.origin === "model" ||
        (actor.origin !== "terminal" && actor.origin !== "discord") ||
        (actor.origin === "discord" && (!actor.userId || !allowedUserIds.has(actor.userId)))) {
      throw new Error("UNAUTHORIZED: sandbox decisions require an authenticated human");
    }
    if (actor.sessionKey !== sessionKey) throw new Error("SESSION_MISMATCH: sandbox actor belongs to another session");
  }

  function requireAvailable(): void {
    if (failed) throw new Error("REVOKE_INCOMPLETE: sandbox authority is blocked after an unconfirmed transition");
  }

  function pendingRequest(id: string): GrantRequest {
    const request = requests.get(id);
    if (!request) throw new Error("UNKNOWN_REQUEST: sandbox request does not exist in this session");
    if (request.revision !== revision || request.status !== "pending") {
      throw new Error("STALE_REQUEST: sandbox request is no longer pending at the current revision");
    }
    return request;
  }

  function decide(request: GrantRequest, status: GrantRequest["status"]): GrantRequest {
    const decided = Object.freeze({ ...request, status });
    requests.set(request.id, decided);
    const listeners = waiters.get(request.id);
    waiters.delete(request.id);
    for (const waiter of listeners ?? []) waiter.resolve(decided);
    return decided;
  }

  function stalePending(): void {
    for (const request of requests.values()) {
      if (request.status === "pending") decide(request, "stale");
    }
  }

  function block(error: unknown): never {
    failed = true;
    stalePending();
    throw new Error("REVOKE_INCOMPLETE: sandbox transition could not confirm removal of old authority", { cause: error });
  }

  return Object.freeze({
    async requestAccess(host: string, mode: "ro" | "rw"): Promise<GrantRequest> {
      return serialize(async () => {
        requireAvailable();
        if (mode !== "ro" && mode !== "rw") throw new Error("SANDBOX_POLICY: invalid access mode");
        if (typeof host !== "string" || !host.trim()) throw new Error("SANDBOX_PATH: invalid host path");
        const canonical = await canonicalSandboxPath(host, true, cwd);
        // Reuse the policy validator for every private-path and mount restriction.
        await createSandboxPolicy({ sessionKey, revision, cwd, config, grants: [...grants, { host: canonical, mode }], privatePaths });
        const request: GrantRequest = Object.freeze({
          id: randomUUID(), sessionKey, revision, host: canonical, mode, status: "pending",
        });
        requests.set(request.id, request);
        return request;
      });
    },

    async approve(requestId: string, actor: SandboxActor): Promise<GrantRequest> {
      authorize(actor);
      return serialize(async () => {
        requireAvailable();
        const request = pendingRequest(requestId);
        try {
          if (await canonicalSandboxPath(request.host) !== request.host) {
            throw new Error("Requested resource changed its canonical path");
          }
        } catch (error) {
          decide(request, "stale");
          throw new Error("STALE_REQUEST: requested resource no longer has its original canonical path", { cause: error });
        }
        const policy = await createSandboxPolicy({
          sessionKey, revision: revision + 1, cwd, config,
          grants: [...grants, { host: request.host, mode: request.mode }], privatePaths,
        });
        transitioning = true;
        try {
          await supervisor.replacePolicy(policy);
          revision = policy.revision;
          grants = Object.freeze(policy.mounts.filter(mount => mount.host !== cwd));
          const approved = decide(request, "approved");
          stalePending();
          return approved;
        } catch (error) {
          return block(error);
        } finally {
          transitioning = false;
        }
      });
    },

    async reject(requestId: string, actor: SandboxActor): Promise<GrantRequest> {
      authorize(actor);
      return serialize(() => {
        requireAvailable();
        return decide(pendingRequest(requestId), "denied");
      });
    },

    async revoke(actor: SandboxActor): Promise<SandboxTermination> {
      authorize(actor);
      return serialize(async () => {
        transitioning = true;
        try {
          const termination = await supervisor.revoke();
          if (termination.gone !== true || termination.residual.length !== 0) {
            throw new Error("REVOKE_INCOMPLETE: owned sandbox processes remain");
          }
          grants = Object.freeze([]);
          revision++;
          stalePending();
          return Object.freeze({ gone: true, residual: Object.freeze([]) });
        } catch (error) {
          return block(error);
        } finally {
          transitioning = false;
        }
      });
    },

    snapshot(actor?: SandboxActor): GrantAuthoritySnapshot {
      if (actor !== undefined) authorize(actor);
      return Object.freeze({
        sessionKey, revision, grants,
        requests: Object.freeze([...requests.values()]),
        blocked: failed || transitioning, stateDirectory,
      });
    },

    async awaitDecision(requestId: string, signal?: AbortSignal): Promise<GrantRequest> {
      const request = requests.get(requestId);
      if (!request) throw new Error("UNKNOWN_REQUEST: sandbox request does not exist in this session");
      if (signal?.aborted) throw new Error("ABORTED: waiting for sandbox decision was cancelled");
      if (request.status !== "pending") return request;
      return new Promise<GrantRequest>((resolve, reject) => {
        const listeners = waiters.get(requestId) ?? new Set<DecisionWaiter>();
        const cleanup = () => {
          signal?.removeEventListener("abort", abort);
          listeners.delete(waiter);
          if (listeners.size === 0) waiters.delete(requestId);
        };
        const waiter: DecisionWaiter = {
          resolve(value) { cleanup(); resolve(value); },
          reject(error) { cleanup(); reject(error); },
        };
        const abort = () => waiter.reject(new Error("ABORTED: waiting for sandbox decision was cancelled"));
        listeners.add(waiter);
        waiters.set(requestId, listeners);
        signal?.addEventListener("abort", abort, { once: true });
      });
    },
  });
}
