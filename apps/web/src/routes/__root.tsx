import spaceMonoWoff2 from "@fontsource/space-mono/files/space-mono-latin-400-normal.woff2?url";
import archivoWoff2 from "@fontsource-variable/archivo/files/archivo-latin-wght-normal.woff2?url";
import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import type { ReactNode } from "react";
import appCss from "../styles/app.css?url";

const title = "Packbat. Every agent session, kept.";
const description = "Free, open source, and yours. Put the file back and the harness resumes it.";

export const Route = createRootRoute({
	head: () => ({
		meta: [
			{ charSet: "utf-8" },
			{ name: "viewport", content: "width=device-width, initial-scale=1" },
			{ title },
			{ name: "description", content: description },
			{ property: "og:title", content: title },
			{ property: "og:description", content: description },
		],
		links: [
			{ rel: "stylesheet", href: appCss },
			{ rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
			{ rel: "preload", href: archivoWoff2, as: "font", type: "font/woff2", crossOrigin: "anonymous" },
			{ rel: "preload", href: spaceMonoWoff2, as: "font", type: "font/woff2", crossOrigin: "anonymous" },
		],
	}),
	notFoundComponent: NotFound,
	component: RootComponent,
});

function RootComponent() {
	return (
		<RootDocument>
			<Outlet />
		</RootDocument>
	);
}

function RootDocument({ children }: { children: ReactNode }) {
	return (
		<html lang="en">
			<head>
				<HeadContent />
			</head>
			<body>
				<a className="skip-link" href="#main-content">
					Skip to content
				</a>
				<main id="main-content">{children}</main>
				<Scripts />
			</body>
		</html>
	);
}

function NotFound() {
	return <h1>Page not found</h1>;
}
