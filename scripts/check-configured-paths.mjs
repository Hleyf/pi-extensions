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
//
// IT IMPORTS WHAT IT CHECKS
// A module that does not import does not load, and Pi says so at startup.
// Checking that means importing the extension, exactly as Pi does, so this
// script runs the extension's module-level code. Run it when that is fine.
//
// THE RULES ARE MIRRORED, NOT GUESSED
// Every rule below is a mirror of Pi's own resolution, read from
// `dist/core/package-manager.js` and `dist/core/pi-manifest.js` in the
// installed Pi. Where the mirror is deliberately stricter than Pi, it says
// so: a manifest naming an entry that does not exist is reported, because Pi
// skips it silently and a policy that silently is not loaded is not loaded.

import { existsSync, globSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const PROJECT_DIR = process.cwd();
/** Pi resolves project-scope entries against the project's own `.pi` directory. */
const PROJECT_BASE_DIR = join(PROJECT_DIR, ".pi");

const failures = [];
const notes = [];

function fail(where, message) {
	failures.push(`${where}: ${message}`);
}

function note(message) {
	notes.push(message);
}

// --- Pi's rules, mirrored ---------------------------------------------------

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

/** Pi's override-pattern prefixes: they select, they do not name a file. */
function isOverridePattern(value) {
	return value.startsWith("!") || value.startsWith("+") || value.startsWith("-");
}

function hasGlobPattern(value) {
	return value.includes("*") || value.includes("?");
}

/** Pi's path normalisation: a leading `~` and a `file://` URL both expand. */
function normalizePath(value) {
	if (value.startsWith("file://")) return fileURLToPath(value);
	if (value === "~") return homedir();
	if (value.startsWith("~/")) return join(homedir(), value.slice(2));
	return value;
}

/**
 * The `pi` manifest of a package.json, or null.
 *
 * Mirrors Pi's readPiManifest: the manifest exists as soon as `pi` is an
 * object, even when it names no extensions. A package with `pi: {}` is a
 * package to Pi, and it never reaches the module loader.
 */
function readPiManifest(packageJsonPath) {
	let pkg;
	try {
		pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
	} catch {
		return null;
	}
	if (typeof pkg !== "object" || pkg === null || typeof pkg.pi !== "object" || pkg.pi === null) {
		return null;
	}
	const manifest = {};
	for (const field of ["extensions", "skills", "prompts", "themes"]) {
		const entries = pkg.pi[field];
		if (Array.isArray(entries) && entries.every((entry) => typeof entry === "string")) {
			manifest[field] = entries;
		}
	}
	return manifest;
}

/**
 * The extension entries a directory yields when Pi scans it.
 *
 * Mirrors Pi's resolveExtensionEntries: the manifest wins, but only with the
 * entries that exist; otherwise an index file; otherwise nothing.
 */
function resolveExtensionEntries(dir) {
	const manifest = readPiManifest(join(dir, "package.json"));
	if (manifest?.extensions?.length) {
		const entries = [];
		for (const entry of manifest.extensions) {
			const resolved = resolve(dir, entry);
			if (existsSync(resolved)) entries.push(resolved);
		}
		if (entries.length > 0) return entries;
	}
	for (const index of ["index.ts", "index.js"]) {
		const candidate = join(dir, index);
		if (existsSync(candidate)) return [candidate];
	}
	return null;
}

/**
 * The extension entries a scanned extension directory yields, its own
 * contents included.
 *
 * Mirrors Pi's collectAutoExtensionEntries, without the ignore-file rules it
 * applies to the user's own extension directories.
 */
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

/** Mirrors Pi's collectFilesFromPaths: a file is itself, a directory is scanned. */
function collectFilesFromPaths(paths) {
	const files = [];
	for (const path of paths) {
		if (!existsSync(path)) continue;
		const stats = statSync(path);
		if (stats.isFile()) files.push(path);
		else if (stats.isDirectory()) files.push(...collectAutoExtensionEntries(path));
	}
	return files;
}

/** Mirrors Pi's expandPackageGlob: a glob, resolved under the package root. */
function expandGlob(pattern, root) {
	let matches;
	try {
		matches = globSync(pattern, { cwd: root });
	} catch {
		return [];
	}
	return matches
		.map((match) => resolve(root, match))
		.filter((path) =>
			relative(root, path)
				.split(sep)
				.every((segment) => segment === ".." || !segment.startsWith(".")),
		)
		.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The files a manifest's entries name.
 *
 * Mirrors Pi's collectFilesFromManifestEntries: override patterns select
 * rather than name, and a glob expands under the package root.
 */
function collectFilesFromManifestEntries(entries, root) {
	const sources = entries.filter((entry) => !isOverridePattern(entry));
	const resolved = sources.flatMap((entry) =>
		hasGlobPattern(entry) ? expandGlob(entry, root) : [resolve(root, entry)],
	);
	return collectFilesFromPaths(resolved);
}

/**
 * The file a directory resolves to when it is handed to the module loader.
 *
 * Pi hands a package directory with no manifest and no resource directories
 * to the module loader, which resolves it the way Node resolves a directory:
 * the package's `main`, then an index file. `exports` is not consulted for
 * a path, so a directory with only `exports` does not resolve.
 */
function directoryModuleTarget(dir) {
	let main;
	try {
		main = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).main;
	} catch {
		main = undefined;
	}
	if (typeof main === "string") {
		const resolved = resolve(dir, main);
		if (existsSync(resolved)) return resolved;
	}
	for (const index of ["index.js", "index.ts", "index.json", "index.node"]) {
		const candidate = join(dir, index);
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

/** What Pi makes of a package directory. */
function inspectPackageDirectory(dir) {
	const manifest = readPiManifest(join(dir, "package.json"));
	if (manifest !== null) {
		const entries = manifest.extensions ?? [];
		const missing = entries.filter(
			(entry) =>
				!isOverridePattern(entry) &&
				!hasGlobPattern(entry) &&
				!existsSync(resolve(dir, entry)),
		);
		return {
			kind: "manifest",
			files: collectFilesFromManifestEntries(entries, dir),
			missing,
			patterns: entries.filter(isOverridePattern),
		};
	}
	for (const resourceType of ["extensions", "skills", "prompts", "themes"]) {
		if (existsSync(join(dir, resourceType))) {
			return { kind: "resource-dir", files: [], resourceType };
		}
	}
	return { kind: "module", files: [], moduleTarget: directoryModuleTarget(dir) };
}

// --- The checks -------------------------------------------------------------

/** True when `path` is inside this repository. */
function isInsideRepository(path) {
	const rel = relative(REPO_ROOT, path);
	return rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep);
}

/**
 * Import a module the way Pi imports it, because a module that does not
 * import does not load.
 */
async function checkModuleImports(file, label) {
	try {
		const module = await import(pathToFileURL(file).href);
		if (typeof module.default !== "function") {
			fail(label, `${file} does not export a default extension factory, so Pi cannot load it`);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		fail(label, `${file} does not import: ${message.split("\n")[0]}`);
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
		await checkModuleImports(path, label);
		return;
	}

	const inspected = inspectPackageDirectory(path);

	if (inspected.kind === "manifest") {
		for (const entry of inspected.missing) {
			fail(
				label,
				`names ${entry}, which does not exist — Pi skips it silently, so the policy is not loaded`,
			);
		}
		for (const pattern of inspected.patterns) {
			note(`${label} → ${pattern} selects resources by pattern`);
		}
		note(`${label} → a package with ${inspected.files.length} extension entr${inspected.files.length === 1 ? "y" : "ies"}`);
		for (const file of inspected.files) await checkModuleImports(file, label);
		return;
	}

	if (inspected.kind === "resource-dir") {
		const files = collectFilesFromPaths([join(path, "extensions")]);
		note(`${label} → a package with an ${inspected.resourceType} directory`);
		for (const file of files) await checkModuleImports(file, label);
		return;
	}

	if (inspected.moduleTarget === null) {
		fail(
			label,
			`has no Pi manifest and no entry point — Pi hands the directory to the module loader and fails with "Cannot find module '${path}'"`,
		);
		return;
	}
	note(`${label} → a module (${inspected.moduleTarget})`);
	await checkModuleImports(inspected.moduleTarget, label);
}

/** Check a configured path that Pi would load as an extension entry. */
async function checkExtensionPath(label, path) {
	if (!existsSync(path)) {
		fail(label, "does not exist — Pi skips it silently, so the extension is not loaded");
		return;
	}
	if (statSync(path).isFile()) {
		note(`${label} → a file`);
		await checkModuleImports(path, label);
		return;
	}
	const entries = collectAutoExtensionEntries(path);
	if (entries.length === 0) {
		fail(label, "yields no extension entry — Pi loads nothing from it");
		return;
	}
	note(`${label} → ${entries.length} extension entr${entries.length === 1 ? "y" : "ies"}`);
	for (const entry of entries) await checkModuleImports(entry, label);
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
		for (const raw of entries) {
			// A package entry may be a string or an object carrying its source.
			const entry = typeof raw === "string" ? raw : raw?.source;
			if (typeof entry !== "string") {
				fail(label, `${key} holds an entry that names no source: ${JSON.stringify(raw)}`);
				continue;
			}
			if (!isLocalPath(entry)) {
				note(`${label} ${key}: ${entry} → installed by Pi, not a local path`);
				continue;
			}
			if (key === "extensions" && isOverridePattern(entry)) {
				note(`${label} ${key}: ${entry} → an override pattern, not a path`);
				continue;
			}
			const normalized = normalizePath(entry);
			const path = isAbsolute(normalized) ? normalized : resolve(baseDir, normalized);
			if (key === "packages") await checkPackagePath(`${label} packages: ${entry}`, path);
			else await checkExtensionPath(`${label} extensions: ${entry}`, path);
		}
	}
}

// --- The run ----------------------------------------------------------------

console.log(`agent directory: ${AGENT_DIR}`);
console.log(`project directory: ${PROJECT_DIR}`);
console.log(`repository: ${REPO_ROOT}`);
console.log("");

await checkSettings("global", join(AGENT_DIR, "settings.json"), AGENT_DIR);
await checkSettings("project", join(PROJECT_DIR, ".pi", "settings.json"), PROJECT_BASE_DIR);

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
