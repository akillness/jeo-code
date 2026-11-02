import * as fs from "node:fs/promises";
import * as path from "node:path";

const EVIDENCE_DIRECTORY = "docs/verification/discord-authoritative";
const REPORT_PATH = `${EVIDENCE_DIRECTORY}/report.json`;
const LOG_PATH = `${EVIDENCE_DIRECTORY}/focused-tests.log`;
const BUILD_LOG_PATH = `${EVIDENCE_DIRECTORY}/build.log`;
const REPORT_SCHEMA_PATH = `${EVIDENCE_DIRECTORY}/release-report.schema.json`;
const PACKAGE_METADATA_PATH = "package.json";
const EXPECTED_BUILD_ARTIFACTS = ["dist/jeo"] as const;
const FOCUSED_TESTS = [
	"test/discord-jeopi-parity-spec.test.ts",
	"test/messenger.test.ts",
	"test/messenger-security-contract.test.ts",
	"test/messenger-session-identity.test.ts",
	"test/messenger-discord-recovery.test.ts",
	"test/notify-discord-daemon.test.ts",
	"test/notify-discord-attachments.test.ts",
] as const;

function run(command: string[]): { exitCode: number; stdout: string; stderr: string } {
	const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
	return {
		exitCode: result.exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}

function git(...args: string[]): string {
	const result = run(["git", ...args]);
	if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
	return result.stdout.trimEnd();
}

async function contentDigest(root: string): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	const tracked = run([
		"git", "diff", "--binary", "HEAD", "--", ".",
		`:(exclude)${EVIDENCE_DIRECTORY}`,
	]);
	if (tracked.exitCode !== 0) throw new Error(tracked.stderr.trim() || "git diff failed");
	hasher.update("tracked\0");
	hasher.update(tracked.stdout);

	const untracked = git(
		"ls-files", "--others", "--exclude-standard", "--", ".",
		`:(exclude)${EVIDENCE_DIRECTORY}`,
	).split("\n").filter(Boolean).sort();
	for (const relative of untracked) {
		hasher.update(`untracked\0${relative}\0`);
		hasher.update(await fs.readFile(path.join(root, relative)));
	}
	return hasher.digest("hex");
}

const root = git("rev-parse", "--show-toplevel");
if (path.resolve(process.cwd()) !== path.resolve(root)) {
	throw new Error(`Run from the authoritative repository root: ${root}`);
}

const evidenceDirectory = path.join(root, EVIDENCE_DIRECTORY);
await fs.mkdir(evidenceDirectory, { recursive: true });
const startedAt = new Date().toISOString();
const commitSha = git("rev-parse", "HEAD");
const status = git("status", "--short", "--", ".", `:(exclude)${EVIDENCE_DIRECTORY}`);
const digest = await contentDigest(root);
const command = ["bun", "test", ...FOCUSED_TESTS];
const result = run(command);
const completedAt = new Date().toISOString();
const output = `${result.stdout}${result.stderr}`;
await fs.writeFile(path.join(root, LOG_PATH), output, "utf8");

const summary = output.match(/\n\s*(\d+) pass\n\s*(\d+) fail\n\s*(\d+) expect\(\) calls\nRan (\d+) tests across (\d+) files\./);
const focusedVerificationSucceeded = result.exitCode === 0 && summary !== null && Number(summary[2]) === 0;
const packageMetadataBytes = await fs.readFile(path.join(root, PACKAGE_METADATA_PATH));
const packageMetadata = JSON.parse(packageMetadataBytes.toString("utf8")) as {
	name?: unknown;
	version?: unknown;
	packageManager?: unknown;
	publishConfig?: { registry?: unknown };
	scripts?: { build?: unknown };
};
if (typeof packageMetadata.name !== "string" || typeof packageMetadata.version !== "string") {
	throw new Error("package.json must declare string name and version fields");
}
if (typeof packageMetadata.packageManager !== "string" || typeof packageMetadata.scripts?.build !== "string") {
	throw new Error("package.json must declare packageManager and scripts.build fields");
}

const buildCommand = ["bun", "run", "build"];
const buildStartedAt = new Date().toISOString();
const buildResult = focusedVerificationSucceeded
	? run(buildCommand)
	: { exitCode: -1, stdout: "", stderr: "Skipped because focused Discord verification failed.\n" };
