import { createInterface } from "node:readline/promises";
import { resolveHome } from "../core/home.js";
import { authorizeDropboxRemote, authorizeDropboxRemoteHeadless } from "../offbox/dropbox-oauth.js";

const USAGE = "Usage: packbat _dropbox-oauth --app-key <public-app-key> [--headless]\n";

function usageError(): number {
	process.stderr.write(USAGE);
	return 1;
}

export async function runDropboxOAuth(argv: string[]): Promise<number> {
	const headless = argv.includes("--headless");
	const rest = argv.filter((argument) => argument !== "--headless");
	if (rest.length !== 2 || rest[0] !== "--app-key" || rest[1] === undefined) {
		return usageError();
	}
	const appKey = rest[1];
	const configPath = resolveHome().rcloneConfPath;
	if (headless) {
		await authorizeDropboxRemoteHeadless({
			appKey,
			configPath,
			onAuthorizationUrl(url) {
				process.stdout.write(`Open this link in any browser:\n${url}\n`); // DRAFT copy
			},
			async askCode() {
				const readline = createInterface({ input: process.stdin, output: process.stdout });
				try {
					return await readline.question("Paste the code Dropbox shows: "); // DRAFT copy
				} finally {
					readline.close();
				}
			},
		});
	} else {
		await authorizeDropboxRemote({
			appKey,
			configPath,
			onAuthorizationUrl(url, opened) {
				// DRAFT copy
				process.stdout.write(
					`${opened ? "Opened your browser to authorize Dropbox." : "Could not open a browser. Open this link on this machine."}\n${url}\n`,
				);
			},
		});
	}
	process.stdout.write("Dropbox authorization complete.\n");
	return 0;
}
