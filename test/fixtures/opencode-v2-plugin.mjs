const providerID = 'smoke';
const providerEntry = `aisdk:${new URL('./opencode-provider.mjs', import.meta.url).href}`;

export default {
	id: 'opencode-cursor-v2-smoke-fixture',
	async setup({ catalog }) {
		await catalog.transform((editor) => {
			editor.provider.update(providerID, (provider) => {
				provider.name = 'Smoke';
				provider.activation = 'enabled';
				provider.package = providerEntry;
				provider.settings = {};
			});
			for (const modelID of ['v2-fixture', 'unknown']) {
				editor.model.update(providerID, modelID, (model) => {
					model.modelID = modelID;
					model.name = modelID === 'unknown' ? 'Unknown Tool Fixture' : 'Fixture';
					model.capabilities = { tools: true, input: ['text'], output: ['text'] };
					model.limit = { context: 100_000, output: 1_000 };
					model.settings = {};
				});
			}
		});
		return async () => {};
	},
};
