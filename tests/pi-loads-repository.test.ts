// pi-loads-repository.test.ts
//
// The end-to-end version of the load contract: Pi's OWN loader, pointed at
// this repository the way a machine's configuration points at it, must
// resolve the extensions and report no errors.
//
// load-contract.test.ts states the rules as this repository understands them.
// This one asks Pi. It is the test that fails on the day somebody restructures
// this repository into a shape Pi cannot load — which is exactly the day the
// workspace monorepo arrived.
//
// The loader is given a scratch agent directory whose settings name this
// repository as a package, so the test reads nothing outside the repository
// and nothing of the developer's own configuration: it holds in CI.
//
// The extensions are loaded through Pi's jiti-based loader, so this test also
// proves that a TypeScript extension entry is loadable by Pi — not merely
// importable by Node.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

const REPO_ROOT = resolve(import.meta.dirname, "..");

const EXPECTED_EXTENSIONS = [
	join(REPO_ROOT, "packages/bash-policy/src/extension.ts"),
	join(REPO_ROOT, "packages/git-policy/src/extension.ts"),
].sort();

test("Pi loads this repository as a package, with both extensions and no errors", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-load-contract-"));
	try {
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ packages: [REPO_ROOT] }, null, 2),
			"utf8",
		);

		const settingsManager = SettingsManager.create(REPO_ROOT, agentDir, { projectTrusted: false });
		const loader = new DefaultResourceLoader({
			cwd: REPO_ROOT,
			agentDir,
			settingsManager,
			extensionFactories: [],
		});
		await loader.reload();

		const result = loader.getExtensions();

		assert.deepEqual(
			result.errors.map((error) => `${error.path}: ${error.error}`),
			[],
			"Pi must load this repository without errors",
		);
		assert.deepEqual(
			result.extensions.map((extension) => extension.path).sort(),
			EXPECTED_EXTENSIONS,
			"Pi must resolve exactly the extensions the root manifest names",
		);
		for (const extension of result.extensions) {
			assert.ok(
				(extension.handlers.get("tool_call")?.length ?? 0) > 0,
				`${extension.path} must register a tool_call handler`,
			);
		}
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});