const buildCompletedAt = new Date().toISOString();
const buildOutput = `${buildResult.stdout}${buildResult.stderr}`;
await fs.writeFile(path.join(root, BUILD_LOG_PATH), buildOutput, "utf8");

const artifacts = [];
if (focusedVerificationSucceeded && buildResult.exitCode === 0) {
	for (const relativePath of EXPECTED_BUILD_ARTIFACTS) {
		const absolutePath = path.join(root, relativePath);
		const bytes = await fs.readFile(absolutePath);
		const stat = await fs.stat(absolutePath);
		artifacts.push({
			path: relativePath,
			type: "compiled executable",
			sizeBytes: stat.size,
			sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
			executable: (stat.mode & 0o111) !== 0,
			packageName: packageMetadata.name,
			packageVersion: packageMetadata.version,
			commitSha,
			contentDigest: digest,
		});
	}
}
const requiredArtifactsValid = artifacts.length === EXPECTED_BUILD_ARTIFACTS.length
	&& artifacts.every((artifact) => artifact.sizeBytes > 0 && artifact.executable);
const buildSucceeded = focusedVerificationSucceeded && buildResult.exitCode === 0 && requiredArtifactsValid;

type ReleaseStatus = "not_attempted" | "skipped" | "failed" | "succeeded";
type ReleaseStage = {
	status: ReleaseStatus;
	startedAt: string;
	completedAt: string;
	reason?: string;
	evidence: Record<string, unknown>;
};

function stage(
	status: ReleaseStatus,
	startedAt: string,
	completedAt: string,
	evidence: Record<string, unknown>,
	reason?: string,
): ReleaseStage {
	if (status !== "succeeded" && !reason) throw new Error(`${status} release stage requires a reason`);
	return { status, startedAt, completedAt, ...(reason ? { reason } : {}), evidence };
}

const credentialStartedAt = new Date().toISOString();
let credentialCheck: ReleaseStage;
let remoteUrl: string | undefined;
let npmIdentity: string | undefined;
const registry = typeof packageMetadata.publishConfig?.registry === "string"
	? packageMetadata.publishConfig.registry
	: "https://registry.npmjs.org/";
if (!buildSucceeded) {
	credentialCheck = stage("skipped", credentialStartedAt, new Date().toISOString(), {}, "Authoritative verification and build did not succeed.");
} else {
	const remote = run(["git", "remote", "get-url", "--push", "origin"]);
	remoteUrl = remote.exitCode === 0 ? remote.stdout.trim() : undefined;
	const remoteProbe = remoteUrl ? run(["git", "ls-remote", "--exit-code", "origin", "HEAD"]) : { exitCode: -1, stdout: "", stderr: "origin has no push URL" };
	const npmProbe = run(["npm", "whoami", "--registry", registry]);
	npmIdentity = npmProbe.exitCode === 0 ? npmProbe.stdout.trim() : undefined;
	const ok = remote.exitCode === 0 && remoteProbe.exitCode === 0 && npmProbe.exitCode === 0;
	credentialCheck = stage(ok ? "succeeded" : "failed", credentialStartedAt, new Date().toISOString(), {
		gitRemoteConfigured: remote.exitCode === 0,
		gitRemoteReachable: remoteProbe.exitCode === 0,
		npmAuthenticated: npmProbe.exitCode === 0,
		...(remoteUrl ? { remoteUrl } : {}),
		...(npmIdentity ? { npmIdentity } : {}),
		registry,
	}, ok ? undefined : "One or more direct git/npm credential probes failed; no release action was attempted.");
}

// A dirty authoritative tree cannot correspond to a pushed commit or an npm
// package version. Never release it even when ambient credentials are valid.
const pushStartedAt = new Date().toISOString();
const gitPush = stage(
	"skipped",
	pushStartedAt,
	new Date().toISOString(),
	{ ...(remoteUrl ? { remoteUrl } : {}), ref: git("symbolic-ref", "--quiet", "--short", "HEAD") || "HEAD", commitSha },
	status.length > 0
		? "The authoritative worktree is dirty, so no commit exactly represents the verified content digest."
		: credentialCheck.status !== "succeeded"
			? "Credential checking did not succeed."
			: "No new release commit exists to push; committing was not authorized.",
);

