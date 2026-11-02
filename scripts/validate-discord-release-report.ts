import * as fs from "node:fs/promises";

const reportPath = process.argv[2];
const schemaPath = process.argv[3];
if (!reportPath || !schemaPath) throw new Error("usage: validate-discord-release-report.ts REPORT SCHEMA");

const report = JSON.parse(await fs.readFile(reportPath, "utf8")) as Record<string, any>;
const schema = JSON.parse(await fs.readFile(schemaPath, "utf8")) as Record<string, any>;
const statuses = new Set(schema.$defs.releaseStage.properties.status.enum as string[]);
const required = schema.required as string[];
for (const key of required) if (!(key in report)) throw new Error(`report missing schema-required property: ${key}`);

if (report.$schema !== schema.$id) throw new Error("report $schema does not identify the checked-in schema");
if (!/^[0-9a-f]{40}$/.test(report.commitSha)) throw new Error("commitSha must be a full SHA-1");
if (report.workingTree.dirty && !/^[0-9a-f]{64}$/.test(report.workingTree.contentDigest)) throw new Error("dirty report requires a SHA-256 content digest");
if (report.buildContract.packageName !== report.package.name || report.buildContract.packageVersion !== report.package.version) throw new Error("package identity does not match build contract");

for (const name of ["credentialCheck", "gitPush", "npmPublication"] as const) {
	const value = report.releaseState[name];
	if (!value || !statuses.has(value.status)) throw new Error(`${name} has an invalid status`);
	if (!Date.parse(value.startedAt) || !Date.parse(value.completedAt)) throw new Error(`${name} requires timestamps`);
	if (value.status !== "succeeded" && (typeof value.reason !== "string" || value.reason.length === 0)) throw new Error(`${name} non-success requires reason`);
}
const push = report.releaseState.gitPush;
if (push.status === "succeeded" && (!push.evidence.remoteUrl || !push.evidence.ref || !/^[0-9a-f]{40}$/.test(push.evidence.remotelyVerifiedCommitSha))) {
	throw new Error("successful gitPush requires remote URL, ref, and remotely verified commit SHA");
}
const publication = report.releaseState.npmPublication;
if (publication.status === "succeeded" && (!publication.evidence.registry || !publication.evidence.packageName || !publication.evidence.version || !publication.evidence.registryLookup || !publication.evidence.correspondence)) {
	throw new Error("successful npmPublication requires registry lookup and build correspondence evidence");
}
console.log(`validated ${reportPath} against ${schemaPath}`);
