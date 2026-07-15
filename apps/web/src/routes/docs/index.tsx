import { createFileRoute, Link } from "@tanstack/react-router";
import { ArticleIntro } from "../../components/article-intro";
import { ArticleSection } from "../../components/article-section";
import { CodeBlock } from "../../components/code-block";
import { INSTALL_COMMAND } from "../../site";

export const Route = createFileRoute("/docs/")({
	component: GetStartedPage,
});

function GetStartedPage() {
	return (
		<>
			<ArticleIntro
				requires="Node.js 22.16 or newer on macOS or Linux."
				standfirst="Install Packbat, point it at a store you own, then prove the whole archive loop is alive."
				title="Get started"
			/>
			<ArticleSection
				description="Install the CLI globally so the scheduler can call the same binary after setup."
				id="install"
				title="Install"
			>
				<CodeBlock copy lines={[{ text: `$ ${INSTALL_COMMAND}` }]} />
			</ArticleSection>
			<ArticleSection
				description={
					<>
						<span className="min-[900px]:hidden">
							Packbat detects Claude Code, Codex, OpenCode, Gemini CLI, and pi. Choose the archive, then let it install
							the hourly schedule.
						</span>
						<span className="hidden min-[900px]:inline">
							Packbat detects Claude Code, Codex, OpenCode, Gemini CLI, and pi. Choose an archive location, add an
							optional encrypted off-box copy, and let it install the hourly schedule.
						</span>
					</>
				}
				id="run-the-wizard"
				title="Run the wizard"
			>
				<CodeBlock lines={[{ text: "$ packbat init" }]} />
				<div className="flex flex-col gap-[11px] font-mono text-[11px] leading-ui min-[900px]:gap-[12px] min-[900px]:pt-[4px] min-[900px]:text-[12px] min-[900px]:leading-[19px]">
					<div className="flex gap-[12px] min-[900px]:gap-[13px]">
						<span className="text-ok">01</span>
						<span className="text-muted">detect session stores</span>
					</div>
					<div className="flex gap-[12px] min-[900px]:gap-[13px]">
						<span className="text-ok">02</span>
						<span className="text-muted min-[900px]:hidden">create the raw archive</span>
						<span className="hidden text-muted min-[900px]:inline">create the raw append-only archive</span>
					</div>
					<div className="flex gap-[12px] min-[900px]:gap-[13px]">
						<span className="text-ok">03</span>
						<span className="text-muted">install the hourly sync</span>
					</div>
				</div>
			</ArticleSection>
			<ArticleSection
				description={
					<>
						<span className="min-[900px]:hidden">
							Doctor probes the installed schedule, freshness, archive coverage, and environment.
						</span>
						<span className="hidden min-[900px]:inline">
							Run doctor once after setup. It probes the installed schedule, freshness, archive coverage, and the
							environment. A problem includes the command or action that fixes it.
						</span>
					</>
				}
				id="check-the-loop"
				title="Check the loop"
			>
				<CodeBlock
					lines={[
						{ text: "$ packbat doctor" },
						{ text: "✓ installed: launchd schedule matches", tone: "ok" },
						{ text: "✓ live: loaded, last exit 0", tone: "ok" },
						{ text: "✓ fresh: last success 41m ago", tone: "ok" },
						{ text: "✓ reconciled: nothing missed; 4304 source files current", tone: "ok" },
					]}
				/>
			</ArticleSection>
			<ArticleSection
				description={
					<>
						<span className="min-[900px]:hidden">
							The schedule runs packbat sync every hour. New and changed files are compressed verbatim. Archive objects
							are never rewritten.
						</span>
						<span className="hidden min-[900px]:inline">
							The scheduled job runs packbat sync every hour. New and changed files are compressed verbatim. Existing
							archive objects are never rewritten.
						</span>
					</>
				}
				id="what-happens-next"
				last
				title="What happens next"
			>
				<div className="flex flex-col gap-[11px] font-mono text-[11px] leading-ui text-accent min-[900px]:flex-row min-[900px]:gap-[26px] min-[900px]:text-[12px]">
					<Link to="/docs/how-it-works">Read how it works →</Link>
					<Link to="/docs/restore-a-session">Restore a session →</Link>
				</div>
			</ArticleSection>
		</>
	);
}
