import { describe, expect, test } from "vitest";
import { scheduleEnvironment } from "./environment.js";

describe("scheduleEnvironment", () => {
	test("preserves OpenCode database and data-root resolution inputs", () => {
		expect([...scheduleEnvironment({ OPENCODE_DB: "channel.db", XDG_DATA_HOME: "/data/liam" })]).toEqual([
			["OPENCODE_DB", "channel.db"],
			["XDG_DATA_HOME", "/data/liam"],
		]);
	});
});
