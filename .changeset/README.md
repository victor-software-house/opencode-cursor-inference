# Changesets

Create one patch changeset for each user-visible change. CI owns versioning, publishing, tags, and
GitHub Releases. `opencode-cursor-inference@0.0.0` is the initial public release; the first later
release is `0.0.1`.

Never edit `package.json` versions or `CHANGELOG.md` release entries manually. A release change lands
as a changeset, then `changesets/action` opens the Version Packages pull request. Merging that pull
request authorizes the OIDC publish run.
