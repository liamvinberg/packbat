import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(repositoryRoot, "apps", "cli");
const formerName = ["blot", "ter"].join("");

function fail(message) {
	throw new Error(message);
}

function run(command, args, options = {}) {
	return execFileSync(command, args, {
		cwd: options.cwd ?? repositoryRoot,
		encoding: "utf8",
		stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
	});
}

function checkCurrentTrackedFiles() {
	const stale = [];
	for (const path of run("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
		.split("\0")
		.filter(Boolean)) {
		if (!existsSync(join(repositoryRoot, path))) {
			continue;
		}
		if (path.toLowerCase().includes(formerName)) {
			stale.push(`${path} (path)`);
			continue;
		}
		const contents = readFileSync(join(repositoryRoot, path));
		if (contents.toString("utf8").toLowerCase().includes(formerName)) {
			stale.push(path);
		}
	}
	if (stale.length > 0) {
		fail(`stale former-name references in current tracked files:\n${stale.map((path) => `- ${path}`).join("\n")}`);
	}
}

function checkMetadata() {
	const metadata = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
	const expected = {
		name: "packbat",
		license: "MIT",
		homepage: "https://packbat.dev",
		repository: { type: "git", url: "git+https://github.com/liamvinberg/packbat.git" },
		bugs: { url: "https://github.com/liamvinberg/packbat/issues" },
		engines: { node: ">=22.16" },
		bin: { packbat: "./bin/packbat.js" },
		publishConfig: { access: "public" },
	};
	for (const [key, value] of Object.entries(expected)) {
		if (JSON.stringify(metadata[key]) !== JSON.stringify(value)) {
			fail(`package.json ${key} must be ${JSON.stringify(value)}`);
		}
	}
}

function unpackManifest(output) {
	const parsed = JSON.parse(output);
	const manifests = Array.isArray(parsed) ? parsed : Object.values(parsed);
	if (manifests.length !== 1 || manifests[0] === undefined) {
		fail("npm pack did not return exactly one manifest");
	}
	return manifests[0];
}

function checkTarballFiles(manifest) {
	const paths = manifest.files.map(({ path }) => path);
	const unexpected = paths.filter(
		(path) =>
			path !== "package.json" &&
			path !== "README.md" &&
			path !== "LICENSE" &&
			path !== "bin/packbat.js" &&
			!/^dist\/[a-z0-9-]+\.js$/i.test(path),
	);
	if (unexpected.length > 0) {
		fail(`unexpected files in npm tarball:\n${unexpected.map((path) => `- ${path}`).join("\n")}`);
	}
	for (const required of ["package.json", "README.md", "LICENSE", "bin/packbat.js", "dist/main.js"]) {
		if (!paths.includes(required)) {
			fail(`npm tarball is missing ${required}`);
		}
	}
	const executable = manifest.files.find(({ path }) => path === "bin/packbat.js");
	if (executable?.mode !== 0o755) {
		fail("bin/packbat.js is not executable in the npm tarball");
	}
}

async function main() {
	checkCurrentTrackedFiles();
	checkMetadata();
	run("pnpm", ["-C", "apps/cli", "build"], { stdio: "inherit" });

	const temporaryRoot = await mkdtemp(join(tmpdir(), "packbat-release-check-"));
	try {
		const manifest = unpackManifest(
			run("npm", ["pack", "--json", "--pack-destination", temporaryRoot], { cwd: packageRoot }),
		);
		checkTarballFiles(manifest);

		const tarball = join(temporaryRoot, manifest.filename);
		const installRoot = join(temporaryRoot, "install");
		run("npm", ["install", "--prefix", installRoot, "--ignore-scripts", "--no-audit", "--no-fund", tarball], {
			stdio: "inherit",
		});
		const binRoot = join(installRoot, "node_modules", ".bin");
		const executable = join(binRoot, process.platform === "win32" ? "packbat.cmd" : "packbat");
		const formerExecutable = join(binRoot, process.platform === "win32" ? `${formerName}.cmd` : formerName);
		if (!existsSync(executable) || existsSync(formerExecutable)) {
			fail("clean install must expose only the packbat executable");
		}
		const version = run(executable, ["--version"]).trim();
		if (version !== manifest.version) {
			fail(`installed packbat reported ${version}; expected ${manifest.version}`);
		}
		const help = run(executable, ["--help"]);
		if (!help.includes("Packbat") || help.toLowerCase().includes(formerName)) {
			fail("installed packbat help does not use the canonical product identity");
		}
		const installedMetadata = JSON.parse(
			await readFile(join(installRoot, "node_modules", "packbat", "package.json"), "utf8"),
		);
		if (installedMetadata.name !== "packbat" || installedMetadata.version !== manifest.version) {
			fail("installed package metadata does not match the packed manifest");
		}
	} finally {
		await rm(temporaryRoot, { recursive: true, force: true });
	}
}

await main();
