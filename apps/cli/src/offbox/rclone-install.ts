export type RcloneInstall =
	| { kind: "brew"; command: ["brew", "install", "rclone"] }
	| { kind: "manual"; command: string };

const MANUAL_INSTALL = {
	linux: "sudo apt install rclone",
	other: "https://rclone.org/install/",
} as const; // DRAFT copy

export function pickRcloneInstall(platform: NodeJS.Platform, hasCommand: (command: string) => boolean): RcloneInstall {
	if (hasCommand("brew")) {
		return { kind: "brew", command: ["brew", "install", "rclone"] };
	}
	return {
		kind: "manual",
		command: platform === "linux" ? MANUAL_INSTALL.linux : MANUAL_INSTALL.other,
	};
}
