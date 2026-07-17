import { packbatVersion } from "../core/version.js";

let availableUpdateVersion: string | null = null;

export function cloudUpdateAvailableVersion(): string | null {
	return availableUpdateVersion;
}

// Every request to the Packbat API goes through here so no endpoint can forget the
// version header or the update latch. GitHub and presigned R2 requests must not.
export async function packbatApiFetch(input: string, init: RequestInit = {}): Promise<Response> {
	const headers = new Headers(init.headers);
	headers.set("x-packbat-cli-version", packbatVersion());
	const response = await fetch(input, { ...init, headers });
	availableUpdateVersion = response.headers.get("x-packbat-cli-update") ?? availableUpdateVersion;
	return response;
}
