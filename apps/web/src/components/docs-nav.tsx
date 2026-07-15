import { Link } from "@tanstack/react-router";
import { GITHUB_URL } from "../site";
import { BatMark } from "./bat-mark";

export function DocsNav() {
	return (
		<>
			<nav className="hidden h-[82px] w-full border-hairline border-b-2 bg-ground min-[900px]:block">
				<div className="mx-auto flex h-full max-w-[1440px] items-center justify-between px-[48px] antialiased">
					<Link className="flex items-center gap-[12px] text-ink" to="/">
						<BatMark className="text-ink" size={24} />
						<span className="font-display text-xl leading-wordmark font-extrabold tracking-[-0.02em]">packbat</span>
					</Link>
					<div className="flex items-center gap-[34px] font-mono text-xs leading-ui">
						<Link className="text-muted" to="/">
							Landing
						</Link>
						<Link className="text-accent" to="/docs">
							Docs
						</Link>
						<a className="text-muted" href={GITHUB_URL}>
							GitHub
						</a>
					</div>
					<a
						className="bg-accent px-[15px] py-[11px] font-mono text-[12px] leading-ui font-bold text-ground"
						href="/#install"
					>
						Install packbat
					</a>
				</div>
			</nav>

			<nav className="h-[64px] w-full border-hairline border-b-2 bg-ground min-[900px]:hidden">
				<div className="flex h-full items-center justify-between px-[20px] antialiased">
					<Link className="flex items-center gap-[9px] text-ink" to="/">
						<BatMark className="text-ink" size={20} />
						<span className="font-display text-lg leading-mono font-extrabold tracking-[-0.02em]">packbat</span>
						<span className="font-mono text-[10px] leading-xs text-muted-deep">/ docs</span>
					</Link>
					<a className="font-mono text-[11px] leading-xs text-accent" href="/#install">
						Install
					</a>
				</div>
			</nav>
		</>
	);
}
