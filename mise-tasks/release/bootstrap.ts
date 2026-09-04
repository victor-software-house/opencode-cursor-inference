#!/usr/bin/env bun
//MISE description="First-publication bootstrap: npm browser login and OIDC trust"
//MISE dir="{{ config_root }}"
//MISE depends=["build"]

import { name, version } from '@repo/package.json' with { type: 'json' };
import { bootstrapNpmPackages } from 'bun-release';

await bootstrapNpmPackages(
	[{ directory: '.', name, version }],
	'victor-software-house/opencode-cursor-inference',
	'release.yml',
);
