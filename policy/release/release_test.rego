package policy.release_test

import rego.v1
import data.policy.release

test_accepts_hardened_public_npm_release if {
	count(release.deny) == 0 with input as valid_release
}

test_accepts_stacked_pull_request_ci if {
	count(release.deny) == 0 with input as valid_ci
}

test_rejects_pull_request_target if {
	broken := object.union(valid_release, {"on": {"push": {}, "pull_request_target": {}}})
	some message in release.deny with input as broken
	message == "Release must not run on pull_request_target"
}

test_rejects_job_github_token if {
	broken_job := object.union(valid_release.jobs.changesets, {
		"env": {"GITHUB_TOKEN": "${{ github.token }}"},
	})
	broken := object.union(valid_release, {"jobs": {"changesets": broken_job}})
	some message in release.deny with input as broken
	message == "Release must not set job GITHUB_TOKEN"
}

test_rejects_installation_wide_app_token if {
	broken_mint := object.union(app_token_step, {
		"with": object.union(app_token_step.with, {"owner": "${{ github.repository_owner }}"}),
	})
	broken := release_with_steps([broken_mint, changesets_step, oidc_step, publish_step])
	some message in release.deny with input as broken
	message == "Release App token must not set owner"
}

test_rejects_changesets_publish_input if {
	broken_changesets := object.union(changesets_step, {
		"with": object.union(changesets_step.with, {"publish": "mise run release"}),
	})
	broken := release_with_steps([app_token_step, broken_changesets, oidc_step, publish_step])
	some message in release.deny with input as broken
	message == "changesets/action must not publish through npm"
}

test_rejects_app_token_for_package_install if {
	broken_job := object.union(valid_release.jobs.changesets, {
		"env": {"PI_CURSOR_PACKAGES_TOKEN": "${{ steps.app-token.outputs.token }}"},
	})
	broken := object.union(valid_release, {"jobs": {"changesets": broken_job}})
	some message in release.deny with input as broken
	message == "Release package token must use the repository token"
}

test_rejects_pull_request_branch_filter if {
	broken := object.union(valid_ci, {"on": {"push": {"branches": ["main"]}, "pull_request": {"branches": ["main"]}}})
	some message in release.deny with input as broken
	message == "CI pull_request must not filter branches"
}

test_rejects_long_lived_npm_token if {
	broken_publish := object.union(publish_step, {"env": {"NPM_TOKEN": "${{ secrets.NPM_TOKEN }}"}})
	broken := release_with_steps([app_token_step, changesets_step, oidc_step, broken_publish])
	some message in release.deny with input as broken
	message == "Public npm release must not reference long-lived npm tokens"
}

app_token_step := {
	"name": "Mint Version Packages token",
	"id": "app-token",
	"uses": "actions/create-github-app-token@sha",
	"with": {
		"client-id": "${{ secrets.CHANGESET_VERSION_APP_CLIENT_ID }}",
		"private-key": "${{ secrets.CHANGESET_VERSION_APP_PRIVATE_KEY }}",
		"repositories": "${{ github.event.repository.name }}",
		"permission-contents": "write",
		"permission-pull-requests": "write",
	},
}

changesets_step := {
	"name": "Create Version Packages PR",
	"id": "changesets",
	"uses": "changesets/action@sha",
	"with": {
		"version": "mise run version",
		"commit": "chore(release): version packages",
		"title": "chore(release): version packages",
		"github-token": "${{ steps.app-token.outputs.token }}",
		"setupGitUser": false,
		"commitMode": "github-api",
	},
	"env": {"GITHUB_TOKEN": "${{ steps.app-token.outputs.token }}"},
}

oidc_step := {
	"name": "Mint npm OIDC token",
	"if": "steps.changesets.outputs.hasChangesets == 'false'",
	"run": "mise run release:oidc",
}

publish_step := {
	"name": "Publish",
	"if": "steps.changesets.outputs.hasChangesets == 'false'",
	"run": "mise run release",
}

release_with_steps(steps) := object.union(valid_release, {
	"jobs": {
		"changesets": object.union(valid_release.jobs.changesets, {"steps": steps}),
	},
})

valid_release := {
	"name": "Release",
	"on": {"push": {"branches": ["main"]}, "workflow_dispatch": {}},
	"permissions": {"contents": "read"},
	"jobs": {
		"changesets": {
			"if": "vars.NPM_RELEASE_ENABLED == 'true'",
			"permissions": {
				"contents": "write",
				"pull-requests": "write",
				"packages": "read",
				"id-token": "write",
			},
			"env": {"PI_CURSOR_PACKAGES_TOKEN": "${{ github.token }}"},
			"steps": [app_token_step, changesets_step, oidc_step, publish_step],
		},
	},
}

valid_ci := {
	"name": "CI",
	"on": {"push": {"branches": ["main"]}, "pull_request": null},
	"permissions": {"contents": "read", "packages": "read"},
	"jobs": {
		"verify": {
			"env": {"PI_CURSOR_PACKAGES_TOKEN": "${{ github.token }}"},
			"steps": [],
		},
	},
}
