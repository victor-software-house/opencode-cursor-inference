#!/usr/bin/env bun
//MISE description="Create the exact-version git tag and GitHub Release"
//MISE dir="{{ config_root }}"
//MISE depends=["build"]

import { version } from '@repo/package.json' with { type: 'json' };
import { tagAndGithubRelease } from 'bun-release';

await tagAndGithubRelease(version);
