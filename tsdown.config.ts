import { runtimePackageNames } from '@victor-software-house/pi-type-kit';
import pkg from 'opencode-cursor-inference/package.json' with { type: 'json' };
import { defineConfig } from 'tsdown';

const runtimeImports = runtimePackageNames(pkg);

export default defineConfig({
	entry: {
		index: 'src/index.ts',
		plugin: 'src/plugin.ts',
	},
	format: 'esm',
	platform: 'node',
	target: 'node24',
	fixedExtension: true,
	minify: true,
	treeshake: true,
	sourcemap: false,
	clean: true,
	hash: false,
	dts: { tsconfig: 'tsconfig.build.json' },
	failOnWarn: 'ci-only',
	suppressWarnings: [
		'TypeScript 7.0 does not yet have a stable API and is experimental. Some options will be unavailable.',
	],
	publint: { level: 'error' },
	attw: { profile: 'esm-only', level: 'error' },
	deps: {
		onlyBundle: [
			'@opencode-ai/plugin-v2',
			'@opencode-ai/schema-v2',
			'@victor-software-house/pi-type-kit',
			'effect',
		],
		onlyImport: runtimeImports,
	},
});
