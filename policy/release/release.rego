# METADATA
# entrypoint: true
package policy.release

import rego.v1

workflow_on := object.get(input, "on", object.get(input, "true", {}))
release_workflow if input.name == "Release"
ci_workflow if input.name == "CI"
release_job := object.get(object.get(input, "jobs", {}), "changesets", {})
release_steps := object.get(release_job, "steps", [])
release_permissions := object.get(release_job, "permissions", {})
release_env := object.get(release_job, "env", {})
ci_job := object.get(object.get(input, "jobs", {}), "verify", {})
ci_permissions := object.get(input, "permissions", {})
ci_env := object.get(ci_job, "env", {})

app_token_steps := [step |
	some step in release_steps
	startswith(object.get(step, "uses", ""), "actions/create-github-app-token@")
]

changesets_steps := [step |
	some step in release_steps
	startswith(object.get(step, "uses", ""), "changesets/action@")
]

oidc_steps := [step |
	some step in release_steps
	object.get(step, "run", "") == "mise run release:oidc"
]

publish_steps := [step |
	some step in release_steps
	object.get(step, "run", "") == "mise run release"
]

app_token_step := app_token_steps[0] if count(app_token_steps) == 1
changesets_step := changesets_steps[0] if count(changesets_steps) == 1
app_token_with := object.get(app_token_step, "with", {})
changesets_with := object.get(changesets_step, "with", {})

release_condition := "steps.changesets.outputs.hasChangesets == 'false'"

# The package and trusted publisher must exist before enabling the workflow.
deny contains "Release must be gated by NPM_RELEASE_ENABLED during bootstrap" if {
	release_workflow
	object.get(release_job, "if", "") != "vars.NPM_RELEASE_ENABLED == 'true'"
}

deny contains "Release must not run on pull_request" if {
	release_workflow
	object.get(workflow_on, "pull_request", null) != null
}

deny contains "Release must not run on pull_request_target" if {
	release_workflow
	object.get(workflow_on, "pull_request_target", null) != null
}

deny contains "Release must not set workflow GITHUB_TOKEN" if {
	release_workflow
	object.get(object.get(input, "env", {}), "GITHUB_TOKEN", null) != null
}

deny contains "Release must not set job GITHUB_TOKEN" if {
	release_workflow
	object.get(object.get(release_job, "env", {}), "GITHUB_TOKEN", null) != null
}

deny contains "Release requires contents write" if {
	release_workflow
	object.get(release_permissions, "contents", "") != "write"
}

deny contains "Release requires pull-requests write" if {
	release_workflow
	object.get(release_permissions, "pull-requests", "") != "write"
}

deny contains "Release requires id-token write" if {
	release_workflow
	object.get(release_permissions, "id-token", "") != "write"
}

deny contains "Release requires packages read" if {
	release_workflow
	object.get(release_permissions, "packages", "") != "read"
}

deny contains "Release package token must use the repository token" if {
	release_workflow
	object.get(release_env, "PI_CURSOR_PACKAGES_TOKEN", "") != "${{ github.token }}"
}

deny contains "Release must mint exactly one repository-scoped App token" if {
	release_workflow
	count(app_token_steps) != 1
}

deny contains "Release App token must use the configured client id" if {
	release_workflow
	object.get(app_token_with, "client-id", "") != "${{ secrets.CHANGESET_VERSION_APP_CLIENT_ID }}"
}

deny contains "Release App token must use the configured private key" if {
	release_workflow
	object.get(app_token_with, "private-key", "") != "${{ secrets.CHANGESET_VERSION_APP_PRIVATE_KEY }}"
}

deny contains "Release App token must be limited to this repository" if {
	release_workflow
	object.get(app_token_with, "repositories", "") != "${{ github.event.repository.name }}"
}

deny contains "Release App token must not set owner" if {
	release_workflow
	object.get(app_token_with, "owner", null) != null
}

deny contains "Release App token requires contents write" if {
	release_workflow
	object.get(app_token_with, "permission-contents", "") != "write"
}

deny contains "Release App token requires pull-requests write" if {
	release_workflow
	object.get(app_token_with, "permission-pull-requests", "") != "write"
}

deny contains "Release must run changesets/action exactly once" if {
	release_workflow
	count(changesets_steps) != 1
}

deny contains "changesets/action must use the App token input" if {
	release_workflow
	object.get(changesets_with, "github-token", "") != "${{ steps.app-token.outputs.token }}"
}

deny contains "changesets/action must use the App token environment" if {
	release_workflow
	object.get(object.get(changesets_step, "env", {}), "GITHUB_TOKEN", "") != "${{ steps.app-token.outputs.token }}"
}

deny contains "changesets/action must use github-api commit mode" if {
	release_workflow
	object.get(changesets_with, "commitMode", "") != "github-api"
}

deny contains "changesets/action must not configure a git user" if {
	release_workflow
	object.get(changesets_with, "setupGitUser", null) != false
}

deny contains "changesets/action must not publish through npm" if {
	release_workflow
	object.get(changesets_with, "publish", null) != null
}

deny contains "Release must mint exactly one npm OIDC token" if {
	release_workflow
	count(oidc_steps) != 1
}

deny contains "Release npm OIDC step must run only without pending changesets" if {
	release_workflow
	some step in oidc_steps
	object.get(step, "if", "") != release_condition
}

deny contains "Release must publish exactly once through Bun" if {
	release_workflow
	count(publish_steps) != 1
}

deny contains "Release publish step must run only without pending changesets" if {
	release_workflow
	some step in publish_steps
	object.get(step, "if", "") != release_condition
}

deny contains "Public npm release must not reference long-lived npm tokens" if {
	release_workflow
	workflow_json := json.marshal(input)
	contains(workflow_json, "NPM_TOKEN")
}

deny contains "Public npm release must not reference NODE_AUTH_TOKEN" if {
	release_workflow
	workflow_json := json.marshal(input)
	contains(workflow_json, "NODE_AUTH_TOKEN")
}

deny contains "CI must run on every pull request base" if {
	ci_workflow
	pull_request := object.get(workflow_on, "pull_request", false)
	pull_request == false
}

deny contains "CI pull_request must not filter branches" if {
	ci_workflow
	pull_request := object.get(workflow_on, "pull_request", null)
	is_object(pull_request)
	object.get(pull_request, "branches", null) != null
}

deny contains "CI requires packages read" if {
	ci_workflow
	object.get(ci_permissions, "packages", "") != "read"
}

deny contains "CI package token must use the repository token" if {
	ci_workflow
	object.get(ci_env, "PI_CURSOR_PACKAGES_TOKEN", "") != "${{ github.token }}"
}
