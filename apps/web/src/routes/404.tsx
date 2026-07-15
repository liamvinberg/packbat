import { createFileRoute } from "@tanstack/react-router";
import { ArticleIntro } from "../components/article-intro";
import { ArticleSection } from "../components/article-section";
import { DocsShell } from "../components/docs-shell";

export const Route = createFileRoute("/404")({
	component: NotFoundPage,
});

function NotFoundPage() {
	return (
		<DocsShell>
			<ArticleIntro standfirst="There is no page at this address." title="Page not found" />
			<ArticleSection
				description={
					<>
						Return to the{" "}
						<a className="text-accent" href="/">
							landing page
						</a>
						, or open the{" "}
						<a className="text-accent" href="/docs">
							Get started guide
						</a>
						.
					</>
				}
				id="keep-going"
				last
				title="Keep going"
			/>
		</DocsShell>
	);
}
