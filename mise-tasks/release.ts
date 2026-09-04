#!/usr/bin/env bun
//MISE description="Publish to public npm with bun"
//MISE dir="{{ config_root }}"
//MISE depends=["build"]

import { name, version } from '@repo/package.json' with { type: 'json' };
import { publishIfNeeded } from 'bun-release';

await publishIfNeeded(name, version);
