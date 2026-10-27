// prose.test.ts
//
// Prose that mentions a protected branch is not a push.
//
// The protected-branch rule fires on a push COMMAND. A commit message that
// describes the command the policy prevents is prose, and blocking it would
// make the policy unusable for exactly the commits that document it.
//
// This matters in practice: a commit message like "explain why a push to a
// protected branch is refused" contains the words, and a rule that matched
// anywhere in the command string would refuse the commit that explains it.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadPolicy } from "pi-policy-core";
import { classify } from "../src/extension.ts";

// Isolate from the user's own policy so the packaged default is what is
// under test, and so the suite works on a machine with no ~/.pi at all.
const isolatedAgentDir = mkdtempSync(join(tmpdir(), "pi-git-policy-prose-"));
process.env.PI_AGENT_DIR = isolatedAgentDir;

after(() => {
	rmSync(isolatedAgentDir, { recursive: true, force: true });
});

const packagedPolicyDir = new URL("../policies/", import.meta.url).pathname;
const policies = { git: loadPolicy("git", packagedPolicyDir) };

// A directory that is not a git repository, so the branch lock fails open for
// the purely static cases below.
const neutralDir = mkdtempSync(join(tmpdir(), "pi-git-policy-prose-neutral-"));

test("a commit message naming the refused command is not blocked", async () => {
	const command = 'git commit -m "docs: explain why a push to a protected branch is refused"';
	assert.equal((await classify(command, policies, { cwd: neutralDir })).tier, "silent");
});

test("a commit message naming protected branches is not blocked", async () => {
	const command = 'git commit -m "lock main and master"';
	assert.equal((await classify(command, policies, { cwd: neutralDir })).tier, "silent");
});

test("an actual push to a protected branch is still blocked", async () => {
	assert.equal((await classify("git push origin main", policies, { cwd: neutralDir })).tier, "block");
});

test("a push to a protected branch is still blocked after other commands", async () => {
	assert.equal((await classify("git status && git push origin main", policies, { cwd: neutralDir })).tier, "block");
});
