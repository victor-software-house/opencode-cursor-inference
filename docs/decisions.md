# Decisions

This file records product and architecture decisions that future changes must preserve or explicitly
supersede.

## 2026-09-04 — OpenCode owns the agent loop

**Decision:** Cursor is only the managed inference service. OpenCode owns complete message history,
tool declaration, permission checks, tool execution, continuation, session lifecycle, branching,
compaction, and transcript.

**Consequences:** The provider maps one AI SDK model call to one correlated `RunInference`
invocation. It returns tool calls to OpenCode and never executes them. It does not reject a structurally
valid call merely because the returned name is absent from the advertised set; OpenCode owns lookup,
unavailable-tool and invalid-argument results, and continuation. The provider still rejects transport
corruption such as a missing call ID or one call changing identity across stream frames. Do not add
`AgentService/Run`, Cursor-native tool execution, or MCP projection as a fallback.

## 2026-09-04 — Classic plugin plus AI SDK LanguageModelV3

**Decision:** Target OpenCode `1.18.27` with its documented classic plugin contract and a custom
`provider.npm` module exposing `createCursor()`.

**Consequences:** `src/plugin.ts` owns OpenCode auth and provider configuration. `src/index.ts` owns
the AI SDK `LanguageModelV3` provider. Do not silently migrate to OpenCode's transitional v2 plugin
API. Re-evaluate the contract against an exact stable OpenCode version first.

## 2026-09-04 — V2-primary hybrid plugin with a stable-V1 adapter

**Decision:** This supersedes the preceding V1-primary decision. OpenCode V2 beta `19086` is the
design center, and stable OpenCode `1.18.28` is a compatibility target. Publish one hybrid default
module whose V2 `setup` and stable-V1 `server` members share auth, catalog, provider, and lifecycle
primitives. Export that module at both the package root and `./server`; keep `./provider` as the AI
SDK `LanguageModelV3` entry.

**Consequences:** Both pinned loaders prefer `./server`, so separate pure-V1 and pure-V2 entrypoints
under root and `./server` would not work. V2 registers OAuth through an integration transform and
models through a catalog transform. The stable adapter keeps its config and auth hooks but must not
shape the shared design. Exact loader tests cover both runtimes. Beta plugin/schema helpers and the
private VSH type helper are build dependencies only: bundle them and prove their package imports are
absent from the public runtime artifact.

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
the normalized, non-secret catalog for ten minutes. Corrupt, incomplete, or unmatched data is
omitted or rejected rather than filled with optimistic capabilities.

## 2026-09-04 — Authenticated catalog provenance with one pre-login Auto row

**Decision:** Cache files represent only catalogs produced by a successful authenticated refresh.
A stale but structurally valid authenticated snapshot remains selectable after logout and after
network or persistence failures. Without a credential and without such a snapshot, expose exactly
one real Cursor routing row: model id `default`, display name `Auto`, and wire model id `default`.
Never persist that fallback.

**Consequences:** Cache writes use a schema version, fetch time, atomic replacement, and private file
mode; never write tokens, account ids, raw responses, prompts, tool data, or usage data. A credential
with no prior authenticated snapshot and a failed refresh exposes no models rather than Auto. Corrupt
and empty caches do not establish provenance. V2 listens for Cursor credential-switch events and
reloads the catalog; a successful login does not fetch the same account catalog twice. Stable V1 uses
the same state rules through its config and OAuth hooks. This supersedes the earlier rule that refresh
failure clears the cached catalog.

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

## 2026-09-04 — npm publication remains disabled

**Decision:** The public GitHub repository is
`victor-software-house/opencode-cursor-inference`. Keep version `0.0.0` and `private: true` until
release automation, npm bootstrap publication, and registry trust are separately authorized.

**Consequences:** The repository is registered in mani and GitHub changes are pushed normally. Do not
publish, tag, version, or remove `private: true` based only on repository-creation authorization.

## 2026-09-04 — npm bootstrap publication is enabled

**Decision:** This supersedes the preceding pre-release hold. `opencode-cursor-inference@0.0.0` is the
public bootstrap release. Changesets, npm OIDC trusted publishing, and the Version Packages workflow
own subsequent versions, tags, and GitHub Releases.

**Consequences:** Every user-visible change carries an appropriate Changeset. Do not run versioning or
publishing locally, hand-edit release entries, or merge feature or Version Packages pull requests
without explicit operator approval.
