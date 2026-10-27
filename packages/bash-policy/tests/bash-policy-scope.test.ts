// bash-policy-scope.test.ts
//
// The path scope of the `pi-bash-policy` package: deletion is confined to the
// project folder and to temporary directories.
//
// These tests exercise THIS package — its packaged policy, its classifier and
// its tool_call handler — not a copy of the older single-file extension.
//
// DETERMINISM
// The packaged policy is read through the engine's own loader, but the loader
// prefers a user override under the agent's policy directory. The agent
// directory is therefore pointed at an empty scratch directory for the whole
// file, so the packaged default is what is judged here and the same assertions
// hold on a developer machine and in CI.
//
// The project directory is a synthetic path. The engine judges paths purely
// lexically — it never touches the filesystem — so a synthetic directory keeps
// the expectations crisp: the project must not sit inside /tmp, or the
// temporary-directory root would allow everything.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPolicy, type PolicySet } from "pi-policy-core";
import { classifyCommand, createToolCallHandler, loadPolicies } from "../src/extension.ts";

// --- Isolation -------------------------------------------------------------

const scratchAgentDir = mkdtempSync(join(tmpdir(), "pi-bash-policy-agent-"));
process.env.PI_AGENT_DIR = scratchAgentDir;

after(() => {
	rmSync(scratchAgentDir, { recursive: true, force: true });
});

/** The policy directory shipped inside this package. */
const packagedPolicyDir = fileURLToPath(new URL("../policies/", import.meta.url));

/** The packaged policy, read through the engine's loader. */
const policy = loadPolicy("local", packagedPolicyDir);
const policies: PolicySet = { local: policy };

/** The session's own directory: the `<project>` root. */
const PROJECT = "/srv/pi-bash-policy/demo";

// --- Helpers ---------------------------------------------------------------

function classify(command: string, cwd: string = PROJECT): Promise<{ tier: string; reason?: string }> {
	return classifyCommand(command, policies, { cwd });
}

function context(cwd: string = PROJECT) {
	return {
		hasUI: false,
		cwd,
		ui: { confirm: async () => true },
	};
}

// --- The packaged policy is the generic default ----------------------------

test("the packaged policy confines rm to the project and temporary directories", () => {
	const rules = policy.path_scoped ?? [];
	assert.equal(rules.length, 1);
	assert.equal(rules[0]?.command, "rm");
	assert.deepEqual(rules[0]?.allowed_roots, ["<project>", "<tmpdir>", "/tmp", "/var/tmp"]);
	assert.ok(
		!rules[0]?.allowed_roots.includes("<projects>"),
		"a personal project collection must not be baked into a shipped default",
	);
});

test("the extension loads the packaged local policy", () => {
	const loaded = loadPolicies();
	assert.deepEqual(Object.keys(loaded), ["local"]);
	assert.equal(loaded.local?.domain, "local");
	assert.deepEqual(loaded.local?.path_scoped, policy.path_scoped);
});

// --- S8: rm inside the project is allowed -----------------------------------

test("rm inside the project is not blocked by this gate", async () => {
	for (const command of [
		"rm -rf node_modules",
		"rm -rf build dist coverage",
		"rm file.txt",
		"rm -rf ./dist/*",
		"rm *.log",
		"rm -rf subdir/nested",
		"rm -rf src/../build",
	]) {
		const decision = await classify(command);
		assert.equal(decision.tier, "silent", `${command} -> ${decision.tier} ${decision.reason ?? ""}`);
	}
});

test("rm inside a temporary directory is not blocked by this gate", async () => {
	for (const command of [
		`rm -rf ${join(tmpdir(), "build-output")}`,
		"rm -rf /tmp/report.md",
		"rm -f /tmp/analysis.txt",
		"rm /tmp/session.jsonl",
		"rm -rf /var/tmp/checkout",
	]) {
		const decision = await classify(command);
		assert.equal(decision.tier, "silent", `${command} -> ${decision.tier} ${decision.reason ?? ""}`);
	}
});

// --- S8: rm outside the project and temporary directories is blocked --------

test("rm outside the project and temporary directories is blocked", async () => {
	for (const command of [
		"rm -rf /etc/ssl",
		"rm -rf ~/Documents",
		"rm -rf $HOME/.config",
		"rm -rf /var/log/*.gz",
		"rm -rf /opt/other-project",
		"rm -rf ~/",
	]) {
		const decision = await classify(command);
		assert.equal(decision.tier, "block", `${command} -> ${decision.tier}`);
		assert.match(String(decision.reason), /rm may only target the project folder or a temporary directory/);
	}
});

test("rm that escapes the project via .. is blocked", async () => {
	// The project root is /srv/pi-bash-policy/demo; one level up is outside it.
	for (const command of ["rm -rf ..", "rm -rf ../..", "rm -rf ../sibling-project", "rm -rf subdir/../../escape"]) {
		const decision = await classify(command);
		assert.equal(decision.tier, "block", `${command} -> ${decision.tier}`);
	}
});

test("rm that stays inside the project is not blocked by a .. in the path", async () => {
	const decision = await classify("rm -rf ./subdir/../build");
	assert.equal(decision.tier, "silent", String(decision.reason));
});

// --- S8: per-segment judging ------------------------------------------------

test("rm in a compound chain is judged per segment", async () => {
	assert.equal((await classify("rm -rf dist && rm -rf /etc/hosts")).tier, "block");
	assert.equal((await classify("rm -rf /etc/hosts && rm -rf dist")).tier, "block");
	assert.equal((await classify("rm -rf dist && rm -rf /tmp/scratch")).tier, "silent");
	assert.equal((await classify("rm -rf dist ; rm -rf /etc/hosts")).tier, "block");
	assert.equal((await classify("rm -rf dist ; rm -rf /tmp/scratch")).tier, "silent");
	assert.equal((await classify("rm -rf dist | rm -rf /etc/hosts")).tier, "block");
});

