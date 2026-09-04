declare global {
	namespace NodeJS {
		interface ProcessEnv {
			readonly HOME?: string;
			readonly OPENCODE_AUTH_CONTENT?: string;
			readonly OPENCODE_CURSOR_SMOKE_FILE?: string;
			readonly OPENCODE_CURSOR_SMOKE_LOG?: string;
			readonly XDG_CACHE_HOME?: string;
			readonly XDG_CONFIG_HOME?: string;
			readonly XDG_DATA_HOME?: string;
		}
	}
}

export type ExplicitProcessEnvironment = NodeJS.ProcessEnv;
