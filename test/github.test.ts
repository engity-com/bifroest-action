import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpClient, HttpClientError } from "@actions/http-client";
import { GitHubReleases } from "../src/github.ts";
import { parseSelector, type Release } from "../src/versions.ts";

const stable: Release = {
    id: 7,
    tag_name: "v0.7.7",
    draft: false,
    prerelease: false,
};
const beta: Release = {
    id: 8,
    tag_name: "v1.0.0-beta3",
    draft: false,
    prerelease: true,
};

test("moving versions paginate all releases and use the public API even on GHES", async (t) => {
    const requests: string[] = [];
    t.mock.method(HttpClient.prototype, "getJson", async <T>(url: string) => {
        requests.push(url);
        const result = url.endsWith("page=1")
            ? Array.from({ length: 100 }, () => beta)
            : [stable];
        return { statusCode: 200, result: result as T, headers: {} };
    });
    const source = new GitHubReleases();
    assert.equal(
        (await source.resolve(parseSelector("latest"))).tag_name,
        "v0.7.7",
    );
    assert.deepEqual(requests, [
        "https://api.github.com/repos/engity-com/bifroest/releases?per_page=100&page=1",
        "https://api.github.com/repos/engity-com/bifroest/releases?per_page=100&page=2",
    ]);
});

test("an exact prerelease bypasses stable selection and authenticates requests", async (t) => {
    t.mock.method(
        HttpClient.prototype,
        "getJson",
        async <T>(url: string, headers: Record<string, string>) => {
            assert.equal(
                url,
                "https://api.github.com/repos/engity-com/bifroest/releases/tags/v1.0.0-beta3",
            );
            assert.equal(headers.authorization, "Bearer secret");
            return { statusCode: 200, result: beta as T, headers: {} };
        },
    );
    assert.equal(
        (
            await new GitHubReleases("secret").resolve(
                parseSelector(beta.tag_name),
            )
        ).tag_name,
        beta.tag_name,
    );
});

test("draft and missing exact releases fail without falling back", async (t) => {
    const mock = t.mock.method(
        HttpClient.prototype,
        "getJson",
        async <T>() => ({
            statusCode: 200,
            result: { ...beta, draft: true } as T,
            headers: {},
        }),
    );
    const source = new GitHubReleases();
    await assert.rejects(
        source.resolve(parseSelector(beta.tag_name)),
        /not published/,
    );
    mock.mock.mockImplementation(async () => ({
        statusCode: 404,
        result: null,
        headers: {},
    }));
    await assert.rejects(
        source.resolve(parseSelector(beta.tag_name)),
        /not found/,
    );
});

test("API rate-limit failures explain optional token authentication", async (t) => {
    t.mock.method(HttpClient.prototype, "getJson", async () => {
        throw new HttpClientError("rate limit", 403);
    });
    await assert.rejects(
        new GitHubReleases().resolve(parseSelector("latest")),
        /HTTP 403.*token/,
    );
});

test("assets are paginated independently of the release response", async (t) => {
    const requests: string[] = [];
    const asset = {
        name: "bifroest-checksums.txt",
        browser_download_url:
            "https://github.com/engity-com/bifroest/releases/download/v0.7.7/bifroest-checksums.txt",
    };
    t.mock.method(HttpClient.prototype, "getJson", async <T>(url: string) => {
        requests.push(url);
        return {
            statusCode: 200,
            result: (url.endsWith("page=1")
                ? Array.from({ length: 100 }, () => asset)
                : []) as T,
            headers: {},
        };
    });
    assert.equal((await new GitHubReleases().assets(stable)).length, 100);
    assert.equal(requests.length, 2);
    assert.ok(requests[0]?.includes("/releases/7/assets?"));
});

test("unexpected asset URLs and off-origin downloads cannot receive tokens", async (t) => {
    t.mock.method(HttpClient.prototype, "getJson", async <T>() => ({
        statusCode: 200,
        result: [
            {
                name: "file.tgz",
                browser_download_url: "https://attacker.invalid/file.tgz",
            },
        ] as T,
        headers: {},
    }));
    const source = new GitHubReleases("secret");
    await assert.rejects(source.assets(stable), /Unexpected download URL/);
    for (const url of [
        "https://attacker.invalid/a",
        "http://github.com/engity-com/bifroest/releases/download/v1/a",
        "https://github.com/other/repo/releases/download/v1/a",
        "https://user@github.com/engity-com/bifroest/releases/download/v1/a",
    ]) {
        await assert.rejects(
            source.download({ name: "a", browser_download_url: url }, "unused"),
            /Refusing/,
        );
    }
});

test("asset URL validation accepts equivalent encoding of SemVer build metadata", async (t) => {
    const tag = "v1.2.3+build.1";
    const assets = [tag, encodeURIComponent(tag)].map((encoded) => ({
        name: "bifroest-checksums.txt",
        browser_download_url: `https://github.com/engity-com/bifroest/releases/download/${encoded}/bifroest-checksums.txt`,
    }));
    t.mock.method(HttpClient.prototype, "getJson", async <T>() => ({
        statusCode: 200,
        result: assets as T,
        headers: {},
    }));
    assert.equal(
        (await new GitHubReleases().assets({ ...stable, tag_name: tag }))
            .length,
        2,
    );
});
