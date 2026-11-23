import assert from "node:assert/strict";
import { test } from "node:test";
import {
    parseSelector,
    type Release,
    releaseVersion,
    selectStable,
} from "../src/versions.ts";

function release(tag_name: string, values: Partial<Release> = {}): Release {
    return { id: 1, tag_name, draft: false, prerelease: false, ...values };
}

function select(tags: Release[], input = "latest"): string {
    const selector = parseSelector(input);
    assert.equal(selector.kind, "stable");
    if (selector.kind !== "stable") throw new Error("not a stable selector");
    return selectStable(tags, selector).tag_name;
}

test("default is latest; explicit stable and prerelease tags remain exact", () => {
    assert.deepEqual(parseSelector(""), {
        kind: "stable",
        value: "latest",
        range: "*",
    });
    for (const version of [
        "v0.7.7",
        "v1.2.3",
        "v1.0.0-beta3",
        "v2.0.0-rc.1+build.7",
    ]) {
        assert.deepEqual(parseSelector(version), {
            kind: "exact",
            value: version,
        });
    }
});

test("latest uses SemVer rather than API order or GitHub's latest flag", () => {
    assert.equal(
        select([release("v1.9.9"), release("v0.7.7"), release("v1.10.0")]),
        "v1.10.0",
    );
});

test("major and minor selectors choose only their own stable versions", () => {
    const tags = ["v2.0.0", "v1.3.0", "v1.2.9", "v1.2.10", "v0.7.7"].map(
        (tag) => release(tag),
    );
    assert.equal(select(tags, "v1"), "v1.3.0");
    assert.equal(select(tags, "v1.2"), "v1.2.10");
    assert.equal(select(tags, "v0"), "v0.7.7");
});

test("both prerelease flags and prerelease SemVer tags are excluded", () => {
    const tags = [
        release("v1.0.0-beta3"),
        release("v1.0.0", { prerelease: true }),
        release("v3.0.0", { draft: true }),
        release("main"),
        release("v1"),
        release("v0.7.7"),
    ];
    assert.equal(select(tags), "v0.7.7");
    assert.throws(() => select(tags, "v1"), /No published stable/);
});

test("empty or unmatched selections do not silently fall back", () => {
    assert.throws(() => select([]), /No published stable/);
    assert.throws(
        () => select([release("v2.0.0")], "v1.2"),
        /No published stable/,
    );
});

test("ambiguous, unsafe and non-SemVer selectors are rejected", () => {
    for (const value of [
        "main",
        "1",
        "1.2.3",
        "v01",
        "v1.02",
        "v01.2.3",
        "v1.0.0-01",
        "v1.*",
        ">=1",
        "latest; id",
        "v1\n.2",
        "v9007199254740992",
    ]) {
        assert.throws(() => parseSelector(value), /Invalid version/, value);
    }
    assert.equal(releaseVersion("v1.02.3"), null);
});
