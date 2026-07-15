import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [
		tailwindcss(),
		tanstackStart({
			pages: [
				{
					path: "/404",
					prerender: { outputPath: "/404.html" },
					sitemap: { exclude: true },
				},
				{
					path: "/docs/",
					sitemap: { exclude: true },
				},
				{
					path: "/#install",
					sitemap: { exclude: true },
				},
				{
					path: "/#how-it-works",
					sitemap: { exclude: true },
				},
			],
			prerender: {
				enabled: true,
				autoStaticPathsDiscovery: true,
				crawlLinks: true,
				failOnError: true,
			},
			sitemap: {
				enabled: true,
				host: "https://packbat.dev",
			},
		}),
	],
});
