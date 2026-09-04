# opencode-cursor-inference

Public-ready OpenCode integration for Cursor managed inference over
`aiserver.v1.InferenceService/RunInference`.

Read [docs/decisions.md](docs/decisions.md) and [docs/research.md](docs/research.md) before changing the
provider boundary, protocol, auth, catalog, or lifecycle.

## Rules

- OpenCode owns history, arbitrary tools, execution, continuation, sessions, branches, compaction, and
  transcript. The provider emits tool calls and never executes them.
- Target the exact stable OpenCode contract recorded in the decisions. Do not silently adopt a
  transitional plugin API.
- Credentials stay in OpenCode's auth store. Do not add another secret store or copy credentials into
  package-owned files.
- Cache only normalized non-secret model metadata. Fail closed on incomplete catalog joins and
  unsupported capabilities.
- Treat selected Cursor protobufs, headers, and behavior as versioned observations, not public API.
  Keep observed facts and design inferences distinct.
- Never read an installed Cursor IDE or its storage to derive identity.
- Never add live Cursor calls to the default tests or CI. A paid or authenticated inference call
  requires explicit operator authorization.
- `mise run verify` is the complete local gate. Keep tests deterministic and temporary directories
  automatically cleaned up.
- Tasks live in `mise.toml`; `package.json` contains only the publish safety hook.
- Do not create a remote, publish, version, tag, release, or remove `private: true` without explicit
  authorization.
- Conventional Commits. No AI attribution.
