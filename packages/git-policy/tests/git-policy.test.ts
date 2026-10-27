// git-policy.test.ts
//
// Tests for the pi-git-policy package.
//
// These tests read the PACKAGED policy (packages/git-policy/policies/git.json),
// never the user's personal one, so they are deterministic and work in CI.
// The user policy directory is pointed at an empty temporary directory for the
// duration of the file, which is what makes the packaged default the policy
// under test.
//
// The branch-lock tests need REAL temporary git repositories, because the
// whole point of the lock is reading the current branch of a directory.
//
// Spec: packages/git-policy/README.md — the protected-branch push, the hidden
// argument rule, and the branch lock.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadPolicy } from "pi-policy-core";
import gitPolicy, { classify, createHandler } from "../src/extension.ts";

// --- Isolation from the user's own policy ----------------------------------

// The core resolves a user override at $PI_AGENT_DIR/policies. Pointing it at
// an empty directory makes the packaged default the policy under test, and it
// keeps the tests away from ~/.pi.
const isolatedAgentDir = mkdtempSync(join(tmpdir(), "pi-git-policy-agent-"));
process.env.PI_AGENT_DIR = isolatedAgentDir;

// A directory that is not a git repository, so the branch lock fails open for
// the purely static cases below.
const neutralDir = mkdtempSync(join(tmpdir(), "pi-git-policy-neutral-"));

after(() => {
	rmSync(isolatedAgentDir, { recursive: true, force: true });
	rmSync(neutralDir, { recursive: true, force: true });
});

const packagedPolicyDir = fileURLToPath(new URL("../policies/", import.meta.url));
const policies = { git: loadPolicy("git", packagedPolicyDir) };

/** Classify a command against the packaged policy, from a non-repository. */
function classifyStatic(command: string) {
	return classify(command, policies, { cwd: neutralDir });
}

// --- Protected-branch spellings --------------------------------------------
// The gap that justifies this package: gentle-pi has no protected-branch
// concept, and an ordinary `git push origin main` is barely more than a
// confirmation there.

const PROTECTED_SPELLINGS: Array<[string, string]> = [
	["git push origin main", "plain"],
	["git push origin master", "plain"],
	["git push -u origin main", "after -u flag"],
	["git push --set-upstream origin main", "long flag"],
	["git push origin HEAD:main", "HEAD: refspec"],
	["git push origin main:refs/heads/main", "full refspec"],
	["git push origin +main", "forced refspec"],
	['git push origin "main"', "double quoted"],
	["git push origin 'main'", "single quoted"],
	["git push --all origin", "--all pushes every branch"],
	["git push --mirror origin", "--mirror pushes everything"],
	["git -C /other/repo push origin main", "git -C"],
	["git -c core.hooksPath=/dev/null push origin main", "git -c"],
	["cd /tmp && git push origin main", "after cd"],
	["git status && git push origin main", "after &&"],
	["git push origin main; git status", "before ;"],
	["git push origin main | cat", "before pipe"],
	["\n\t   git push origin main", "leading whitespace and tabs"],
	["git   push    origin main", "repeated inner whitespace"],
	["echo ok && git push origin master", "protected branch after &&"],
	["git status; git push --force origin main", "force push hidden after ;"],
];

for (const [command, why] of PROTECTED_SPELLINGS) {
	test(`protected branch blocked: ${JSON.stringify(command)} — ${why}`, async () => {
		const decision = await classifyStatic(command);
		assert.equal(decision.tier, "block", `expected block, got ${decision.tier}: ${decision.reason ?? ""}`);
	});
}

// --- The protected-branch list is the policy, not the code -----------------

test("a branch that is not in protected_branches is not blocked by default", async () => {
	// The shipped defaults are deliberately generic. "production" and "live"
	// are a personal choice and belong in a user override.
	assert.deepEqual(policies.git.protected_branches, ["main", "master"]);
	const decision = await classifyStatic("git push origin production");
	assert.equal(decision.tier, "silent", decision.reason ?? "");
});

