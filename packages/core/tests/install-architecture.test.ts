// install-architecture.test.ts
//
// Pins the three runtime assumptions these packages' design rests on. If Pi
// ever changes any of them, the packages silently stop being deny-only or
// silently lose their position in the handler chain — both would be invisible
// in normal use, so they are pinned here.
//
// These read the installed Pi runtime under ~/.pi/agent/install/. Each guard
// skips (rather than fails) if the file has moved, so a version upgrade that
// relocates code degrades to "not checked" instead of a permanently red suite.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const RELEASES = join(homedir(), ".pi", "agent", "install", "releases");

function newestRuntimeFile(relative: string): string | undefined {
	if (!existsSync(RELEASES)) return undefined;
	for (const release of readdirSync(RELEASES).sort().reverse()) {
		const candidate = join(RELEASES, release, "node_modules", "@earendil-works", "pi-coding-agent", relative);
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

function readRuntime(relative: string): string | undefined {
	const path = newestRuntimeFile(relative);
	return path === undefined ? undefined : readFileSync(path, "utf8");
}

test("emitToolCall returns on the first truthy block, so no later handler can un-block", () => {
	const source = readRuntime("dist/core/extensions/runner.js");
	if (source === undefined) return;
	const method = /async emitToolCall\(event\)\s*\{[\s\S]*?\n    \}/.exec(source)?.[0];
	assert.ok(method !== undefined, "could not locate emitToolCall in runner.js");
	assert.match(method, /if \(result\.block\)\s*\{\s*return result;/, "first truthy block must return immediately");
	assert.doesNotMatch(method, /block === false|result\.block === false/, "must not treat a falsy block as a decision");
});

test("the agent loop reads only `block` (and `terminate` inside the block branch)", () => {
	const loop = readRuntime("../../pi-agent-core/dist/agent-loop.js");
	if (loop === undefined) return;
	assert.match(loop, /if \(beforeResult\?\.block\)/, "admission must be gated on block alone");
	const guarded = /if \(beforeResult\?\.block\) \{[\s\S]*?\n        \}/.exec(loop)?.[0] ?? "";
	assert.ok(guarded.includes("terminate"), "terminate must only be read inside the block branch");
});

test("packages resolve before local extension entries, so gentle-pi's handler runs first", () => {
	const source = readRuntime("dist/core/package-manager.js");
	if (source === undefined) return;
	const packageIndex = source.indexOf("resolvePackageSources(");
	const localIndex = source.indexOf("resolveLocalEntries(");
	const autoIndex = source.indexOf("addAutoDiscoveredResources(");
	assert.ok(packageIndex > 0 && localIndex > 0 && autoIndex > 0, "could not locate the resource resolution order");
	assert.ok(packageIndex < localIndex, "packages must resolve before local extension entries");
	assert.ok(localIndex < autoIndex, "local entries must resolve before auto-discovered files");
});
