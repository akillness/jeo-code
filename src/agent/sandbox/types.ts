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

export interface SandboxConfig {
  readonly image: string;
  readonly limits: SandboxLimits;
}

export interface SandboxPolicy {
  readonly sessionKey: string;
  readonly revision: number;
  readonly mounts: readonly SandboxMount[];
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
