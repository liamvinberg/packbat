import { BatMark } from "../components/bat-mark";
import { GITHUB_URL } from "../site";

export function SiteNav() {
	return (
		<nav className="border-hairline border-b bg-ground max-[899px]:border-b min-[900px]:border-b-2">
			<div className="mx-auto flex w-full max-w-[1440px] items-center justify-between px-[20px] py-[18px] min-[900px]:px-[64px] min-[900px]:py-[26px]">
				<a className="flex items-center gap-[12px] text-ink" href="/" aria-label="Packbat home">
					<BatMark size={24} />
					<span className="font-display text-xl leading-wordmark font-extrabold tracking-tight">packbat</span>
				</a>
				<div className="hidden items-center gap-[34px] min-[900px]:flex">
					<a className="font-display text-base leading-ui font-semibold text-ink" href="/docs">
						Docs
					</a>
					<a className="font-display text-base leading-ui font-semibold text-ink" href="/#how-it-works">
						How it works
					</a>
					<a className="font-display text-base leading-ui font-semibold text-ink" href={GITHUB_URL}>
						GitHub
					</a>
					<a
						className="flex items-center rounded-sm bg-accent px-[20px] py-[11px] font-display text-sm leading-ui font-bold text-ground"
						href="/#install"
					>
						Install
					</a>
				</div>
				<a
					className="flex rounded-sm bg-accent px-[16px] py-[10px] font-display text-sm leading-ui font-bold text-ground min-[900px]:hidden"
					href="/#install"
				>
					Install
				</a>
			</div>
		</nav>
	);
}
