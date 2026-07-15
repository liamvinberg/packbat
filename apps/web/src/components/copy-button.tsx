import { useEffect, useRef, useState } from "react";

type CopyButtonProps = {
	text: string;
	variant: "landing-desktop" | "plain";
};

const RESET_DELAY_MS = 1_500;

export function CopyButton({ text, variant }: CopyButtonProps) {
	const [copied, setCopied] = useState(false);
	const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	useEffect(() => () => clearTimeout(resetTimer.current), []);

	async function copy() {
		await navigator.clipboard.writeText(text);
		setCopied(true);
		clearTimeout(resetTimer.current);
		resetTimer.current = setTimeout(() => setCopied(false), RESET_DELAY_MS);
	}

	const className =
		variant === "landing-desktop"
			? "inline-flex min-w-[104px] items-center justify-center gap-[8px] rounded-xs bg-accent px-[18px] py-[11px] font-display text-sm leading-ui font-bold text-ground"
			: "inline-flex min-w-[50px] items-center justify-center font-mono text-[11px] leading-[21px] text-accent";

	return (
		<button className={className} onClick={copy} type="button">
			{variant === "landing-desktop" ? (
				<svg aria-hidden="true" fill="none" height="14" viewBox="0 0 16 16" width="14">
					<rect height="8" rx="1.5" stroke="#000000" strokeWidth="1.8" width="8" x="5" y="5" />
					<path
						d="M11 5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5.5A1.5 1.5 0 0 0 4 11h1"
						stroke="#000000"
						strokeWidth="1.8"
					/>
				</svg>
			) : null}
			<span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
		</button>
	);
}
