import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getInfo } from '@changesets/get-github-info';
import type {
	ChangelogFunctions,
	ModCompWithPackage,
	NewChangesetWithCommit,
	VersionType,
} from '@changesets/types';
import { Liquid } from 'liquidjs';

type PullRequest = {
	number: number;
	url: string;
	user: string | null;
	userUrl: string | null;
};

type Commit = {
	short: string;
	url: string;
};

type ChangelogOptions = {
	internalAuthors?: string[];
	repo?: string;
};

type ReleaseTemplateData = {
	commit: Commit | null;
	continuations: string[];
	pullRequest: (PullRequest & { externalAuthor: boolean }) | null;
	summary: string;
	summaryHasTerminal: boolean;
};

const releaseTemplatePath = fileURLToPath(new URL('./changelog.liquid', import.meta.url));
const dependencyTemplatePath = fileURLToPath(
	new URL('./dependency-changelog.liquid', import.meta.url),
);
const liquid = new Liquid({ cache: true, strictFilters: true, strictVariables: true });
const releaseTemplate = liquid.parse(
	readFileSync(releaseTemplatePath, 'utf8'),
	releaseTemplatePath,
);
const dependencyTemplate = liquid.parse(
	readFileSync(dependencyTemplatePath, 'utf8'),
	dependencyTemplatePath,
);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function getChangelogOptions(value: unknown): ChangelogOptions {
	if (!isRecord(value)) return {};
	const internalAuthors = value['internalAuthors'];
	const repo = value['repo'];
	const options: ChangelogOptions = {};
	if (
		Array.isArray(internalAuthors) &&
		internalAuthors.every((author) => typeof author === 'string')
	) {
		options.internalAuthors = internalAuthors;
	}
	if (typeof repo === 'string') options.repo = repo;
	return options;
}

function markdownLinkUrl(markdown: string): string {
	return markdown.match(/\]\((.+)\)$/u)?.[1] ?? '';
}

function renderTemplate(
	template: ReturnType<Liquid['parse']>,
	scope: Record<string, unknown>,
): string {
	const rendered: unknown = liquid.renderSync(template, scope);
	return typeof rendered === 'string' ? rendered : '';
}

export async function getReleaseLine(
	changeset: NewChangesetWithCommit,
	_type: VersionType,
	options: unknown,
): Promise<string> {
	const { internalAuthors = [], repo } = getChangelogOptions(options);
	const [firstLine = '', ...remaining] = changeset.summary
		.split('\n')
		.map((line) => line.trimEnd());
	let pullRequest: PullRequest | null = null;
	let commit: Commit | null = null;

	if (changeset.commit != null && changeset.commit !== '') {
		if (repo == null || repo === '') {
			throw new Error('options.repo is required for commit-backed releases');
		}
		commit = {
			short: changeset.commit.slice(0, 7),
			url: `https://github.com/${repo}/commit/${changeset.commit}`,
		};
		const info = await getInfo({ repo, commit: changeset.commit });
		if (info.pull != null && info.links.pull != null && info.links.pull !== '') {
			pullRequest = {
				number: info.pull,
				url: markdownLinkUrl(info.links.pull),
				user: info.user,
				userUrl:
					info.links.user != null && info.links.user !== ''
						? markdownLinkUrl(info.links.user)
						: null,
			};
		}
	}

	const hasLink = pullRequest != null || commit != null;
	return renderTemplate(releaseTemplate, {
		release: {
			commit: pullRequest == null ? commit : null,
			continuations: remaining.map((line) => (line === '' ? '' : line.trim())),
			pullRequest:
				pullRequest == null
					? null
					: {
							...pullRequest,
							externalAuthor:
								pullRequest.user != null &&
								pullRequest.user !== '' &&
								pullRequest.userUrl != null &&
								pullRequest.userUrl !== '' &&
								!internalAuthors.includes(pullRequest.user),
						},
			summary: hasLink ? firstLine.replace(/\.+$/u, '') : firstLine,
			summaryHasTerminal: /[.!?:;]$/u.test(firstLine),
		} satisfies ReleaseTemplateData,
	});
}

export async function getDependencyReleaseLine(
	_changesets: NewChangesetWithCommit[],
	dependenciesUpdated: ModCompWithPackage[],
	_options: unknown,
): Promise<string> {
	if (dependenciesUpdated.length === 0) return '';
	return renderTemplate(dependencyTemplate, { dependencies: dependenciesUpdated });
}

const changelogFunctions: ChangelogFunctions = { getReleaseLine, getDependencyReleaseLine };

export default changelogFunctions;
