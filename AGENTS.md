# opencode-cursor-inference

Public-ready OpenCode integration for Cursor managed inference over
`aiserver.v1.InferenceService/RunInference`.

Read [docs/decisions.md](docs/decisions.md) and [docs/research.md](docs/research.md) before changing the
provider boundary, protocol, auth, catalog, or lifecycle.

## Rules

- OpenCode owns history, arbitrary tools, execution, continuation, sessions, branches, compaction, and
  transcript. The provider emits tool calls and never executes them.
- OpenCode V2 beta `19086` is the design center; stable OpenCode `1.18.28` is a compatibility adapter.
  Keep the hybrid root/`./server` contract and update either pin only through a recorded decision and
  exact loader proof.
- `@victor-software-house/pi-type-kit` is the only permitted private build dependency. Import exact
  helpers, bundle and tree-shake them, keep GitHub Packages credentials distinct from release App
  credentials, and prove private names/source paths are absent from every runtime artifact.
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
- Conventional Commits. No AI attribution.

## Release discipline

Versioning is changeset-driven. CI owns version bumps, publishing, tags, and GitHub Releases.
The registry is public npm with OIDC trusted publishing.

1. Author a `.changeset/*.md` file for each user-visible change. Default to `patch`.
2. Commit and push it to `main`, or merge it through a pull request.
3. `changesets/action` opens or updates the **Version Packages** pull request using the
   `vsh-changeset-version` GitHub App.
4. Merging that pull request runs `release:oidc`, publishes with Bun, and creates the exact-version
   tag and GitHub Release.

- Never run `changeset version` or `changeset publish` locally.
- Never hand-edit `package.json` versions or `CHANGELOG.md` release entries.
- Public npm CI uses `bun-release` and `BUN_CONFIG_TOKEN`; never add `NPM_TOKEN`,
  `NODE_AUTH_TOKEN`, a repository `.npmrc`, or another publishing secret.
- The initial published version is `0.0.0`; the first changeset is a patch to `0.0.1`.
- Never use a `major` changeset while the package is on `0.x`. `minor` requires a notable new
  public surface.