// --- S8: unverifiable targets are blocked, not trusted ----------------------

test("rm whose target cannot be resolved is blocked rather than trusted", async () => {
	for (const command of [
		"rm -rf $TARGET",
		"rm -rf \"$(cat list)\"",
		"rm -rf `whoami`-files",
		"rm -rf '$HOME/notes'",
		"rm -rf ${HOME}/notes",
		"rm -rf $TMPDIR",
	]) {
		const decision = await classify(command);
		assert.equal(decision.tier, "block", `${command} -> ${decision.tier}`);
		assert.match(String(decision.reason), /cannot be verified at admission time/);
	}
});

// --- S8: a root itself may not be deleted -----------------------------------

test("a root itself may not be deleted", async () => {
	for (const command of ["rm -rf /tmp", "rm -rf /tmp/", "rm -rf /var/tmp", "rm -rf .", "rm -rf ./"]) {
		const decision = await classify(command);
		assert.equal(decision.tier, "block", `${command} -> ${decision.tier}`);
	}
});

// --- S8: a glob anchored at a root is allowed --------------------------------

test("a glob anchored at a root is allowed", async () => {
	for (const command of ["rm /tmp/*.md", "rm *.log", "rm -rf ./dist/*", `rm ${join(tmpdir(), "*.md")}`]) {
		const decision = await classify(command);
		assert.equal(decision.tier, "silent", `${command} -> ${decision.tier} ${decision.reason ?? ""}`);
	}
});

test("a glob outside the roots is blocked", async () => {
	for (const command of ["rm /etc/*.conf", "rm -rf /opt/*/cache"]) {
		const decision = await classify(command);
		assert.equal(decision.tier, "block", `${command} -> ${decision.tier}`);
	}
});

// --- S8: cd changes the directory a segment is judged against ---------------

test("rm after cd is judged against the directory it runs in", async () => {
	assert.equal((await classify("cd /etc && rm -rf hosts")).tier, "block");
	assert.equal((await classify("cd /tmp && rm -rf scratch")).tier, "silent");
	assert.equal((await classify("cd /srv/pi-bash-policy/demo && rm -rf build")).tier, "silent");
	// Without the cd the target would be inside the project; with it, it is not.
	assert.equal((await classify("cd .. && rm -rf sibling")).tier, "block");
	assert.equal((await classify("rm -rf sibling")).tier, "silent");
});

// --- The handler contract ---------------------------------------------------

test("the handler ignores a tool that is not a shell command", async () => {
	const handler = createToolCallHandler();
	const result = await handler({ toolName: "read", input: { command: "rm -rf /etc/hosts" } }, context());
	assert.equal(result, undefined);
});

test("the handler ignores a command that is not a string", async () => {
	const handler = createToolCallHandler();
	assert.equal(await handler({ toolName: "bash", input: { command: 42 } }, context()), undefined);
	assert.equal(await handler({ toolName: "bash", input: {} }, context()), undefined);
	assert.equal(await handler({ toolName: "bash", input: { command: "   " } }, context()), undefined);
});

test("the handler blocks a command that escapes the project", async () => {
	const handler = createToolCallHandler();
	const result = await handler({ toolName: "bash", input: { command: "rm -rf /etc/hosts" } }, context());
	assert.equal(result?.block, true, JSON.stringify(result));
	assert.match(String(result?.reason), /bash policy denied this command/);
});

test("the handler allows a command inside the project and never returns { block: false }", async () => {
	const handler = createToolCallHandler();
	const result = await handler({ toolName: "bash", input: { command: "rm -rf dist" } }, context());
	assert.equal(result, undefined, "silent must be undefined, never { block: false }");
});

test("the handler confines rm to the session directory", async () => {
	const handler = createToolCallHandler();
	assert.equal(
		(await handler({ toolName: "bash", input: { command: "rm -rf /srv/pi-bash-policy/other/dist" } }, context(PROJECT)))?.block,
		true,
		"a target outside the session directory must be blocked",
	);
	assert.equal(
		(await handler({ toolName: "bash", input: { command: "rm -rf dist" } }, context(PROJECT)))?.block,
		undefined,
		"the same command inside the session directory must be allowed",
	);
});

// --- The user override beats the packaged default ---------------------------

test("a user override beats the packaged default", () => {
	const overrideDir = mkdtempSync(join(tmpdir(), "pi-bash-policy-override-"));
	const previous = process.env.PI_AGENT_DIR;
	try {
		mkdirSync(join(overrideDir, "policies"), { recursive: true });
		writeFileSync(
			join(overrideDir, "policies", "local.json"),
			JSON.stringify({
				domain: "local",
				always_block: [],
				always_confirm: [],
				always_allow: [],
				path_scoped: [
					{
						command: "rm",
						allowed_roots: ["<project>"],
						reason: "user override",
					},
				],
			}),
			"utf8",
		);
		process.env.PI_AGENT_DIR = overrideDir;
		const overridden = loadPolicy("local", packagedPolicyDir);
		assert.deepEqual(overridden.path_scoped?.[0]?.allowed_roots, ["<project>"]);
		assert.equal(overridden.path_scoped?.[0]?.reason, "user override");
	} finally {
		process.env.PI_AGENT_DIR = previous;
		rmSync(overrideDir, { recursive: true, force: true });
	}
});
