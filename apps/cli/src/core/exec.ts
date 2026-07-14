import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

export function commandOnPath(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
	for (const directory of (env.PATH ?? "").split(delimiter)) {
		if (directory === "") {
			continue;
		}
		const candidate = join(directory, command);
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			// Keep searching PATH.
		}
	}
	return null;
}
