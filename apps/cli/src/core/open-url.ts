import { spawn } from "node:child_process";

function browserCommand(url: string): { command: string; args: string[] } {
	switch (process.platform) {
		case "darwin":
			return { command: "open", args: [url] };
		case "win32":
			return { command: "cmd", args: ["/c", "start", "", url] };
		default:
			return { command: "xdg-open", args: [url] };
	}
}

export async function openUrl(url: string): Promise<boolean> {
	const { command, args } = browserCommand(url);
	return await new Promise((resolve) => {
		const child = spawn(command, args, { env: process.env, stdio: "ignore" });
		child.on("error", () => resolve(false));
		child.on("close", (code) => resolve(code === 0));
	});
}
