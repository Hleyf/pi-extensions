#!/usr/bin/env node
//
// check-configured-paths.mjs
//
// The machine-local half of the load contract.
//
// The suite (`npm run test:contract`) asserts the contract this repository
// declares: the root is a loadable Pi package, its entries exist, and its
// modules import. That is the half that is true on every machine, so it
// belongs in CI.
//
// This script asserts the other half, which is true on exactly one machine:
// that the paths THIS machine's Pi configuration points at actually load.
//
// It is opt-in (`npm run check:installed`) and CI never runs it, because a
// check that reads the user's home directory cannot hold in CI.
//
// WHAT IT CHECKS, AND WHY
// Pi resolves a configured path in three ways, and each has its own failure:
//   - a path that does not exist is skipped SILENTLY. The policy is simply
//     not loaded, and nothing says so.
//   - a directory with no Pi manifest and no entry point is handed to the
//     module loader, which fails with "Cannot find module" and kills every
//     agent subprocess before the agent starts. That is the failure this
//     repository had.
//   - a directory whose manifest names entries that do not exist loads the
//     entries it can find and says nothing about the rest.
//
// So this script resolves every configured local path the way Pi resolves it
// and reports what would load nothing, or would fail loudly.
//
// It reads the configuration. It never writes it.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const PROJECT_DIR = process.cwd();

const failures = [];
const notes = [];

function fail(where, message) {
	failures.push(`${where}: ${message}`);
}

function note(message) {
	notes.push(message);
}

/** Pi skips these prefixes: they are installed packages, not local paths. */
function isLocalPath(value) {
	const trimmed = value.trim();
	return !(
		trimmed.startsWith("npm:") ||
		trimmed.startsWith("git:") ||
		trimmed.startsWith("github:") ||
		trimmed.startsWith("http:") ||
		trimmed.startsWith("https:") ||
		trimmed.startsWith("ssh:") ||
		trimmed.startsWith("builtin:")
	);
}

/**
 * Pi treats an extension entry as an override pattern rather than a path
 * when it starts with `!`, `+` or `-`, or when it contains a glob character.
 * Such an entry selects or disables discovered resources; it is not a path
 * that could fail to load.
 */
function isOverridePattern(value) {
	return (
		value.startsWith("!") ||
		value.startsWith("+") ||
		value.startsWith("-") ||
		value.includes("*") ||
		value.includes("?")
	);
}

/** The `pi` manifest of a package.json, or null. */
function readPiManifest(packageJsonPath) {
	try {
		const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
		if (typeof pkg !== "object" || pkg === null || typeof pkg.pi !== "object" || pkg.pi === null) {
			return null;
		}
		const extensions = pkg.pi.extensions;
		if (!Array.isArray(extensions) || !extensions.every((entry) => typeof entry === "string")) {
			return null;
		}
		return { extensions };
	} catch {
		return null;
	}
}

/**
 * The extension entries a directory yields, the way Pi resolves them.
 *
 * Mirrors Pi's own rule: a Pi manifest wins; otherwise an index file; and a
 * directory with neither contributes nothing when it is scanned as an
 * extension directory.
 */
function resolveExtensionEntries(dir) {
	const manifest = readPiManifest(join(dir, "package.json"));
	if (manifest && manifest.extensions.length > 0) {
		return manifest.extensions.map((entry) => resolve(dir, entry));
	}
	for (const index of ["index.ts", "index.js"]) {
		const candidate = join(dir, index);
		if (existsSync(candidate)) return [candidate];
	}
	return null;
}

/** The extension entries a scanned extension directory yields, including its contents. */
function collectAutoExtensionEntries(dir) {
	const rootEntries = resolveExtensionEntries(dir);
	if (rootEntries) return rootEntries;
	const entries = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
		const fullPath = join(dir, entry.name);
		if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".js"))) {
			entries.push(fullPath);
		} else if (entry.isDirectory()) {
			const resolved = resolveExtensionEntries(fullPath);
			if (resolved) entries.push(...resolved);
		}
	}
	return entries;
}

/** The resources a package directory contributes, the way Pi collects them. */
function collectPackageResources(dir) {
	const manifest = readPiManifest(join(dir, "package.json"));
	if (manifest) {
		return {
			entries: manifest.extensions.map((entry) => resolve(dir, entry)),
			declared: manifest.extensions,
		};
	}
	for (const resourceType of ["extensions", "skills", "prompts", "themes"]) {
		if (existsSync(join(dir, resourceType))) {
			return { entries: [], declared: [] };
		}
	}
	return null;
}

