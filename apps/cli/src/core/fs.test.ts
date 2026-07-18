import { describe, expect, test } from "vitest";
import { expandTilde } from "./fs.js";

describe("expandTilde", () => {
	test("expands a bare tilde to the home directory", () => {
		expect(expandTilde("~", "/Users/liam")).toBe("/Users/liam");
	});

	test("expands a tilde prefix into the home directory", () => {
		expect(expandTilde("~/Downloads/recovery-kit.txt", "/Users/liam")).toBe("/Users/liam/Downloads/recovery-kit.txt");
	});

	test.each([
		["/absolute/path", "/absolute/path"],
		["relative/path", "relative/path"],
		["~user/path", "~user/path"],
		["", ""],
	])("passes %j through untouched", (input, expected) => {
		expect(expandTilde(input, "/Users/liam")).toBe(expected);
	});
});
