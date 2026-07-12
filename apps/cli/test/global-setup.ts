import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Build the CLI once; every seam test spawns the built artifact. */
export default function setup(): void {
	const packageDir = fileURLToPath(new URL("..", import.meta.url));
	execFileSync("pnpm", ["build"], { cwd: packageDir, stdio: "inherit" });
}
