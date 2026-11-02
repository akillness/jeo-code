import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import spec from "./fixtures/discord-jeopi-parity.json";
import { discordGatewayUrl } from "../src/messenger/discord";

const root = path.resolve(import.meta.dir, "..");
const requiredFields = ["id", "referenceSource", "observableBehavior", "permittedDifference", "jeoBoundary", "focusedProof"] as const;

describe("checked-in Discord/jeopi parity contract", () => {
	test("canonical Discord Gateway origin validation matches the pinned contract", () => {
		expect(discordGatewayUrl("wss://gateway.discord.gg/")).toBe("wss://gateway.discord.gg/?v=10&encoding=json");
		for (const value of [
			"ws://gateway.discord.gg/",
			"wss://user@gateway.discord.gg/",
			"wss://gateway.discord.gg:444/",
			"wss://gateway.discord.gg/other",
			"wss://gateway.discord.gg.evil.example/",
		]) expect(() => discordGatewayUrl(value), value).toThrow("untrusted Gateway URL");
	});

	test("pins one reference revision and every claimed invariant has a complete mapping", () => {
		expect(spec.schemaVersion).toBe(1);
		expect(spec.reference.repository).toMatch(/^https:\/\//);
		expect(spec.reference.commit).toMatch(/^[0-9a-f]{40}$/);
		expect(spec.reference.scope).toBe("packages/coding-agent/src/messenger");
		expect(spec.invariants.length).toBeGreaterThanOrEqual(10);
		expect(new Set(spec.invariants.map(item => item.id)).size).toBe(spec.invariants.length);

		for (const item of spec.invariants) {
			for (const field of requiredFields) expect(item[field], `${item.id}.${field}`).toBeTruthy();
			expect(item.referenceSource.path, item.id).toStartWith(`${spec.reference.scope}/`);
			expect(item.referenceSource.anchor, item.id).toMatch(/^L\d+(?:-L?\d+)?#[A-Za-z_$][\w$]*$/);
			expect(item.observableBehavior.length, item.id).toBeGreaterThan(40);
			expect(item.permittedDifference.length, item.id).toBeGreaterThan(10);
		}
	});

	test("fails closed when a local implementation or focused test target does not exist", async () => {
		for (const item of spec.invariants) {
			for (const target of [item.jeoBoundary, item.focusedProof]) {
				expect(path.isAbsolute(target.path), `${item.id} target must be repository-relative`).toBe(false);
				expect(target.path.includes(".."), `${item.id} target must stay in the repository`).toBe(false);
			}

			const implementation = await fs.readFile(path.join(root, item.jeoBoundary.path), "utf8");
			expect(implementation, `${item.id} implementation symbol`).toContain(item.jeoBoundary.symbol);
			const proof = await fs.readFile(path.join(root, item.focusedProof.path), "utf8");
			expect(proof, `${item.id} focused assertion`).toContain(item.focusedProof.assertion);
		}
	});
});
