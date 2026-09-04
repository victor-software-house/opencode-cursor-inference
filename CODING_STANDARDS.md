# Coding standards

1. Keep one implementation path. Remove superseded readers, writers, and protocol branches in the
   same change.
2. Validate OAuth, HTTP, protobuf, filesystem, AI SDK, and OpenCode inputs at their trust boundaries.
   Preserve validated types inside the boundary.
3. Use exhaustive discriminated unions for AI SDK and protobuf message arms. Unsupported arms fail
   with a specific error.
4. Preserve OpenCode's ownership of tools and transcript. Provider code must not execute tools or
   retain a second transcript.
5. Keep generated protobuf files under `src/gen/` generated from `proto/`; never edit them directly.
6. Use project aliases for source imports and Node protocol imports for built-ins.
7. Add the narrowest deterministic test that proves each changed behavior. Use temporary directories
   with cleanup and event-driven synchronization rather than sleeps.
8. Run `mise run verify` before considering a change complete. Live Cursor calls are not verification
   unless separately authorized.
9. Keep task logic in `mise.toml`; do not add package scripts beyond the publish safety hook.
10. Do not reformat or refactor unrelated code. Remove imports and helpers made unused by the change.
