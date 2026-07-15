const factLabels = ["✓ installed", "✓ live", "✓ fresh", "✓ nothing missed"] as const;

export function MechanismDoctor() {
	return (
		<section className="bg-ground">
			<div className="mx-auto flex w-full max-w-[1440px] flex-col gap-[36px] px-[20px] py-[80px] min-[900px]:gap-[56px] min-[900px]:px-[64px] min-[900px]:py-[120px]">
				<div className="flex flex-col gap-[36px] min-[900px]:flex-row min-[900px]:items-end min-[900px]:justify-between min-[900px]:gap-[96px]">
					<h2 className="text-h2-fluid font-display font-extrabold tracking-display text-ink min-[900px]:w-[45.7%] min-[900px]:shrink-0">
						Doctor watches the whole loop.
					</h2>
					<code className="border-hairline self-start rounded-md border bg-surface px-[18px] py-[16px] font-mono text-sm leading-[20px] text-ink min-[900px]:self-auto min-[900px]:px-[20px] min-[900px]:py-[18px] min-[900px]:text-base min-[900px]:leading-mono">
						$ packbat doctor
					</code>
				</div>
				<div className="border-hairline grid grid-cols-2 border-y min-[900px]:grid-cols-4">
					{factLabels.map((fact, index) => {
						const mobileColumn = index % 2 === 1 ? "border-hairline border-l pl-[16px]" : "pr-[12px]";
						const mobileRow = index >= 2 ? "border-hairline border-t min-[900px]:border-t-0" : "";
						const desktopColumn =
							index === 0
								? "min-[900px]:pr-[20px]"
								: `min-[900px]:border-hairline min-[900px]:border-l ${
										index === 3 ? "min-[900px]:pl-[20px]" : "min-[900px]:px-[20px]"
									}`;
						return (
							<h3
								className={`py-[20px] font-mono text-[12px] leading-ui text-ok min-[900px]:py-[24px] min-[900px]:text-xs ${mobileColumn} ${mobileRow} ${desktopColumn}`}
								key={fact}
							>
								{fact}
							</h3>
						);
					})}
				</div>
			</div>
		</section>
	);
}
