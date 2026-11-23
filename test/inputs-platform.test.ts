import assert from "node:assert/strict";
import { test } from "node:test";
import { parseInputs } from "../src/inputs.ts";
import { detectPlatform } from "../src/platform.ts";

test("input defaults and independently pinned SHA-256 validation", () => {
    assert.deepEqual(
        parseInputs(() => ""),
        {
            selector: { kind: "stable", value: "latest", range: "*" },
            edition: "generic",
            sha256: "",
            token: "",
        },
    );
    const values: Record<string, string> = {
        sha256: "A".repeat(64),
        edition: "extended",
        token: " token ",
    };
    const input = parseInputs((name) => values[name] ?? "");
    assert.equal(input.sha256, "a".repeat(64));
    assert.equal(input.token, "token");
    assert.throws(
        () => parseInputs((name) => (name === "sha256" ? "invalid" : "")),
        /Invalid sha256/,
    );
    assert.throws(
        () => parseInputs((name) => (name === "edition" ? "other" : "")),
        /Invalid edition/,
    );
});

for (const os of ["linux", "darwin", "win32"]) {
    for (const arch of ["x64", "arm64"]) {
        test(`platform mapping: ${os}/${arch}`, () => {
            const platform = detectPlatform("generic", os, arch);
            const name = os === "win32" ? "windows" : os;
            assert.equal(platform.arch, arch === "x64" ? "amd64" : "arm64");
            assert.equal(
                platform.archiveName,
                `bifroest-${name}-${platform.arch}-generic.${os === "win32" ? "zip" : "tgz"}`,
            );
            assert.equal(
                platform.binaryName,
                os === "win32" ? "bifroest.exe" : "bifroest",
            );
        });
    }
}

test("unsupported platforms fail before any release is downloaded", () => {
    assert.throws(
        () => detectPlatform("generic", "freebsd", "x64"),
        /Unsupported runner operating system/,
    );
    assert.throws(
        () => detectPlatform("generic", "linux", "ia32"),
        /Unsupported runner architecture/,
    );
    assert.throws(
        () => detectPlatform("extended", "win32", "x64"),
        /only available on Linux/,
    );
    assert.throws(
        () => detectPlatform("extended", "darwin", "arm64"),
        /only available on Linux/,
    );
    assert.equal(
        detectPlatform("extended", "linux", "arm64").edition,
        "extended",
    );
});
