import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
    copyFile,
    mkdir,
    mkdtemp,
    readdir,
    rm,
    writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ReleaseSource } from "../src/github.ts";
import { parseInputs } from "../src/inputs.ts";
import { type InstallDependencies, install } from "../src/install.ts";
import { detectPlatform } from "../src/platform.ts";

async function harness() {
    const temp = await mkdtemp(
        path.join(process.env.RUNNER_TEMP || os.tmpdir(), "bifroest-install-"),
    );
    const work = path.join(temp, "work with spaces");
    const cache = path.join(temp, "cache");
    await mkdir(work);
    await mkdir(cache);
    const platform = detectPlatform("generic");
    const contents = "verified archive contents";
    const digest = createHash("sha256").update(contents).digest("hex");
    const release = {
        id: 1,
        tag_name: "v1.0.0-beta3",
        prerelease: true,
        draft: false,
    };
    const assets = [platform.archiveName, "bifroest-checksums.txt"].map(
        (name) => ({
            name,
            browser_download_url: `https://example.invalid/${name}`,
        }),
    );
    const downloads: string[] = [];
    const cacheKeys: string[][] = [];
    const cached = new Map<string, string>();
    let extracted = 0;
    const source: ReleaseSource = {
        resolve: async () => release,
        assets: async () => assets,
        download: async (asset, destination) => {
            downloads.push(asset.name);
            await writeFile(
                destination,
                asset.name === "bifroest-checksums.txt"
                    ? `${digest}  ${platform.archiveName}\n`
                    : contents,
            );
            return destination;
        },
    };
    const deps: InstallDependencies = {
        source,
        tempRoot: work,
        info: () => {},
        cache: {
            find: (name, version, arch) => {
                cacheKeys.push([name, version, arch ?? ""]);
                return cached.get(`${name}/${version}/${arch}`) ?? "";
            },
            cacheFile: async (file, target, name, version, arch) => {
                const directory = path.join(cache, String(cached.size));
                await mkdir(directory);
                await copyFile(file, path.join(directory, target));
                cached.set(`${name}/${version}/${arch}`, directory);
                return directory;
            },
        },
        extract: async (_archive, destination) => {
            extracted++;
            await mkdir(destination);
            await writeFile(
                path.join(destination, platform.binaryName),
                "executable",
            );
            return destination;
        },
    };
    const input = parseInputs((name) =>
        name === "version" ? release.tag_name : "",
    );
    return {
        temp,
        work,
        cache,
        platform,
        digest,
        deps,
        input,
        assets,
        release,
        downloads,
        cacheKeys,
        extracted: () => extracted,
        cleanup: () => rm(temp, { recursive: true, force: true }),
    };
}

test("fresh install verifies, caches, extracts and retains the executable for later steps", async () => {
    const h = await harness();
    try {
        const result = await install(h.input, h.platform, h.deps);
        assert.equal(result.version, "v1.0.0-beta3");
        assert.ok(result.binaryPath.endsWith(h.platform.binaryName));
        assert.equal(h.extracted(), 1);
        assert.deepEqual(h.downloads, [
            "bifroest-checksums.txt",
            h.platform.archiveName,
        ]);
        assert.deepEqual(h.cacheKeys[0], [
            `bifroest-${h.platform.os}-generic-${h.digest}`,
            "1.0.0-beta3",
            h.platform.arch,
        ]);
        assert.equal((await readdir(h.work)).length, 1);
    } finally {
        await h.cleanup();
    }
});

test("cache hits still resolve the selector, retrieve checksums and verify archive bytes", async () => {
    const h = await harness();
    try {
        await install(h.input, h.platform, h.deps);
        await install(h.input, h.platform, h.deps);
        assert.deepEqual(h.downloads, [
            "bifroest-checksums.txt",
            h.platform.archiveName,
            "bifroest-checksums.txt",
        ]);
        assert.equal(h.extracted(), 2);
        h.release.tag_name = "v1.0.0";
        await install(h.input, h.platform, h.deps);
        assert.equal(
            h.downloads.filter((name) => name === h.platform.archiveName)
                .length,
            2,
        );
        assert.equal(h.cacheKeys.at(-1)?.[1], "1.0.0");
    } finally {
        await h.cleanup();
    }
});

test("a corrupt cached archive is never extracted", async () => {
    const h = await harness();
    try {
        await install(h.input, h.platform, h.deps);
        await writeFile(
            path.join(h.cache, "0", h.platform.archiveName),
            "tampered",
        );
        await assert.rejects(
            install(h.input, h.platform, h.deps),
            /SHA-256 mismatch/,
        );
        assert.equal(h.extracted(), 1);
        assert.equal((await readdir(h.work)).length, 1);
    } finally {
        await h.cleanup();
    }
});

test("an independently pinned digest is enforced before archive download", async () => {
    const h = await harness();
    try {
        await assert.rejects(
            install({ ...h.input, sha256: "0".repeat(64) }, h.platform, h.deps),
            /independently pinned/,
        );
        assert.equal(h.extracted(), 0);
        assert.deepEqual(h.downloads, ["bifroest-checksums.txt"]);
        assert.deepEqual(await readdir(h.work), []);
    } finally {
        await h.cleanup();
    }
});

test("corrupt downloads are neither cached nor extracted", async () => {
    const h = await harness();
    try {
        const original = h.deps.source.download;
        h.deps.source.download = async (asset, dest) => {
            const file = await original(asset, dest);
            if (asset.name === h.platform.archiveName)
                await writeFile(file, "broken");
            return file;
        };
        await assert.rejects(
            install(h.input, h.platform, h.deps),
            /SHA-256 mismatch/,
        );
        assert.equal(h.extracted(), 0);
        assert.deepEqual(await readdir(h.cache), []);
        assert.deepEqual(await readdir(h.work), []);
    } finally {
        await h.cleanup();
    }
});

test("missing assets and incomplete releases do not fall back to another release", async () => {
    const h = await harness();
    try {
        h.assets.length = 0;
        await assert.rejects(
            install(h.input, h.platform, h.deps),
            /upload is incomplete/,
        );
        assert.equal(h.extracted(), 0);
        assert.deepEqual(h.downloads, []);
    } finally {
        await h.cleanup();
    }
});

test("missing or non-regular extracted executables fail and clean up the attempt", async () => {
    const h = await harness();
    try {
        h.deps.extract = async (_archive, destination) => {
            await mkdir(path.join(destination, h.platform.binaryName), {
                recursive: true,
            });
            return destination;
        };
        await assert.rejects(
            install(h.input, h.platform, h.deps),
            /regular executable/,
        );
        assert.deepEqual(await readdir(h.work), []);
    } finally {
        await h.cleanup();
    }
});
