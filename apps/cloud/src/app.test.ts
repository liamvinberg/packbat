import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("public client configuration", () => {
	it("exposes only the public GitHub OAuth client ID without caching", async () => {
		const response = await exports.default.fetch("https://api.packbat.dev/v1/client");

		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(await response.json()).toEqual({ githubClientId: "Ov23liPackbatCloudTest" });
	});
});
