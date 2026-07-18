import { createFileRoute } from "@tanstack/react-router";
import { ArticleIntro } from "../../components/article-intro";
import { ArticleSection } from "../../components/article-section";
import { CodeBlock } from "../../components/code-block";

export const Route = createFileRoute("/docs/commands")({
	component: CommandsPage,
});

function CommandsPage() {
	return (
		<>
			<ArticleIntro
				standfirst="Set up the archive, run a sync, prove it is healthy, then find, read, or restore a session."
				title="Commands"
			/>
			<ArticleSection
				description="Set up archiving. With a terminal, the wizard detects harnesses, chooses the archive and optional off-box copy, installs the schedule, runs the first sync, then runs doctor. Use --yes for unattended setup, --no-activate to write without activating the schedule, or --uninstall to remove it."
				id="init"
				title="init"
			>
				<CodeBlock
					copy
					lines={[
						{
							text: "Usage: packbat init --yes [--archive-root <abs>] [--offbox skip|remote]\n       [--offbox-remote <rclone-dest>] [--age-recipient <age1…>]\n       [--rclone-config default|managed] [--no-activate]\n       packbat init --uninstall\n",
						},
					]}
				/>
			</ArticleSection>
			<ArticleSection
				description="Run one archive sync now. The installed schedule calls the same command every hour. It reports archived, unchanged, and failed files, and copies encrypted changes off-box when configured."
				id="sync"
				title="sync"
			>
				<CodeBlock copy lines={[{ text: "Usage: packbat sync\n" }]} />
			</ArticleSection>
			<ArticleSection
				description="Prove the schedule is installed and live, the last success is fresh, and nothing has been missed. Environment checks cover the stores, archive, disk, compression, and off-box state. Pass --json for structured output."
				id="doctor"
				title="doctor"
			>
				<CodeBlock copy lines={[{ text: "Usage: packbat doctor [--json]\n" }]} />
			</ArticleSection>
			<ArticleSection
				description="List archived sessions or restore one by id or unambiguous prefix. Use --machine for another source machine, --force only when overwriting a newer live file is intentional, and --from-remote with the identity from the recovery kit for an off-box restore. --remote chooses one configured destination."
				id="restore"
				title="restore"
			>
				<CodeBlock
					copy
					lines={[
						{
							text: "Usage: packbat restore [--machine <name>] [--force] [--from-remote --identity <file> [--remote <destination>]] [<id-or-prefix>]\n",
						},
					]}
				/>
			</ArticleSection>
			<ArticleSection
				description="Print a one-screen health summary for this machine: archive root, schedule state, last run, last success, harness tallies, and off-box state. Pass --json for the report object."
				id="status"
				title="status"
			>
				<CodeBlock copy lines={[{ text: "Usage: packbat status [--json]\n" }]} />
			</ArticleSection>
			<ArticleSection
				description="Find text across archived sessions, ranked by relevance. Search matches user and assistant turns by default. Use --role to search one role or every role. Narrow results by harness, machine, project, or time. Pass --json for structured results. Use --rebuild when the local retrieval database needs to be rebuilt from the archive."
				id="search"
				title="search"
			>
				<CodeBlock
					copy
					lines={[
						{
							text: "Usage: packbat search <query> [--role <role>] [--harness <id>] [--machine <name>] [--project <path>] [--since <RFC3339>] [--limit <n>] [--json]\n       packbat search --rebuild [--json]\n",
						},
					]}
				/>
			</ArticleSection>
			<ArticleSection
				description="List archived sessions, newest first. Filter by an exact absolute project path, time, harness, machine, file substring, or command substring. Pass --json for structured results."
				id="sessions"
				title="sessions"
			>
				<CodeBlock
					copy
					lines={[
						{
							text: "Usage: packbat sessions [--project <path>] [--since <RFC3339>] [--harness <id>] [--machine <name>] [--file <substring>] [--command <substring>] [--limit <n>] [--json]\n",
						},
					]}
				/>
			</ArticleSection>
			<ArticleSection
				description="Skim one archived session, one line per turn. Outline reads the raw archive and prints zero based turn ordinals. Use --turns to select a range. When output is truncated, use the printed continuation command."
				id="outline"
				title="outline"
			>
				<CodeBlock copy lines={[{ text: "Usage: packbat outline <unit-or-key> [--turns <a:b>] [--json]\n" }]} />
			</ArticleSection>
			<ArticleSection
				description="Read turns from one archived session by unit id or result key. Show reads the raw archive. Use --turns to select a range, or --all to remove the output cap. When output is truncated, use the printed continuation command."
				id="show"
				title="show"
			>
				<CodeBlock copy lines={[{ text: "Usage: packbat show <unit-or-key> [--turns <a:b>] [--all] [--json]\n" }]} />
			</ArticleSection>
			<ArticleSection
				description="Run one read only SELECT against the search cache. WITH is allowed. Output contains at most 200 rows. Pass --json for structured results."
				id="query"
				last
				title="query"
			>
				<CodeBlock copy lines={[{ text: "Usage: packbat query <select-sql> [--json]\n" }]} />
			</ArticleSection>
		</>
	);
}
