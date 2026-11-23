import { chmod, lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import * as cache from "@actions/tool-cache";
import type { ReleaseAsset, ReleaseSource } from "./github.ts";
import type { Inputs } from "./inputs.ts";
import { archiveChecksum, verifyArchive } from "./integrity.ts";
import type { Platform } from "./platform.ts";

export interface Installation {
    version: string;
    binaryPath: string;
}

export interface InstallDependencies {
    source: ReleaseSource;
    cache: Pick<typeof cache, "find" | "cacheFile">;
    extract: (
        archive: string,
        destination: string,
        platform: Platform,
    ) => Promise<string>;
    tempRoot: string;
    info: (message: string) => void;
}

export async function extractArchive(
    archive: string,
    destination: string,
    platform: Platform,
): Promise<string> {
    return platform.os === "windows"
        ? cache.extractZip(archive, destination)
        : cache.extractTar(archive, destination);
}

function assetNamed(assets: ReleaseAsset[], name: string): ReleaseAsset {
    const matches = assets.filter((asset) => asset.name === name);
    if (matches.length !== 1) {
        throw new Error(
            `The selected Bifröst release must contain exactly one ${name} asset. This platform/edition may not be available, or the release upload is incomplete. No other version will be substituted.`,
        );
    }
    return matches[0] as ReleaseAsset;
}

export async function install(
    inputs: Inputs,
    platform: Platform,
    deps: InstallDependencies,
): Promise<Installation> {
    const release = await deps.source.resolve(inputs.selector);
    deps.info(`Resolved ${inputs.selector.value} to ${release.tag_name}.`);
    const assets = await deps.source.assets(release);
    const archive = assetNamed(assets, platform.archiveName);
    const checksumAsset = assetNamed(assets, "bifroest-checksums.txt");
    const work = await mkdtemp(path.join(deps.tempRoot, "bifroest-"));
    let installed = false;
    try {
        const checksumFile = await deps.source.download(
            checksumAsset,
            path.join(work, "checksums.txt"),
        );
        if ((await lstat(checksumFile)).size > 8 * 1024 * 1024) {
            throw new Error("Bifröst checksum file exceeds the 8 MiB limit.");
        }
        const digest = archiveChecksum(
            await readFile(checksumFile, "utf8"),
            platform.archiveName,
        );
        if (inputs.sha256 && inputs.sha256 !== digest) {
            throw new Error(
                "The release checksum does not match the independently pinned sha256 input.",
            );
        }

        // Cache immutable archives, never mutable extracted executables. Even a cache
        // hit is rehashed against the freshly retrieved checksum before extraction.
        const toolName = `bifroest-${platform.os}-${platform.edition}-${digest}`;
        const version = release.tag_name.slice(1);
        const cached = deps.cache.find(toolName, version, platform.arch);
        let archiveFile: string;
        if (cached) {
            deps.info(`Using cached archive for ${release.tag_name}.`);
            archiveFile = path.join(cached, platform.archiveName);
            const stat = await lstat(archiveFile);
            if (!stat.isFile() || stat.isSymbolicLink()) {
                throw new Error(
                    "Cached Bifröst archive is not a regular file.",
                );
            }
            await verifyArchive(archiveFile, digest);
        } else {
            deps.info(`Downloading ${platform.archiveName}.`);
            archiveFile = await deps.source.download(
                archive,
                path.join(work, platform.archiveName),
            );
            await verifyArchive(archiveFile, digest);
            await deps.cache.cacheFile(
                archiveFile,
                platform.archiveName,
                toolName,
                version,
                platform.arch,
            );
        }

        const directory = await deps.extract(
            archiveFile,
            path.join(work, "bin"),
            platform,
        );
        const binaryPath = path.join(directory, platform.binaryName);
        const stat = await lstat(binaryPath);
        if (!stat.isFile() || stat.isSymbolicLink()) {
            throw new Error(
                "The Bifröst archive does not contain a regular executable.",
            );
        }
        if (platform.os !== "windows") await chmod(binaryPath, 0o755);
        installed = true;
        return { version: release.tag_name, binaryPath };
    } finally {
        // Successful installs must survive for later job steps. Failed attempts do not.
        if (!installed) await rm(work, { recursive: true, force: true });
    }
}
