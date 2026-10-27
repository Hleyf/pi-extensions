// scratch-waiver.test.ts
//
// Pins the scratch-deletion contract in docs/scratch-deletion.md to what
// gentle-pi actually does.
//
// The "Allow recognized data-loss command?" dialog for a recursive delete comes
// from gentle-pi's destructive-command recogniser, not from these packages: the
// tool_call layer is deny-only, so no extension can lift a confirmation another
// layer raised. The only lever is the shape of the command, and gentle-pi's
// YOLO temp-scratch waiver recognises exactly one shape.
//
// If gentle-pi changes that rule, the documentation goes stale and agents
// start getting a dialog they were told they would not. This test catches that.
//
// If gentle-pi is absent or bun is unavailable, these tests skip rather than
// fail: they guard documentation against drift, not behaviour we own.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HERE = import.meta.dirname;
const PROBE = join(HERE, "scratch-waiver-probe.mjs");
const DOC = join(HERE, "..", "..", "docs", "scratch-deletion.md");
const GENTLE_LIB = join(homedir(), ".pi", "agent", "npm", "node_modules", "gentle-pi", "lib");

type Verdicts = Record<string, boolean>;

let verdicts: Verdicts | undefined;
try {
	if (!existsSync(PROBE) || !existsSync(GENTLE_LIB)) throw new Error("unavailable");
	verdicts = JSON.parse(execFileSync("bun", ["run", PROBE], { encoding: "utf8" })) as Verdicts;
} catch {
	verdicts = undefined;
}

const PROMPT_FREE: Array<[string, string]> = [
	["mktemp_dir_alone", "rm -rf <mktemp dir>"],
	["mktemp_dir_first_in_chain", "rm -rf <mktemp dir> && …"],
	["symlink_removed", "rm -rf <symlink>"],
	["recursive_rm_before_rm_f", "rm -rf <mktemp dir> && rm -f <file>"],
];

const STILL_PROMPTS: Array<[string, string]> = [
	["cd_prefix", "cd /tmp && rm -rf <mktemp dir>"],
	["relative_path", "rm -rf tmp.XXXXXX"],
	["descriptive_name", "rm -rf /tmp/rules-probe"],
	["pipe_after", "rm -rf <mktemp dir> | tee …"],
	["redirect_on_rm_line", "rm -rf <mktemp dir> 2>/dev/null"],
	["rm_f_before_recursive_rm", "rm -f <file> && rm -rf <mktemp dir>"],
];

test("the documented command shapes are prompt-free", () => {
	if (verdicts === undefined) return;
	for (const [key, label] of PROMPT_FREE) {
		assert.equal(verdicts[key], true, `${label} should be waivable`);
	}
});

test("the documented counter-examples still prompt", () => {
	if (verdicts === undefined) return;
	for (const [key, label] of STILL_PROMPTS) {
		assert.equal(verdicts[key], false, `${label} should not be waivable`);
	}
});

test("removing a single file never raises the dialog", () => {
	if (verdicts === undefined) return;
	assert.equal(verdicts.file_without_recursive_flag, false, "rm -f <file> must stay silent");
});

test("the documentation states the scratch contract", () => {
	if (!existsSync(DOC)) return;
	const doc = readFileSync(DOC, "utf8");
	assert.match(doc, /mktemp -d -p \/tmp tmp\.XXXXXX/, "must document the mktemp creation form");
	assert.match(doc, /ln -s \/tmp\/tmp\.AGfpoG \/tmp\/rules-probe/, "must document the symlink handle");
	assert.match(doc, /rm -rf \/tmp\/tmp\.AGfpoG && rm -f \/tmp\/rules-probe/, "must document the deletion shape");
	assert.match(doc, /must contain nothing but the `rm` and its targets/, "must document the redirect rule");
	assert.match(doc, /must be the first `rm` in the chain/, "must document the chain-order rule");
	assert.match(doc, /`tmp\.`\s+plus\s+letters\s+and\s+digits/, "must document the directory name rule");
});
