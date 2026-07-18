// Repairs paste artifacts in agent-written SQL before SQLite sees it. The invariant:
// only sequences that can never appear in valid SQL are rewritten, and only outside
// strings, quoted identifiers, and block comments, so no valid query changes meaning.
// One deliberate exception: a literal \n inside a -- comment becomes a real newline,
// because left alone the comment swallows the rest of the statement and silently
// changes results.

export interface SqlScan {
	sql: string;
	moreAfterSemicolon: boolean;
	unterminated: boolean;
	backslashQuote: boolean;
	curlyQuote: boolean;
	invalidBackslash: boolean;
}

type State = "code" | "single" | "double" | "backtick" | "bracket" | "line-comment" | "block-comment";

const ZERO_WIDTH = new Set(["\u{200b}", "\u{2060}", "\u{feff}"]);
const SPACE_LIKE = new Set(["\u{00a0}", "\u{202f}", "\u{2007}"]);
const CURLY_QUOTES = new Set(["‘", "’", "“", "”"]);
const QUOTE_OF = { single: "'", double: '"', backtick: "`" } as const;

export function scanSql(input: string): SqlScan {
	let out = "";
	let state: State = "code";
	let semicolonAt = -1;
	let moreAfterSemicolon = false;
	let backslashQuote = false;
	let curlyQuote = false;
	let invalidBackslash = false;
	const content = (): void => {
		if (semicolonAt !== -1) moreAfterSemicolon = true;
	};
	let index = 0;
	while (index < input.length) {
		const char = input[index]!;
		const next = input[index + 1];
		if ((state === "code" || state === "line-comment") && char === "\\") {
			let end = index;
			while (input[end] === "\\") end += 1;
			const after = input[end];
			if (after === "n" || after === "r") {
				out += "\n";
				if (state === "line-comment") state = "code";
				index = end + 1;
				continue;
			}
			if (after === "t") {
				out += "\t";
				index = end + 1;
				continue;
			}
			if (state === "code") {
				invalidBackslash = true;
				content();
			}
			out += input.slice(index, end);
			index = end;
			continue;
		}
		if (state === "line-comment") {
			if (char === "\n") state = "code";
			out += char;
			index += 1;
			continue;
		}
		if (state === "block-comment") {
			if (char === "*" && next === "/") {
				out += "*/";
				state = "code";
				index += 2;
				continue;
			}
			out += char;
			index += 1;
			continue;
		}
		if (state === "single" || state === "double" || state === "backtick") {
			const quote = QUOTE_OF[state];
			if (char === quote) {
				if (next === quote) {
					out += quote + quote;
					index += 2;
					continue;
				}
				state = "code";
			} else if (char === "\\" && (next === "'" || next === '"')) {
				backslashQuote = true;
			}
			out += char;
			index += 1;
			continue;
		}
		if (state === "bracket") {
			if (char === "]") state = "code";
			out += char;
			index += 1;
			continue;
		}
		if (char === "-" && next === "-") {
			out += "--";
			state = "line-comment";
			index += 2;
			continue;
		}
		if (char === "/" && next === "*") {
			out += "/*";
			state = "block-comment";
			index += 2;
			continue;
		}
		if (char === "'" || char === '"' || char === "`" || char === "[") {
			content();
			state = char === "'" ? "single" : char === '"' ? "double" : char === "`" ? "backtick" : "bracket";
			out += char;
			index += 1;
			continue;
		}
		if (char === ";") {
			content();
			semicolonAt = out.length;
			out += char;
			index += 1;
			continue;
		}
		if (ZERO_WIDTH.has(char)) {
			index += 1;
			continue;
		}
		if (SPACE_LIKE.has(char)) {
			out += " ";
			index += 1;
			continue;
		}
		if (CURLY_QUOTES.has(char)) {
			curlyQuote = true;
			content();
		} else if (!/\s/.test(char)) {
			content();
		}
		out += char;
		index += 1;
	}
	if (semicolonAt !== -1 && !moreAfterSemicolon) {
		out = out.slice(0, semicolonAt) + out.slice(semicolonAt + 1);
	}
	return {
		sql: out,
		moreAfterSemicolon,
		unterminated: state === "single" || state === "double" || state === "backtick" || state === "bracket",
		backslashQuote,
		curlyQuote,
		invalidBackslash,
	};
}