test("a user override of protected_branches changes what is blocked", async () => {
	// The override lives in $PI_AGENT_DIR/policies/git.json and is re-read on
	// every tool call, so an edited override takes effect immediately.
	const overrideDir = mkdtempSync(join(tmpdir(), "pi-git-policy-override-"));
	const previous = process.env.PI_AGENT_DIR;
	try {
		mkdirSync(join(overrideDir, "policies"), { recursive: true });
		const override = JSON.parse(readFileSync(join(packagedPolicyDir, "git.json"), "utf8"));
		// The override REPLACES the list, so "release" becomes protected and
		// "master" is no longer.
		override.protected_branches = ["release"];
		writeFileSync(join(overrideDir, "policies", "git.json"), JSON.stringify(override));
		process.env.PI_AGENT_DIR = overrideDir;

		const handler = createHandler();
		const ctx = { hasUI: false, cwd: neutralDir, ui: { confirm: async () => true } };

		const blocked = await handler(
			{ toolName: "bash", input: { command: "git push origin release" } },
			ctx,
		);
		assert.equal(blocked?.block, true, JSON.stringify(blocked));

		const allowed = await handler(
			{ toolName: "bash", input: { command: "git push origin master" } },
			ctx,
		);
		assert.equal(allowed, undefined, JSON.stringify(allowed));
	} finally {
		process.env.PI_AGENT_DIR = previous;
		rmSync(overrideDir, { recursive: true, force: true });
	}
});

// --- Evasions --------------------------------------------------------------
// These are the ways to defeat a literal pattern match.

const EVASIONS: Array<[string, string]> = [
	["P=main; git push origin $P", "variable"],
	["P=main && git push origin $P", "variable after &&"],
	["git push origin $(git rev-parse HEAD)", "command substitution"],
	["git push origin `git rev-parse --abbrev-ref HEAD`", "backtick substitution"],
	["git push origin 'ma''in'", "adjacent quote concatenation"],
	["git -c core.quotePath=false push origin $TARGET", "hidden target after git -c"],
];

for (const [command, why] of EVASIONS) {
	test(`indirection blocked: ${JSON.stringify(command)} — ${why}`, async () => {
		const decision = await classifyStatic(command);
		assert.equal(decision.tier, "block", `expected block, got ${decision.tier}: ${decision.reason ?? ""}`);
	});
}

// --- Not over-blocked ------------------------------------------------------
// The gate is useless if it blocks ordinary work.

const NON_PROTECTED: Array<[string, string]> = [
	["git push origin feature/thing", "feature branch"],
	["git push origin mainline", "main must not match as a prefix"],
	["git push origin main-branch", "main-branch is not main"],
	["git push origin domain", "main inside another word"],
	["git log --oneline", "read-only"],
	["git status", "read-only"],
	["git diff --stat", "read-only"],
	["git log HEAD^", "^ is a git revision, not shell indirection"],
	['git commit -m "fix the parser"', "quoted commit message is ordinary"],
	['git checkout "main"', "local ref motion, not a protected-branch push"],
	["git merge $BRANCH", "local ref motion is reflog-recoverable and cannot reach a remote"],
	["git add .", "staging"],
	["git show abc123", "read-only"],
	["git rev-parse HEAD", "read-only"],
];

for (const [command, why] of NON_PROTECTED) {
	test(`not over-blocked: ${JSON.stringify(command)} — ${why}`, async () => {
		const decision = await classifyStatic(command);
		assert.equal(decision.tier, "silent", `expected silent, got ${decision.tier}: ${decision.reason ?? ""}`);
	});
}

// --- The branch lock: real repositories ------------------------------------

function makeRepo(branch: string): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-git-policy-repo-"));
	const git = (...args: string[]) =>
		execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], {
			cwd: dir,
			stdio: "pipe",
		});
	git("init", "-q");
	git("checkout", "-q", "-b", branch);
	writeFileSync(join(dir, "file.txt"), "content\n");
	git("add", ".");
	git("commit", "-qm", "initial");
	return dir;
}

/**
 * Must be async: a synchronous `finally` would delete the repository while the
 * async assertion is still running, which silently turns the git checks into
 * fail-open passes and makes the whole file flaky.
 */
