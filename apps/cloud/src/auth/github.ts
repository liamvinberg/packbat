import { z } from "zod";

const githubUserSchema = z.object({
	id: z.number().int().positive().safe(),
	login: z.string().min(1),
});

export interface GitHubIdentity {
	login: string;
	subjectId: string;
}

export async function verifyGitHubAccessToken(accessToken: string): Promise<GitHubIdentity | null> {
	const response = await fetch("https://api.github.com/user", {
		headers: {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${accessToken}`,
			"User-Agent": "Packbat-Cloud",
			"X-GitHub-Api-Version": "2022-11-28",
		},
	});
	if (!response.ok) {
		return null;
	}
	const result = githubUserSchema.safeParse(await response.json());
	return result.success ? { login: result.data.login, subjectId: String(result.data.id) } : null;
}
