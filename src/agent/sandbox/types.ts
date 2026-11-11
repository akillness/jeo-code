import type { ToolHandler } from "../engine";
import type { ToolResult } from "../tools";

export interface SandboxMount {
  readonly host: string;
  readonly guest: string;
  readonly mode: "ro" | "rw";
}

export interface SandboxLimits {
  readonly memoryBytes: number;
  readonly pids: number;
  readonly cpus: number;
}

/** A session container: an existing local Linux image plus finite resource limits. */
export interface DockerSandboxConfig {
  readonly backend?: "docker";
  readonly image: string;
  readonly limits: SandboxLimits;
}

/**
 * The operating system's own process sandbox (macOS Seatbelt, Linux bubblewrap): no image,
 * no daemon, nothing to install on macOS. Mounts keep their host paths because there is no
 * mount namespace to remap them into.
 */
export interface NativeSandboxConfig {
  readonly backend: "native";
}

export type SandboxConfig = DockerSandboxConfig | NativeSandboxConfig;

export interface SandboxPolicy {
  readonly sessionKey: string;
  readonly revision: number;
  readonly mounts: readonly SandboxMount[];
  /** Canonical workspace root. Set for native policies only, where no fixed guest path names it. */
  readonly workspace?: string;
  readonly privatePaths?: readonly string[];
  readonly config: SandboxConfig;
  readonly digest: string;
}

export interface SandboxTermination {
  readonly gone: boolean;
  readonly residual: readonly string[];
}

export interface SandboxProcess {
  readonly name: string;
  readonly stdin: { write(data: string): unknown; flush(): unknown; end(): unknown };
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  stop(): Promise<SandboxTermination>;
}

export interface SandboxBackend {
  preflight(config: SandboxConfig): Promise<{ imageId: string; platform: string }>;
  launch(policy: SandboxPolicy, bundlePath: string): Promise<SandboxProcess>;
}

export interface SandboxCallOptions {
  cwd?: string;
  signal?: AbortSignal;
  onProgress?: (text: string) => void;
}

export interface SandboxExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  signal?: AbortSignal;
}

export interface SandboxExecResult extends ToolResult {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  aborted?: boolean;
}

export interface SandboxSupervisor {
  toolMap(names: readonly string[]): Record<string, ToolHandler>;
  call(tool: string, args: Record<string, unknown>, options?: SandboxCallOptions): Promise<ToolResult>;
  exec(argv: readonly string[], options?: SandboxExecOptions): Promise<SandboxExecResult>;
  replacePolicy(policy: SandboxPolicy): Promise<void>;
  revoke(): Promise<SandboxTermination>;
  close(): Promise<void>;
}
