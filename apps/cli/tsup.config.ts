import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/main.ts"],
	format: "esm",
	target: "node22",
	clean: true,
	sourcemap: false,
	dts: false,
});
