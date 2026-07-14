import { describe, expect, test } from "vitest";
import { scheduleEnvironment } from "./environment.js";

describe("scheduleEnvironment", () => {
	test("preserves Gemini and OpenCode store-root resolution inputs", () => {
		expect([
			...scheduleEnvironment({
				GEMINI_CLI_HOME: "/gemini/liam",
				OPENCODE_DB: "channel.db",
				XDG_DATA_HOME: "/data/liam",
			}),
		]).toEqual([
			["GEMINI_CLI_HOME", "/gemini/liam"],
			["OPENCODE_DB", "channel.db"],
			["XDG_DATA_HOME", "/data/liam"],
		]);
	});
});
