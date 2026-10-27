// core.test.ts — unit tests for the shared engine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	buildToolCallHandler,
	classify,
	classifyWithRules,
	commandHead,
	compile,
	domainOf,
	evaluatePathScope,
	firstMatch,
	loadPolicy,
	loadPolicySet,
	resolvePolicyPath,
	segmentInfos,
	splitSegments,
	userPolicyDir,
	type DomainPolicy,
	type PolicySet,
} from "../src/index.ts";

function policy(overrides: Partial<DomainPolicy> = {}): DomainPolicy {
	return {
		domain: "local",
		always_block: [],
		always_confirm: [],
		always_allow: [],
		...overrides,
	};
}

// --- Segment splitting -----------------------------------------------------

test("splitSegments splits on sequential and pipe operators only", () => {
	assert.deepEqual(splitSegments("a && b || c ; d | e\nf"), ["a", "b", "c", "d", "e", "f"]);
	assert.deepEqual(splitSegments("   "), []);
	assert.deepEqual(splitSegments("git status"), ["git status"]);
});

test("commandHead drops assignments and env/command wrappers", () => {
	assert.equal(commandHead("FOO=bar git status"), "git status");
	assert.equal(commandHead("env FOO=bar git status"), "git status");
	assert.equal(commandHead("command git status"), "git status");
	assert.equal(commandHead("git status"), "git status");
});

test("domainOf tells git from everything else", () => {
	assert.equal(domainOf("git status"), "git");
	assert.equal(domainOf("/usr/bin/git status"), "git");
	assert.equal(domainOf("npm run build"), "local");
});

// --- Effective directory tracking -----------------------------------------

test("segmentInfos follows cd and git -C to the directory a segment runs in", () => {
	const base = "/projects/app";
	const infos = segmentInfos("cd /projects/other && rm -rf x", base);
	assert.equal(infos.length, 2);
	assert.equal(infos[0]?.cwd, "/projects/app");
	assert.equal(infos[1]?.cwd, "/projects/other");

	const withGitC = segmentInfos("git -C /projects/other commit -m x", base);
	assert.equal(withGitC[0]?.cwd, "/projects/other");
});

test("segmentInfos resolves a relative cd against the current directory", () => {
	const infos = segmentInfos("cd sub && rm -rf x", "/projects/app");
	assert.equal(infos[1]?.cwd, "/projects/app/sub");
});

// --- Rule matching ---------------------------------------------------------

test("an invalid pattern throws rather than silently passing", () => {
	assert.throws(() => compile("([unclosed"));
});

test("firstMatch returns the first matching rule", () => {
	const rules = [
		{ pattern: "alpha" },
		{ pattern: "beta" },
	];
	assert.equal(firstMatch(rules, "beta")?.pattern, "beta");
	assert.equal(firstMatch(rules, "gamma"), undefined);
	assert.equal(firstMatch(undefined, "gamma"), undefined);
});

// --- Path scope ------------------------------------------------------------

