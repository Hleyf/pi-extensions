// load-contract.test.ts
//
// The repository is a loadable Pi package, and this file is the guard that
// keeps it that way.
//
// THE FAILURE THIS GUARDS AGAINST
// The repository was restructured into an npm workspace monorepo. The global
// Pi configuration still pointed at the workspace root, which is a directory
// with neither an entry point nor a manifest, so Pi handed the directory
// itself to the module loader. Every agent subprocess died before the agent
// started:
//
//   Error: Failed to load extension "/home/hleyf/Projects/pi-extensions":
//   Failed to load extension: Cannot find module '/home/hleyf/Projects/pi-extensions'
//
// A suite that only asserted "the policies still behave" would not have
// caught that: the policies were fine. What broke was the way the repository
// is LOADED, so that is what this file asserts.
//
// THE CONTRACT
//   1. The root package.json carries a `pi` manifest naming the extensions
//      this workspace ships.
//   2. Every named entry exists on disk, inside this repository.
//   3. The root names exactly the union of the workspace packages' manifests:
//      nothing is declared twice, nothing is missing.
//   4. Every entry module imports cleanly and exports an extension factory —
//      the same import Pi performs, with the same module graph.
//   5. The root resolves as a module, so "Cannot find module" is impossible
//      for this path even if a loader ignores the manifest.
//
// These tests are machine-independent: they read this repository and nothing
// else. The machine-local question — "does the configuration on THIS machine
// point at something that loads?" — is a separate opt-in check
// (`npm run check:installed`), because a test that reads the user's home
// directory fails in CI.
//
// Spec: docs/load-contract.md.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const ROOT_PACKAGE = join(REPO_ROOT, "package.json");

interface PiManifest {
	extensions: string[];
}

/** Read the `pi` manifest of a package.json, tolerating its absence. */
function readManifest(packageJsonPath: string): PiManifest {
	const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { pi?: { extensions?: unknown } };
	const extensions = pkg.pi?.extensions;
	if (!Array.isArray(extensions)) return { extensions: [] };
	return { extensions: extensions.filter((entry): entry is string => typeof entry === "string") };
}

/** The workspace package directories, in a stable order. */
function workspacePackages(): string[] {
	const packagesDir = join(REPO_ROOT, "packages");
	return readdirSync(packagesDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => join(packagesDir, entry.name))
		.sort();
}

/** True when `path` is inside this repository. */
function isInsideRepository(path: string): boolean {
	const rel = relative(REPO_ROOT, path);
	return rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep);
}

test("the root package declares a Pi manifest", () => {
	const manifest = readManifest(ROOT_PACKAGE);
	assert.ok(
		manifest.extensions.length > 0,
		"the root package.json must carry a `pi` manifest with a non-empty extensions[]",
	);
});

test("every extension entry the root names exists inside the repository", () => {
	const { extensions } = readManifest(ROOT_PACKAGE);
	assert.ok(extensions.length > 0, "nothing to check: the root declares no extensions");
	for (const entry of extensions) {
		const resolved = resolve(REPO_ROOT, entry);
		assert.ok(existsSync(resolved), `the root manifest names ${entry}, which does not exist`);
		assert.ok(statSync(resolved).isFile(), `the root manifest names ${entry}, which is not a file`);
		assert.ok(isInsideRepository(resolved), `the root manifest names ${entry}, which is outside the repository`);
	}
});

test("the root declares exactly the extensions the workspace packages ship", () => {
	const rootEntries = readManifest(ROOT_PACKAGE).extensions;
	assert.equal(
		new Set(rootEntries).size,
		rootEntries.length,
		"the root manifest names the same extension twice",
	);

	const shipped = new Set<string>();
	for (const packageDir of workspacePackages()) {
		const manifest = readManifest(join(packageDir, "package.json"));
		for (const entry of manifest.extensions) {
			const resolved = resolve(packageDir, entry);
			assert.ok(
				existsSync(resolved),
				`${packageDir} names ${entry}, which does not exist`,
			);
			shipped.add(resolved);
		}
	}

	const declared = rootEntries.map((entry) => resolve(REPO_ROOT, entry));
	assert.deepEqual(
		[...new Set(declared)].sort(),
		[...shipped].sort(),
		"the root manifest and the workspace packages must name the same extensions",
	);
});

test("every extension entry imports cleanly and exports a factory", async () => {
	const { extensions } = readManifest(ROOT_PACKAGE);
	assert.ok(extensions.length > 0, "nothing to check: the root declares no extensions");
	for (const entry of extensions) {
		const resolved = resolve(REPO_ROOT, entry);
		const module = await import(pathToFileURL(resolved).href);
		assert.equal(
			typeof module.default,
			"function",
			`${entry} must export a default extension factory, or Pi cannot load it`,
		);
	}
});

test("the root resolves as a module, so the load failure cannot happen", () => {
	const require = createRequire(ROOT_PACKAGE);
	const resolved = require.resolve(REPO_ROOT);
	assert.ok(existsSync(resolved), "the root must resolve to a file that exists");
	assert.ok(isInsideRepository(resolved), "the root must resolve to a file inside the repository");
});
