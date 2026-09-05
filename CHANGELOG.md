# opencode-cursor-inference

## 0.0.1

### Patch Changes

- Expose one real `default` / `Auto` model before first login, retain last-known authenticated catalogs across logout and refresh failures, and reload OpenCode V2 models when Cursor credentials switch ([#1](https://github.com/victor-software-house/opencode-cursor-inference/pull/1)).
- Route reasoning efforts as variants while keeping Fast and Max Mode as independent model selections, preserve Cursor's complete tool-schema envelope, retire transport connections safely across route switches, and remove terminal model end-of-sequence markers ([#1](https://github.com/victor-software-house/opencode-cursor-inference/pull/1)).
- Add an OpenCode V2 beta plugin entry with native integration OAuth, catalog registration, and host-owned tool continuation while retaining stable OpenCode V1 through the same hybrid package module ([#1](https://github.com/victor-software-house/opencode-cursor-inference/pull/1)).

## 0.0.0

Initial public release of the OpenCode plugin and AI SDK provider for Cursor managed inference.
