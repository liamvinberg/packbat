import { describe, expect, test, vi } from "vitest";
import { pickRcloneInstall } from "./rclone-install.js";

describe("pickRcloneInstall", () => {
	test("uses Homebrew only when brew is on PATH", () => {
		const present = vi.fn((command: string) => command === "brew");
		expect(pickRcloneInstall("darwin", present)).toEqual({
			kind: "brew",
			command: ["brew", "install", "rclone"],
		});
		expect(present).toHaveBeenCalledWith("brew");

		expect(pickRcloneInstall("darwin", () => false)).toEqual({
			kind: "manual",
			command: "https://rclone.org/install/",
		});
	});

	test("gives Linux users a package-manager command when Homebrew is absent", () => {
		expect(pickRcloneInstall("linux", () => false)).toEqual({
			kind: "manual",
			command: "sudo apt install rclone",
		});
	});
});
