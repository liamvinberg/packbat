import { CopyButton } from "../components/copy-button";
import { INSTALL_COMMAND } from "../site";

export function Hero() {
	return (
		<section className="min-h-[720px] bg-ground min-[900px]:min-h-[404px]">
			<svg
				aria-hidden="true"
				className="pointer-events-none absolute bottom-[-24px] left-[110px] h-[210px] w-[420px] min-[900px]:top-[170px] min-[900px]:bottom-auto min-[900px]:left-[calc(50%+40px)] min-[900px]:h-[650px] min-[900px]:w-[1300px]"
				viewBox="0 0 240 120"
				xmlns="http://www.w3.org/2000/svg"
			>
				<path
					d="M 120 30 L 126 24 L 132 12 L 134 26 L 132 40 L 138 50 C 175 40 205 40 230 46 L 210 58 L 200 78 L 184 60 L 170 80 L 154 60 L 140 78 L 130 60 L 126 66 L 122 84 L 120 90 L 118 84 L 114 66 L 110 60 L 100 78 L 86 60 L 70 80 L 56 60 L 40 78 L 30 58 L 10 46 C 35 40 65 40 102 50 L 108 40 L 106 26 L 108 12 L 114 24 Z"
					fill="var(--color-surface)"
				/>
			</svg>
			<div className="relative mx-auto flex h-full w-full max-w-[1440px] flex-col items-start px-[20px] pt-[72px] pb-[56px] min-[900px]:px-[64px] min-[900px]:py-[80px]">
				<h1 className="flex flex-col items-start gap-[8px] font-display font-black tracking-display min-[900px]:gap-[10px]">
					<span className="text-display-fluid text-ink">
						<span className="min-[900px]:block">Claude Code deletes your</span>{" "}
						<span className="min-[900px]:block">sessions after 30 days.</span>
					</span>
					<span className="bg-accent px-[10px] pt-[4px] pb-[6px] text-display-fluid text-ground min-[900px]:px-[16px] min-[900px]:pt-[6px] min-[900px]:pb-[8px]">
						Packbat keeps them.
					</span>
				</h1>
				<p className="relative w-[340px] pt-[24px] font-display text-[17px] leading-h3 font-medium text-ink min-[900px]:w-auto min-[900px]:max-w-[500px] min-[900px]:pt-[28px] min-[900px]:text-lg min-[900px]:leading-body">
					Free, open source, and yours. Put the file back and the harness resumes it.
				</p>
				<div className="relative flex w-[350px] flex-col items-start gap-[14px] pt-[28px] min-[900px]:w-auto min-[900px]:gap-[18px] min-[900px]:pt-[34px]">
					<div
						className="flex w-full items-center justify-between rounded-md bg-surface py-[8px] pr-[8px] pl-[14px] min-[900px]:w-auto min-[900px]:gap-[20px] min-[900px]:py-[9px] min-[900px]:pr-[9px] min-[900px]:pl-[22px] [&_button]:min-w-0 [&_button]:bg-accent [&_button]:px-[14px] [&_button]:py-[10px] [&_button]:font-display [&_button]:text-xs [&_button]:leading-ui [&_button]:font-bold [&_button]:text-ground min-[900px]:[&_button]:min-w-[104px] min-[900px]:[&_button]:px-[18px] min-[900px]:[&_button]:py-[11px] min-[900px]:[&_button]:text-sm min-[900px]:[&_button_svg]:block [&_button_svg]:hidden"
						id="install"
					>
						<code className="font-mono text-xs leading-[20px] text-ink min-[900px]:text-md min-[900px]:leading-mono">
							<span className="hidden font-bold text-accent min-[900px]:inline">$ </span>
							<span className="min-[900px]:hidden">$ </span>
							{INSTALL_COMMAND}
						</code>
						<CopyButton text={INSTALL_COMMAND} variant="landing-desktop" />
					</div>
					<p className="w-[330px] font-mono text-[12px] leading-ui text-muted min-[900px]:w-auto min-[900px]:text-xs min-[900px]:leading-xs">
						<span className="hidden min-[900px]:inline">works with </span>claude code · codex · opencode · gemini cli ·
						pi
					</p>
				</div>
			</div>
		</section>
	);
}
