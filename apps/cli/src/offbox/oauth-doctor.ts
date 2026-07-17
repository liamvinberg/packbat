import type { RemoteConfig } from "../core/config.js";
import type { PackbatHome } from "../core/home.js";
import { readManagedRcloneRemote } from "./managed-rclone-config.js";
import { probeRcloneOAuth, type RcloneOAuthFailure } from "./rclone.js";

export type OAuthProvider = "Google Drive" | "Dropbox";

export type OAuthProbe =
	| { status: "not-oauth" }
	| { status: "ok"; provider: OAuthProvider }
	| { status: "reauthenticate"; provider: OAuthProvider; errorClass: RcloneOAuthFailure["errorClass"] }
	| { status: "repair-client"; provider: OAuthProvider; errorClass: RcloneOAuthFailure["errorClass"] }
	| { status: "unclassified"; provider: OAuthProvider };

export async function probeOAuthRemote(home: PackbatHome, remote: RemoteConfig): Promise<OAuthProbe> {
	if (remote.type !== "rclone") return { status: "not-oauth" };
	if (remote.rcloneConfig !== "managed") return { status: "not-oauth" };
	let section: Awaited<ReturnType<typeof readManagedRcloneRemote>>;
	try {
		section = await readManagedRcloneRemote(home.rcloneConfPath, remote.destination);
	} catch {
		return { status: "not-oauth" };
	}
	const provider = section?.type === "drive" ? "Google Drive" : section?.type === "dropbox" ? "Dropbox" : null;
	if (provider === null) return { status: "not-oauth" };
	const probe = await probeRcloneOAuth(remote.destination, remote.rcloneConfig);
	if (probe.ok) return { status: "ok", provider };
	if (probe.failure?.kind === "grant") {
		return { status: "reauthenticate", provider, errorClass: probe.failure.errorClass };
	}
	if (probe.failure?.kind === "client") {
		return { status: "repair-client", provider, errorClass: probe.failure.errorClass };
	}
	return { status: "unclassified", provider };
}
