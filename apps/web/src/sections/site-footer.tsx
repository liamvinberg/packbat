import { BatMark } from "../components/bat-mark";
import { GITHUB_URL, INSTALL_COMMAND } from "../site";

export function SiteFooter() {
	return (
		<footer className="border-hairline border-t-2 bg-surface min-[900px]:border-t">
			<div className="mx-auto flex w-full max-w-[1440px] flex-col gap-[36px] px-[20px] pt-[48px] pb-[36px] min-[900px]:flex-row min-[900px]:items-center min-[900px]:justify-between min-[900px]:gap-0 min-[900px]:px-[64px] min-[900px]:pt-[48px] min-[900px]:pb-[56px]">
				<div className="flex w-full items-center justify-between min-[900px]:w-auto">
					<a
						className="flex items-center gap-[10px] text-ink min-[900px]:gap-[12px]"
						href="/"
						aria-label="Packbat home"
					>
						<BatMark className="h-[23px] w-[22px] min-[900px]:h-[24px] min-[900px]:w-[24px]" size={24} />
						<span className="font-display text-[20px] leading-mono font-extrabold tracking-[-0.02em] min-[900px]:text-xl min-[900px]:leading-wordmark min-[900px]:tracking-tight">
							packbat
						</span>
					</a>
					<div className="flex items-center gap-[22px] min-[900px]:hidden">
						<a className="font-mono text-[12px] leading-ui text-accent" href="/docs">
							Docs
						</a>
						<a className="font-mono text-[12px] leading-ui text-muted" href={GITHUB_URL}>
							GitHub
						</a>
					</div>
				</div>
				<div className="hidden items-center gap-[32px] min-[900px]:flex">
					<code className="font-mono text-xs leading-ui text-ink">{`$ ${INSTALL_COMMAND}`}</code>
					<a className="font-display text-sm leading-ui text-muted" href="/docs">
						Docs
					</a>
					<a className="font-display text-sm leading-ui text-muted" href={GITHUB_URL}>
						GitHub
					</a>
				</div>
				<div className="border-hairline w-full border bg-ground px-[16px] py-[14px] min-[900px]:hidden">
					<code className="font-mono text-[12px] leading-[19px] text-ink">{`$ ${INSTALL_COMMAND}`}</code>
				</div>
				<div className="flex w-full justify-between font-mono text-[10px] leading-xs text-muted-deep min-[900px]:hidden">
					<span>Raw archives. Your store.</span>
					<span>© 2026</span>
				</div>
			</div>
		</footer>
	);
}
