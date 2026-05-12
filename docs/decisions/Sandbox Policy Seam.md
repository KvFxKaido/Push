# Sandbox Policy Seam

Status: Current, added 2026-05-11. Schema + provider contract shipped across PRs #502 / #503 / #504; native enforcement is the open follow-up and intentionally deferred.

## What this is

A provider-agnostic schema for declaring OS-level sandbox isolation (filesystem, process, network, inference) plus the contract seam that lets `SandboxProvider` implementations either compile it to native primitives (CF firewall rules, Modal `NetworkPolicy`) or delegate to a host-side reference implementation. Borrowed structurally from NVIDIA's OpenShell — see PR #502 for the evaluation; the inference engine itself is alpha Rust and not a fit for Push.

This is **orthogonal to `lib/verification-policy.ts`**. Verification policy is *agent obligation* (verify-before-claim, auditor gate) surfaced via prompt injection. Sandbox policy is *OS-level isolation* enforced (eventually) by the sandbox host. Different layers, different threat models.

## What shipped

| PR | Lands | Lines |
|---|---|---|
| #502 | `lib/sandbox-policy.ts` — schema (`SandboxPolicy.static` / `.dynamic`, `PolicyTranslator`, pure deciders `evaluateNetwork` / `evaluateProcess`) | +206 |
| #503 | `predicate` hook on `ProcessRule`; `sandbox_exec`'s git checkout/switch guard migrated to call `evaluateProcess` via a wildcard rule (`app/src/lib/sandbox-git-policy.ts`) | +62 |
| #504 | `SandboxProvider` contract wired — `manifest.policy?`, `capabilities.staticPolicyEnforcement` / `dynamicPolicyEnforcement`, optional `applyPolicy()` | +47 |

## The shape

**Static** (locked at sandbox creation, requires recreation to change):
- `filesystem`: path-glob allowlist (`rw` / `ro` / `none`)
- `process`: command rules with either `argMatch` (simple pattern) or `predicate` (full JS for shell-tokenization-grade detection)

**Dynamic** (hot-reloadable via `applyPolicy()`):
- `network`: host + method + path-glob, with `allow` / `deny` / `route` actions
- `inference`: model provider routing with caller-credential strip + backend-credential injection

**Three layers of enforcement**, only one of which is live today:
1. **Host-side reference impl** — `evaluateProcess` / `evaluateNetwork` in `lib/sandbox-policy.ts`. Active today via `sandbox-tools.ts` calling `evaluateProcess(SANDBOX_EXEC_POLICY, ...)` on every `sandbox_exec`. Predicate rules can only enforce here (executable JS doesn't compile to firewall syntax).
2. **Provider-native compilation** — `PolicyTranslator<TStatic, TDynamic>` is the seam. Translators emit provider-native bundles (CF firewall JSON, Modal `NetworkPolicy`). **Not implemented in either provider.**
3. **Provider hot-reload** — `applyPolicy(sandboxId, DynamicPolicy)` for network/inference. Optional, required iff `capabilities.dynamicPolicyEnforcement === true`. **No provider declares this yet.**

## Open items (intentionally deferred)

None of these have a consumer today. Picking them up before there's an actual user is exactly the "design for hypothetical future requirements" trap AGENTS.md warns against.

| Item | Size | Trigger |
|---|---|---|
| Per-provider native compilation (CF firewall / Modal `NetworkPolicy`) | ~150-300 lines each, high uncertainty — requires reading what each platform exposes | Concrete egress-lockdown need: inference router credential-strip, untrusted-tool egress firewall, regulated-tenant isolation |
| `/api/sandbox/*` route plumbing for `manifest.policy` | ~40-80 lines + tests | Anything that needs clients to declare policy server-side (which presupposes native compilation) |
| Network default-deny rollout flag | ~30-50 lines + a test | First caller of `evaluateNetwork` from production code |
| Real glob library (replace minimal `hostMatches` / `pathMatches`) | ~30-80 lines (drop in `picomatch` or similar) | Any policy that needs wildcard hosts or non-trivial path patterns. Until then, the in-file comment flags them as placeholders. |

## Why the seam without the enforcement

The migration from inline `detectBlockedGitCommand` to `evaluateProcess` (#503) is the proof that the schema can host real-world detection logic. The provider contract (#504) is the place future native compilation plugs in. Together they prevent the alternative — every new isolation requirement adds another bespoke check at a fresh call site — without paying the cost of native compilation that no one needs yet.

The predicate-rule escape hatch is documented as non-translatable. Translators that encounter one must either reject the policy or split enforcement (native bundle for `argMatch` rules + host-side `evaluateProcess` for predicate rules). They must not silently drop.

## Pointers

- `lib/sandbox-policy.ts` — schema + deciders
- `lib/sandbox-provider.ts` — provider contract (`SandboxManifest.policy`, capability flags, `applyPolicy`)
- `app/src/lib/sandbox-git-policy.ts` — the one live policy instance today
- `app/src/lib/sandbox-tools.ts:259` — the call site that actually evaluates
- PRs #502, #503, #504 — the three-PR arc
