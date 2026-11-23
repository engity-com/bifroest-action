import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { extractArchive } from "../src/install.ts";
import { detectPlatform } from "../src/platform.ts";

// Tiny original fixtures, containing just the text "fixture". No upstream code.
const tgz =
    "H4sIAAAAAAAC/+3NMQqEQBAEwHmKT9hk8T0KCkbCuoLPv/Wi43IFsSrpoTuYcZnLOm01LpSaPudvNv95rj/32fc55ehS3GDf6lDay3ineTnqXqYAAAAAAAAAAADgWT7rEQFGACgAAA==";
const zip =
    "UEsDBBQAAAAAAAAAIVzuQOUFBwAAAAcAAAAMAAAAYmlmcm9lc3QuZXhlZml4dHVyZVBLAQIUAxQAAAAAAAAAIVzuQOUFBwAAAAcAAAAMAAAAAAAAAAAAAACAAQAAAABiaWZyb2VzdC5leGVQSwUGAAAAAAEAAQA6AAAAMQAAAAAA";

test("the real archive extractor works with native tools and paths containing spaces", async () => {
    const temp = await mkdtemp(
        path.join(process.env.RUNNER_TEMP || os.tmpdir(), "bifroest-extract-"),
    );
    try {
        const directory = path.join(temp, "directory with spaces");
        await mkdir(directory);
        const platform = detectPlatform("generic");
        const archive = path.join(directory, platform.archiveName);
        await writeFile(
            archive,
            Buffer.from(platform.os === "windows" ? zip : tgz, "base64"),
        );
        const destination = await extractArchive(
            archive,
            path.join(directory, "extracted"),
            platform,
        );
        assert.equal(
            await readFile(path.join(destination, platform.binaryName), "utf8"),
            "fixture",
        );
    } finally {
        await rm(temp, { recursive: true, force: true });
    }
});
