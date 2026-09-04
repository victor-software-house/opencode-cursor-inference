# Research record

Research completed on 2026-09-04 before implementation. This record distinguishes external contract
facts, observed Cursor protocol behavior, and design inference.

## Official OpenCode facts

Verified against OpenCode documentation and the `v1.18.27` source tag:

- Classic plugins can register `config`, `auth`, and lifecycle hooks.
- OAuth callback results are persisted by OpenCode's auth subsystem.
- An auth loader can translate the stored credential into provider factory options.
- A configured provider can set `npm` to a package or local `file://` module.
- OpenCode imports that module, selects an export whose name starts with `create`, calls the factory,
  and asks the returned provider for a `LanguageModelV3`.
- OpenCode passes complete AI SDK prompt history and arbitrary function-tool schemas to each model
  call.
- OpenCode executes model-emitted tool calls and sends a later provider call containing tool results.
- OpenCode supplies session affinity in `x-session-affinity` and `X-Session-Id` request headers.
- Plugin disposal hooks run during instance teardown.
- Isolated HOME and XDG directories are sufficient for a local plugin/provider smoke test.

The stable `1.18.27` config hook has no auth accessor. That limitation motivates the narrowly scoped
read of OpenCode's own auth input during startup catalog configuration.

## Public Cursor product and protocol observations

Authorized evidence was limited to the public `pi-cursor-inference` repository guidance, plan,
decisions, README, selected source, selected protobufs, and checked-in protocol evidence.

The `RunInference` closure and host identity behavior are tied to Cursor IDE `3.18.9`, commit
`2ba48ff3f7514cc4643c52ca9f7b3173d9b66130`. Catalog behavior is tied to the captured Cursor CLI
identifier `cli-2026.09.02-fa0c06e-lab`.

Observed behavior used here:

- Managed inference is a bidirectional HTTP/2 Connect stream at
  `aiserver.v1.InferenceService/RunInference`.
- An outer run is keyed by conversation identity and requested model routing. Individual model calls
  use invocation ids.
- Requests carry complete inference messages, model configuration, arbitrary agent-tool schemas, and
  tool results.
- Responses can stream text, reasoning, partial tool arguments, usage, final response information,
  provider metadata, nested invocation identity, and structured errors.
- Reasoning can include signatures or opaque redacted data needed for continuation.
- Cursor's selected catalog surface consists of `AvailableModels`, `GetUsableModels`, and
  `GetDefaultModelForCli`.
- Cursor's observed machine identity algorithm hashes platform-specific host identity and the first
  usable MAC address.

These are reverse-engineered observations, not a documented Cursor API contract.

## Prior art survey

Existing OpenCode/Cursor integrations found during discovery used one or more of:

- Cursor `AgentService/Run`;
- server-sent event bridges;
- Cursor CLI subprocesses;
- provider-owned tool execution; or
- static model configuration.

Those implementations did not satisfy the requested boundary of `InferenceService/RunInference`
with OpenCode-owned arbitrary tool execution and transcript continuation. They were not selected as
the transport architecture.

## Design inferences

The following choices are design inferences from the two evidence sets:

- A classic plugin and an AI SDK provider are the smallest stable OpenCode integration for the
  selected version.
- OpenCode session headers are the best available stable id for Cursor's outer run.
- Model rows should be omitted when the three catalog responses cannot be joined.
- `LanguageModelV3` provider metadata is the correct place to preserve Cursor reasoning signatures.
- A local deterministic provider is the cheapest proof that OpenCode, rather than this package,
  executes tools and continues with results.
- A seeded non-secret model cache is the cheapest way to prove built Cursor plugin discovery without
  authenticating or contacting Cursor.

## Verified local loop

`mise run verify` proves:

1. protobuf sources generate deterministically;
2. strict TypeScript, Biome, oxlint, and dependency checks pass;
3. framing, headers, identity, auth, catalog, request, response, and multiplexed transport fixtures
   pass;
4. both provider and plugin entries build and package metadata is valid;
5. OpenCode `1.18.27` loads the built plugin and lists a seeded Cursor model; and
6. an isolated synthetic provider emits a tool call, OpenCode executes it, and the next provider call
   contains the host-owned result.

The loop does not prove a live Cursor account, current service compatibility, billing behavior, or a
paid model response. Those remain deliberately unverified without explicit authorization.
