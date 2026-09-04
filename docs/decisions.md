# Decisions

This file records product and architecture decisions that future changes must preserve or explicitly
supersede.

## 2026-09-04 — OpenCode owns the agent loop

**Decision:** Cursor is only the managed inference service. OpenCode owns complete message history,
tool declaration, permission checks, tool execution, continuation, session lifecycle, branching,
compaction, and transcript.

**Consequences:** The provider maps one AI SDK model call to one correlated `RunInference`
invocation. It returns tool calls to OpenCode and never executes them. Do not add `AgentService/Run`,
Cursor-native tool execution, or MCP projection as a fallback.

## 2026-09-04 — Classic plugin plus AI SDK LanguageModelV3

**Decision:** Target OpenCode `1.18.27` with its documented classic plugin contract and a custom
`provider.npm` module exposing `createCursor()`.

**Consequences:** `src/plugin.ts` owns OpenCode auth and provider configuration. `src/index.ts` owns
the AI SDK `LanguageModelV3` provider. Do not silently migrate to OpenCode's transitional v2 plugin
API. Re-evaluate the contract against an exact stable OpenCode version first.

## 2026-09-04 — OpenCode owns credential persistence

**Decision:** OAuth login and refresh use OpenCode's auth hook and `client.auth.set`. The provider
receives only the current access token through loader options.

**Consequences:** Do not add SQLite, Keychain, 1Password, environment-file, or package-specific
credential storage. The config hook may read OpenCode's existing auth input only to perform startup
catalog discovery because the stable config hook does not receive an auth accessor. It must not copy
the credential into package-owned storage.

## 2026-09-04 — Dynamic, fail-closed model catalog

**Decision:** Join `AvailableModels`, `GetUsableModels`, and `GetDefaultModelForCli`. Publish a model
only when usable selection and capability metadata can be joined. Publish a Max row only when it is a
distinct supported mode.

**Consequences:** Never infer image, reasoning, context, or Max support from model names. Cache only
the normalized, non-secret catalog for ten minutes. Corrupt, stale, incomplete, or unmatched data is
omitted or rejected rather than filled with optimistic capabilities.

## 2026-09-04 — Stable OpenCode session headers identify managed runs

**Decision:** Read `x-session-affinity` or `X-Session-Id` from AI SDK call headers and use it as the
outer Cursor conversation id. Missing identity is an error.

**Consequences:** Do not generate a new conversation id per call. Invocation ids remain unique per
provider call. Route-key changes finish the old outer run before creating a new one.

## 2026-09-04 — Host-derived identity with one bounded fallback

**Decision:** Derive machine identity with Cursor's observed host algorithm. When derivation fails,
persist one random UUID under OpenCode's cache directory and report that it is a fallback through the
internal identity type.

**Consequences:** Never read an installed Cursor IDE or its storage. Never substitute a guessed host
identifier. The fallback file is mode `0600`.

## 2026-09-04 — Reconstructed protocol is pinned evidence

**Decision:** Keep only the protobuf closure needed for catalog and `RunInference`. Treat field names,
HTTP headers, framing, and message behavior as observations tied to the captured Cursor versions, not
as a public API promise.

**Consequences:** Generated files are not edited. Changes begin with new evidence, update the proto
source and tests together, and keep observed facts separate from design inferences.

## 2026-09-04 — No live network in the default gate

**Decision:** `mise run verify` is deterministic and must not authenticate or contact Cursor.

**Consequences:** HTTP/2, framing, request, response, catalog, auth, and host-loop behavior use local
fixtures. A paid or authenticated live inference check requires explicit operator authorization and
must remain outside CI.

## 2026-09-04 — Publication remains disabled

**Decision:** Keep version `0.0.0` and `private: true` until repository creation, release design,
package publication, and any remote are separately authorized.

**Consequences:** Do not create a remote, publish, tag, version, or add release automation based only
on implementation approval. Workspace mani registration waits for a durable remote URL.
