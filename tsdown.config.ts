import { defineConfig } from 'tsdown';

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
	deps: {
		onlyBundle: [],
		onlyImport: ['@ai-sdk/provider', '@bufbuild/protobuf', '@opencode-ai/plugin'],
	},
});