test("evaluatePathScope blocks a target outside the allowed roots", () => {
	const dir = mkdtempSync(join(tmpdir(), "core-scope-"));
	try {
		const rule = {
			command: "rm",
			allowed_roots: ["<project>"],
			reason: "rm may only target the project folder",
		};
		const infos = segmentInfos("rm -rf /etc/ssl", dir);
		const decision = evaluatePathScope([rule], infos, dir);
		assert.equal(decision?.tier, "block");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("evaluatePathScope allows a target inside the project and refuses the root itself", () => {
	const dir = mkdtempSync(join(tmpdir(), "core-scope-"));
	try {
		const rule = {
			command: "rm",
			allowed_roots: ["<project>"],
			reason: "rm may only target the project folder",
		};
		assert.equal(evaluatePathScope([rule], segmentInfos("rm -rf dist", dir), dir), undefined);
		assert.equal(evaluatePathScope([rule], segmentInfos("rm -rf .", dir), dir)?.tier, "block");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("evaluatePathScope refuses a target it cannot resolve", () => {
	const dir = mkdtempSync(join(tmpdir(), "core-scope-"));
	try {
		const rule = {
			command: "rm",
			allowed_roots: ["<project>"],
			reason: "rm may only target the project folder",
		};
		assert.equal(evaluatePathScope([rule], segmentInfos("rm -rf $TARGET", dir), dir)?.tier, "block");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// --- Policy loading --------------------------------------------------------

test("a user override beats the packaged default", () => {
	const packaged = mkdtempSync(join(tmpdir(), "core-packaged-"));
	const agentDir = mkdtempSync(join(tmpdir(), "core-agent-"));
	const previousAgentDir = process.env.PI_AGENT_DIR;
	process.env.PI_AGENT_DIR = agentDir;
	try {
		mkdirSync(packaged, { recursive: true });
		mkdirSync(join(agentDir, "policies"), { recursive: true });
		for (const domain of ["local", "core-test-domain"]) {
			writeFileSync(
				join(packaged, `${domain}.json`),
				JSON.stringify({ domain, always_block: [], always_confirm: [], always_allow: [] }),
			);
		}

		// With a user file present, it wins.
		writeFileSync(
			join(agentDir, "policies", "local.json"),
			JSON.stringify({ domain: "local", always_block: [{ pattern: "user-override" }], always_confirm: [], always_allow: [] }),
		);
		const withOverride = resolvePolicyPath("local", packaged);
		assert.equal(withOverride.origin, "user");
		assert.equal(withOverride.path, join(agentDir, "policies", "local.json"));
		// And the override's rules are the ones that take effect.
		assert.equal(loadPolicy("local", packaged).always_block[0]?.pattern, "user-override");

		// With no user file, the packaged default is used.
		const withoutOverride = resolvePolicyPath("core-test-domain", packaged);
		assert.equal(withoutOverride.origin, "packaged");
		assert.equal(withoutOverride.path, join(packaged, "core-test-domain.json"));
		assert.equal(loadPolicy("core-test-domain", packaged).domain, "core-test-domain");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
		else process.env.PI_AGENT_DIR = previousAgentDir;
		rmSync(packaged, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("loadPolicySet loads every requested domain", () => {
	const packaged = mkdtempSync(join(tmpdir(), "core-domains-"));
	try {
		for (const domain of ["local", "git"]) {
			writeFileSync(
				join(packaged, `${domain}.json`),
				JSON.stringify({
					domain,
					always_block: [],
					always_confirm: [],
					always_allow: [],
				}),
			);
		}
		const set = loadPolicySet(["local", "git"], packaged);
		assert.equal(set.local?.domain, "local");
		assert.equal(set.git?.domain, "git");
	} finally {
		rmSync(packaged, { recursive: true, force: true });
	}
});

test("a malformed policy file throws rather than yielding an empty policy", () => {
	const packaged = mkdtempSync(join(tmpdir(), "core-bad-"));
	try {
		writeFileSync(join(packaged, "core-bad-domain.json"), JSON.stringify({ domain: "core-bad-domain" }));
		assert.throws(() => loadPolicy("core-bad-domain", packaged));
	} finally {
		rmSync(packaged, { recursive: true, force: true });
	}
});

// --- Classification --------------------------------------------------------

test("a block wins over everything else in the same command", () => {
	const policies: PolicySet = {
		local: policy({
			always_block: [{ pattern: "rm\\s+-rf\\s+/etc" }],
			always_confirm: [{ pattern: "npm" }],
		}),
	};
	const decision = classifyWithRules("npm publish && rm -rf /etc/ssl", policies, { cwd: "/projects/app" });
	assert.equal(decision.tier, "block");
});

test("a block is matched against the raw command, so chaining cannot hide it", () => {
	const policies: PolicySet = {
		local: policy({ always_block: [{ pattern: "rm\\s+-rf\\s+/etc" }] }),
	};
	const decision = classifyWithRules("echo ok && rm -rf /etc/ssl", policies, { cwd: "/projects/app" });
	assert.equal(decision.tier, "block");
});

test("an unmatched command is silent", () => {
	const policies: PolicySet = { local: policy() };
	assert.equal(classifyWithRules("npm run build", policies, { cwd: "/projects/app" }).tier, "silent");
});

test("a confirm rule is found in a later segment", () => {
	const policies: PolicySet = {
		local: policy({ always_confirm: [{ pattern: "npm\\s+publish" }] }),
	};
	const decision = classifyWithRules("git status && npm publish", policies, { cwd: "/projects/app" });
	assert.equal(decision.tier, "confirm");
});

test("an allow entry does not suppress a confirm rule for the same command", () => {
	const policies: PolicySet = {
		local: policy({
			always_confirm: [{ pattern: "npm\\s+publish" }],
			always_allow: [{ pattern: "^npm" }],
		}),
	};
	assert.equal(classifyWithRules("npm publish", policies, { cwd: "/projects/app" }).tier, "confirm");
});

test("the asynchronous guard runs only when the static pass did not block", async () => {
	const policies: PolicySet = {
		local: policy({ always_block: [{ pattern: "blocked", reason: "blocked by rule" }] }),
	};
	let guardCalls = 0;
	const decision = await classify("blocked command", policies, {
		cwd: "/projects/app",
		hooks: {
			asyncGuard: async () => {
				guardCalls += 1;
				return { tier: "block", reason: "async" };
			},
		},
	});
	assert.equal(decision.tier, "block");
	assert.equal(decision.reason, "blocked by rule");
	assert.equal(guardCalls, 0, "a static block must short-circuit the asynchronous guard");
});

test("the asynchronous guard can block when the static pass is silent", async () => {
	const policies: PolicySet = { local: policy() };
	const decision = await classify("anything", policies, {
		cwd: "/projects/app",
		hooks: { asyncGuard: async () => ({ tier: "block", reason: "async" }) },
	});
	assert.equal(decision.tier, "block");
	assert.equal(decision.reason, "async");
});

// --- The handler -----------------------------------------------------------

function ctxStub(hasUI: boolean, approve = false) {
	return {
		hasUI,
		cwd: "/projects/app",
		ui: { confirm: async () => approve },
	};
}

test("the handler ignores a non-shell tool", async () => {
	const handler = buildToolCallHandler(() => ({ local: policy() }), () => ({ tier: "silent" }));
	const result = await handler({ toolName: "read", input: { command: "rm -rf /" } }, ctxStub(true));
	assert.equal(result, undefined);
});

test("the handler ignores a non-string command", async () => {
	const handler = buildToolCallHandler(() => ({ local: policy() }), () => ({ tier: "silent" }));
	for (const input of [{}, { command: 42 }, { command: null }, undefined]) {
		assert.equal(await handler({ toolName: "bash", input }, ctxStub(true)), undefined);
	}
});

test("the handler returns undefined for a silent command, never { block: false }", async () => {
	const handler = buildToolCallHandler(() => ({ local: policy() }), () => ({ tier: "silent" }));
	const result = await handler({ toolName: "bash", input: { command: "git status" } }, ctxStub(true));
	assert.equal(result, undefined);
});

test("the handler blocks a denied command with a reason", async () => {
	const handler = buildToolCallHandler(
		() => ({ local: policy() }),
		() => ({ tier: "block", reason: "not allowed" }),
	);
	const result = await handler({ toolName: "bash", input: { command: "rm -rf /" } }, ctxStub(true));
	assert.equal(result?.block, true);
	assert.match(String(result?.reason), /not allowed/);
});

test("the handler blocks a confirmation when there is no UI to ask", async () => {
	const handler = buildToolCallHandler(
		() => ({ local: policy() }),
		() => ({ tier: "confirm", reason: "destructive" }),
	);
	const result = await handler({ toolName: "bash", input: { command: "npm publish" } }, ctxStub(false));
	assert.equal(result?.block, true);
});

test("the handler blocks a confirmation the user declined", async () => {
	const handler = buildToolCallHandler(
		() => ({ local: policy() }),
		() => ({ tier: "confirm", reason: "destructive" }),
	);
	const result = await handler({ toolName: "bash", input: { command: "npm publish" } }, ctxStub(true, false));
	assert.equal(result?.block, true);
});

test("the handler lets an approved confirmation through as undefined", async () => {
	const handler = buildToolCallHandler(
		() => ({ local: policy() }),
		() => ({ tier: "confirm", reason: "destructive" }),
	);
	const result = await handler({ toolName: "bash", input: { command: "npm publish" } }, ctxStub(true, true));
	assert.equal(result, undefined);
});

test("the handler fails closed when the classifier throws", async () => {
	const handler = buildToolCallHandler(
		() => ({ local: policy() }),
		() => {
			throw new Error("policy unreadable");
		},
	);
	const result = await handler({ toolName: "bash", input: { command: "git status" } }, ctxStub(true));
	assert.equal(result?.block, true, "an internal error must never widen access");
});

test("the handler fails closed when the policy loader throws", async () => {
	const handler = buildToolCallHandler(
		() => {
			throw new Error("policy file missing");
		},
		() => ({ tier: "silent" }),
	);
	const result = await handler({ toolName: "bash", input: { command: "git status" } }, ctxStub(true));
	assert.equal(result?.block, true);
});
