export const SCHEDULE_ENVIRONMENT_KEYS = [
	"BLOTTER_HOME",
	"CLAUDE_CONFIG_DIR",
	"CODEX_HOME",
	"PI_CODING_AGENT_SESSION_DIR",
] as const;

export type ScheduleEnvironment = ReadonlyMap<string, string>;

export function scheduleEnvironment(env: NodeJS.ProcessEnv): Map<string, string> {
	const result = new Map<string, string>();
	for (const key of SCHEDULE_ENVIRONMENT_KEYS) {
		const value = env[key];
		if (value !== undefined && value.trim() !== "") {
			result.set(key, value);
		}
	}
	return result;
}
