import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { archiveChecksum, verifyArchive } from "../src/integrity.ts";

const hash = "a".repeat(64);

test("checksum formats from old and current releases, GNU binary mode and CRLF", () => {
    for (const separator of [" ", "  ", " *"]) {
        assert.equal(
            archiveChecksum(
                `${hash.toUpperCase()}${separator}file.tgz\r\n`,
                "file.tgz",
            ),
            hash,
        );
    }
});

test("missing, duplicate and malformed checksums fail closed", () => {
    assert.throws(
        () => archiveChecksum(`${hash} other.tgz`, "file.tgz"),
        /exactly one/,
    );
    assert.throws(
        () => archiveChecksum(`${hash} file.tgz\n${hash} file.tgz`, "file.tgz"),
        /exactly one/,
    );
    assert.throws(
        () => archiveChecksum("invalid file.tgz", "file.tgz"),
        /Malformed/,
    );
});

test("archives are streamed through SHA-256 and corrupted content is rejected", async () => {
    const temp = await mkdtemp(
        path.join(process.env.RUNNER_TEMP || os.tmpdir(), "bifroest-hash-"),
    );
    try {
        const filename = path.join(temp, "archive.tgz");
        await writeFile(filename, "archive contents");
        await verifyArchive(
            filename,
            createHash("sha256").update("archive contents").digest("hex"),
        );
        await assert.rejects(verifyArchive(filename, hash), /SHA-256 mismatch/);
    } finally {
        await rm(temp, { recursive: true, force: true });
    }
});