/** True when `path` is inside this repository. */
function isInsideRepository(path) {
	const rel = relative(REPO_ROOT, path);
	return rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep);
}

/**
 * Import a module of this repository, because a module that does not import
 * does not load.
 */
async function checkModuleImports(entry, label) {
	try {
		const module = await import(pathToFileURL(entry).href);
		if (typeof module.default !== "function") {
			fail(label, `${relative(REPO_ROOT, entry)} does not export a default extension factory`);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		fail(label, `${relative(REPO_ROOT, entry)} does not import: ${message.split("\n")[0]}`);
	}
}

/** Check a configured path that Pi would load as a package. */
async function checkPackagePath(label, path) {
	if (!existsSync(path)) {
		fail(label, "does not exist — Pi skips it silently, so the policy is not loaded");
		return;
	}
	if (statSync(path).isFile()) {
		note(`${label} → a file`);
		return;
	}
	const resources = collectPackageResources(path);
	if (!resources) {
		fail(
			label,
			`has no Pi manifest and no entry point — Pi hands the directory to the module loader and fails with "Cannot find module '${path}'"`,
		);
		return;
	}
	for (const entry of resources.entries) {
		if (!existsSync(entry)) {
			fail(label, `names ${relative(path, entry)}, which does not exist`);
		}
	}
	if (resources.entries.length === 0) {
		note(`${label} → a package with resource directories`);
		return;
	}
	note(`${label} → ${resources.entries.length} extension entr${resources.entries.length === 1 ? "y" : "ies"}`);
	for (const entry of resources.entries) {
		if (isInsideRepository(entry)) await checkModuleImports(entry, label);
	}
}

/** Check a configured path that Pi would load as an extension entry. */
function checkExtensionPath(label, path) {
	if (!existsSync(path)) {
		fail(label, "does not exist — Pi skips it silently, so the extension is not loaded");
		return;
	}
	if (statSync(path).isFile()) {
		note(`${label} → a file`);
		return;
	}
	const entries = collectAutoExtensionEntries(path);
	if (entries.length === 0) {
		fail(label, "yields no extension entry — Pi loads nothing from it");
		return;
	}
	for (const entry of entries) {
		if (!existsSync(entry)) {
			fail(label, `yields ${entry}, which does not exist`);
		}
	}
	note(`${label} → ${entries.length} extension entr${entries.length === 1 ? "y" : "ies"}`);
}

/** Check every local path a settings file configures. */
async function checkSettings(label, settingsPath, baseDir) {
	if (!existsSync(settingsPath)) {
		note(`${label}: no settings file at ${settingsPath}`);
		return;
	}
	let settings;
	try {
		settings = JSON.parse(readFileSync(settingsPath, "utf8"));
	} catch (error) {
		fail(label, `cannot be read: ${error.message}`);
		return;
	}
	for (const key of ["packages", "extensions"]) {
		const entries = settings[key];
		if (!Array.isArray(entries)) continue;
		for (const entry of entries) {
			if (typeof entry !== "string") continue;
			if (!isLocalPath(entry)) {
				note(`${label} ${key}: ${entry} → installed by Pi, not a local path`);
				continue;
			}
			if (key === "extensions" && isOverridePattern(entry)) {
				note(`${label} ${key}: ${entry} → an override pattern, not a path`);
				continue;
			}
			const path = isAbsolute(entry) ? entry : resolve(baseDir, entry);
			if (key === "packages") await checkPackagePath(`${label} packages: ${entry}`, path);
			else checkExtensionPath(`${label} extensions: ${entry}`, path);
		}
	}
}

// --- The run ----------------------------------------------------------------

console.log(`agent directory: ${AGENT_DIR}`);
console.log(`project directory: ${PROJECT_DIR}`);
console.log(`repository: ${REPO_ROOT}`);
console.log("");

await checkSettings("global", join(AGENT_DIR, "settings.json"), AGENT_DIR);
await checkSettings("project", join(PROJECT_DIR, ".pi", "settings.json"), PROJECT_DIR);

// The repository's own root, whether or not it is configured: it must be
// loadable, because pointing a configuration at it is the supported way to
// run these policies from a checkout.
await checkPackagePath("this repository", REPO_ROOT);

for (const noteLine of notes) console.log(`ok   ${noteLine}`);
for (const failure of failures) console.error(`FAIL ${failure}`);

console.log("");
if (failures.length > 0) {
	console.error(`${failures.length} configured path${failures.length === 1 ? "" : "s"} would not load.`);
	process.exitCode = 1;
} else {
	console.log("every configured path loads.");
}