async function withRepo(branch: string, fn: (dir: string) => Promise<void>): Promise<void> {
	const dir = makeRepo(branch);
	try {
		await fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("commit is blocked on main", () =>
	withRepo("main", async (dir) => {
		const decision = await classify("git commit -m 'wip'", policies, { cwd: dir });
		assert.equal(decision.tier, "block", decision.reason ?? "");
		assert.match(String(decision.reason), /protected branch/i);
	}));

test("commit is blocked on master", () =>
	withRepo("master", async (dir) => {
		const decision = await classify("git commit -m 'wip'", policies, { cwd: dir });
		assert.equal(decision.tier, "block", decision.reason ?? "");
	}));

test("commit is allowed on a feature branch", () =>
	withRepo("feature/login", async (dir) => {
		const decision = await classify("git commit -m 'wip'", policies, { cwd: dir });
		assert.equal(decision.tier, "silent", decision.reason ?? "");
	}));

test("a first commit to an unborn protected branch is blocked", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-git-policy-empty-"));
	try {
		execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "pipe" });
		const unborn = execFileSync("git", ["symbolic-ref", "--short", "HEAD"], {
			cwd: dir,
			encoding: "utf8",
		}).trim();
		const decision = await classify("git commit -m 'first'", policies, { cwd: dir });
		// An unborn HEAD still points at its branch, so the first commit in a repo
		// initialised on main creates main and is locked like any other.
		const expected = (policies.git.protected_branches ?? []).includes(unborn) ? "block" : "silent";
		assert.equal(decision.tier, expected, `unborn=${unborn}`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("commit outside any git repository is not blocked", async () => {
	const decision = await classify("git commit -m 'x'", policies, { cwd: neutralDir });
	assert.notEqual(decision.tier, "block", decision.reason ?? "");
});

test("bare push is blocked on main", () =>
	withRepo("main", async (dir) => {
		const decision = await classify("git push", policies, { cwd: dir });
		assert.equal(decision.tier, "block", decision.reason ?? "");
	}));

test("push with only a remote is blocked on main", () =>
	withRepo("main", async (dir) => {
		const decision = await classify("git push origin", policies, { cwd: dir });
		assert.equal(decision.tier, "block", decision.reason ?? "");
	}));

test("push -u origin is blocked on main", () =>
	withRepo("main", async (dir) => {
		const decision = await classify("git push -u origin", policies, { cwd: dir });
		assert.equal(decision.tier, "block", decision.reason ?? "");
	}));

test("bare push is allowed on a feature branch", () =>
	withRepo("feature/login", async (dir) => {
		const decision = await classify("git push", policies, { cwd: dir });
		assert.equal(decision.tier, "silent", decision.reason ?? "");
	}));

test("push to an explicitly named feature branch is allowed even from main", () =>
	withRepo("main", async (dir) => {
		const decision = await classify("git push origin feature/login", policies, { cwd: dir });
		assert.equal(decision.tier, "silent", decision.reason ?? "");
	}));

test("push --tags is allowed from main because it moves tags, not the branch", () =>
	withRepo("main", async (dir) => {
		const decision = await classify("git push --tags", policies, { cwd: dir });
		assert.equal(decision.tier, "silent", decision.reason ?? "");
	}));

test("push --follow-tags is allowed from main because it moves tags, not the branch", () =>
	withRepo("main", async (dir) => {
		const decision = await classify("git push --follow-tags", policies, { cwd: dir });
		assert.equal(decision.tier, "silent", decision.reason ?? "");
	}));

test("checkout of a protected branch stays allowed", () =>
	withRepo("main", async (dir) => {
		const decision = await classify("git checkout main", policies, { cwd: dir });
		assert.equal(decision.tier, "silent", decision.reason ?? "");
	}));

test("branch listing and diff stay allowed on main", () =>
	withRepo("main", async (dir) => {
		for (const command of ["git status", "git log --oneline", "git diff --stat", "git branch -a"]) {
			const decision = await classify(command, policies, { cwd: dir });
			assert.equal(decision.tier, "silent", `${command}: ${decision.reason ?? ""}`);
		}
	}));

// --- The branch lock must track cd and git -C ------------------------------

test("a compound command is judged per segment directory", async () => {
	const mainRepo = makeRepo("main");
	const featureRepo = makeRepo("feature/safe");
	try {
		// The current directory is on main, but the commit happens in the
		// feature repo.
		const safe = await classify(`cd ${featureRepo} && git commit -m 'wip'`, policies, {
			cwd: mainRepo,
		});
		assert.equal(safe.tier, "silent", "committing in a feature checkout must not inherit main's lock");

		const unsafe = await classify(`cd ${mainRepo} && git commit -m 'wip'`, policies, {
			cwd: featureRepo,
		});
		assert.equal(unsafe.tier, "block", "cd into the main checkout must still be locked");
	} finally {
		rmSync(mainRepo, { recursive: true, force: true });
		rmSync(featureRepo, { recursive: true, force: true });
	}
});

test("git -C selects the directory whose branch is checked", async () => {
	const mainRepo = makeRepo("main");
	const featureRepo = makeRepo("feature/safe");
	try {
		const blocked = await classify(`git -C ${mainRepo} commit -m x`, policies, { cwd: featureRepo });
		assert.equal(blocked.tier, "block", blocked.reason ?? "");
		const allowed = await classify(`git -C ${featureRepo} commit -m x`, policies, { cwd: mainRepo });
		assert.equal(allowed.tier, "silent", allowed.reason ?? "");
	} finally {
		rmSync(mainRepo, { recursive: true, force: true });
		rmSync(featureRepo, { recursive: true, force: true });
	}
});

// --- The handler contract --------------------------------------------------

function ctxStub(hasUI: boolean, approve = false) {
	return {
		hasUI,
		cwd: neutralDir,
		ui: {
			confirm: async () => approve,
			notify: () => {},
		},
	};
}

test("the handler blocks a protected-branch push", async () => {
	const handler = createHandler();
	const result = await handler(
		{ toolName: "bash", input: { command: "git push origin main" } },
		ctxStub(false),
	);
	assert.equal(result?.block, true, JSON.stringify(result));
	assert.match(String(result?.reason), /protected branch/i);
});

test("the handler returns undefined for an allowed command", async () => {
	const handler = createHandler();
	const result = await handler({ toolName: "bash", input: { command: "git status" } }, ctxStub(false));
	assert.equal(result, undefined, "silent must be undefined, never { block: false }");
});

test("the handler never returns { block: false }", async () => {
	const handler = createHandler();
	for (const command of ["git status", "git push origin main", "git log | head", "git push origin domain"]) {
		const result = await handler({ toolName: "bash", input: { command } }, ctxStub(false));
		assert.ok(
			result === undefined || result.block === true || result.block === undefined,
			`handler returned a falsy block object for ${command}: ${JSON.stringify(result)}`,
		);
	}
});

test("the handler ignores a non-bash tool", async () => {
	const handler = createHandler();
	const result = await handler(
		{ toolName: "read", input: { command: "git push origin main" } },
		ctxStub(false),
	);
	assert.equal(result, undefined);
});

test("the handler ignores a non-string command", async () => {
	const handler = createHandler();
	for (const input of [{}, { command: 42 }, { command: null }, undefined]) {
		const result = await handler({ toolName: "bash", input }, ctxStub(false));
		assert.equal(result, undefined);
	}
});

test("the handler blocks a commit on a protected branch", () =>
	withRepo("main", async (dir) => {
		const handler = createHandler();
		const result = await handler(
			{ toolName: "bash", input: { command: "git commit -m 'wip'" } },
			{ hasUI: false, cwd: dir, ui: { confirm: async () => true } },
		);
		assert.equal(result?.block, true, JSON.stringify(result));
		assert.match(String(result?.reason), /protected branch/i);
	}));

test("the handler allows the same commit in a feature checkout", () =>
	withRepo("feature/login", async (dir) => {
		const handler = createHandler();
		const result = await handler(
			{ toolName: "bash", input: { command: "git commit -m 'wip'" } },
			{ hasUI: false, cwd: dir, ui: { confirm: async () => true } },
		);
		assert.equal(result, undefined, "silent must be undefined, never { block: false }");
	}));

// --- The extension factory -------------------------------------------------

test("the extension registers a tool_call handler that denies a protected push", async () => {
	const registered: Array<{ event: string; handler: (event: unknown, ctx: unknown) => unknown }> = [];
	const api = {
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			registered.push({ event, handler });
			return () => {};
		},
	};

	gitPolicy(api as never);
	assert.equal(registered.length, 1);
	assert.equal(registered[0]?.event, "tool_call");

	const result = (await registered[0]?.handler?.(
		{ toolName: "bash", input: { command: "git push origin main" } },
		{ hasUI: false, cwd: neutralDir, ui: { confirm: async () => true } },
	)) as { block?: boolean } | undefined;
	assert.equal(result?.block, true, JSON.stringify(result));
});
