import { describe, expect, test } from "vitest";
import { parseIdentityFile } from "./age.js";

describe("age identity files", () => {
	test("extracts the identity line from recovery-kit text", () => {
		const identity = "AGE-SECRET-KEY-1SYNTHETICIDENTITY";

		expect(parseIdentityFile(`Packbat recovery kit\n\nAge identity\n${identity}\n\nEnd\n`)).toBe(identity);
		expect(() => parseIdentityFile("no identity here\n")).toThrow("AGE-SECRET-KEY-1");
	});
});
