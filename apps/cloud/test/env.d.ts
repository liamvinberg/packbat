declare namespace Cloudflare {
	interface Env {
		ACCESS_TOKEN_SECRET: string;
		TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
	}

	interface GlobalProps {
		mainModule: typeof import("../src/index.js");
	}
}