const publicationStartedAt = new Date().toISOString();
const npmPublication = stage(
	"skipped",
	publicationStartedAt,
	new Date().toISOString(),
	{ registry, packageName: packageMetadata.name, version: packageMetadata.version },
	status.length > 0
		? "The authoritative worktree is dirty, so the package cannot be bound to a releasable commit."
		: credentialCheck.status !== "succeeded"
			? "Credential checking did not succeed."
			: "Publication requires a pushed commit that corresponds to the verified build.",
);

const report = {
	$schema: "https://github.com/akillness/jeo-code/blob/main/docs/verification/discord-authoritative/release-report.schema.json",
	schemaVersion: 1,
	kind: "jeo-code-discord-authoritative-verification",
	authoritativeRepository: root,
	commitSha,
	workingTree: {
		dirty: status.length > 0,
		status: status ? status.split("\n") : [],
		contentDigestAlgorithm: "sha256(git-diff-binary-HEAD plus sorted untracked path-and-content; evidence directory excluded)",
		contentDigest: digest,
	},
	environment: { bun: Bun.version, platform: process.platform, architecture: process.arch },
	startedAt,
	completedAt,
	commands: [{
		argv: command,
		cwd: root,
		exitCode: result.exitCode,
		startedAt,
		completedAt,
		evidencePath: LOG_PATH,
	}, {
		argv: buildCommand,
		cwd: root,
		exitCode: buildResult.exitCode,
		startedAt: buildStartedAt,
		completedAt: buildCompletedAt,
		evidencePath: BUILD_LOG_PATH,
	}],
	testTotals: summary ? {
		passed: Number(summary[1]),
		failed: Number(summary[2]),
		assertions: Number(summary[3]),
		tests: Number(summary[4]),
		files: Number(summary[5]),
	} : null,
	parityContractPath: "test/fixtures/discord-jeopi-parity.json",
	reportSchemaPath: REPORT_SCHEMA_PATH,
	package: { name: packageMetadata.name, version: packageMetadata.version },
	buildContract: {
		packageDirectory: root,
		packageMetadataPath: PACKAGE_METADATA_PATH,
		packageMetadataSha256: new Bun.CryptoHasher("sha256").update(packageMetadataBytes).digest("hex"),
		configuredPackageManager: packageMetadata.packageManager,
		executionRuntime: `bun@${Bun.version}`,
		scriptName: "build",
		configuredScript: packageMetadata.scripts.build,
		exactCommand: buildCommand,
		packageName: packageMetadata.name,
		packageVersion: packageMetadata.version,
		versionSource: `${PACKAGE_METADATA_PATH}#/version`,
		expectedOutputPaths: [...EXPECTED_BUILD_ARTIFACTS],
		identityBinding: {
			commitSha,
			contentDigest: digest,
			rule: "Artifacts are produced by the recorded package.json build script in the authoritative package directory, then hashed and tagged with the pre-build commit and dirty-tree content digest.",
		},
		artifacts,
		status: buildSucceeded ? "succeeded" : "failed",
	},
	releaseState: {
		credentialCheck,
		gitPush,
		npmPublication,
		correspondenceRule: "A successful push must remotely resolve the recorded ref to commitSha. A successful publication must be found by registry lookup and record a correspondence value derived from the verified artifact SHA-256, commit SHA, and dirty-tree content digest.",
	},
	evidencePaths: [REPORT_PATH, REPORT_SCHEMA_PATH, LOG_PATH, BUILD_LOG_PATH],
	status: focusedVerificationSucceeded && buildSucceeded ? "succeeded" : "failed",
};
await fs.writeFile(path.join(root, REPORT_PATH), `${JSON.stringify(report, null, 2)}\n`, "utf8");
const validation = run(["bun", "scripts/validate-discord-release-report.ts", REPORT_PATH, REPORT_SCHEMA_PATH]);
if (validation.exitCode !== 0) {
	process.stderr.write(validation.stderr || validation.stdout);
	process.exit(1);
}
process.stdout.write(output);
process.stdout.write(`\nAuthoritative report: ${REPORT_PATH}\n`);

if (report.status !== "succeeded") process.exit(1);
