import assert from "node:assert/strict";
import {
    GitHubError,
    type GitHubRequest,
    type MajorTagOptions,
    updateMajorTag,
} from "../../mise-tasks/ci/update-major-tag.ts";
import {
    compareStable,
    majorTagDecision,
    type PublishedRelease,
    stableVersion,
    type VersionTag,
} from "../../mise-tasks/lib/release-policy.ts";

const sha = "a".repeat(40);
const old = "b".repeat(40);
const newer = "c".repeat(40);
const annotation = "d".repeat(40);
const nested = "e".repeat(40);
const absent = "0".repeat(40);
const release: PublishedRelease = {
    tag_name: "v1.0.1",
    draft: false,
    prerelease: false,
    published_at: "2026-11-23T12:00:00Z",
};
const tag = (name: string, oid = sha): VersionTag => ({
    name,
    commit: { sha: oid },
});

Deno.test("stable SemVer accepts complete versions, optional v, and build metadata", () => {
    for (const value of [
        "v1.0.1",
        "1.0.1",
        "v0.0.0",
        "v1.0.1+build.001",
        "v1.0.1+linux-beta1",
    ]) {
        assert.ok(stableVersion(value), value);
    }
    for (const value of [
        "v1",
        "v1.0",
        "latest",
        "v01.0.1",
        "v1.00.1",
        "v1.0.01",
        "v1.0.1-beta1",
        "v1.0.1-rc.1+build.1",
        "v1.0.1-",
        "v1.0.1+",
        "v1.0.1+build..1",
        " v1.0.1",
        "v1.0.1\n",
        "V1.0.1",
        "v1.0.1/refs/heads/main",
    ])
        assert.equal(stableVersion(value), null, value);
});

Deno.test("stable version comparison is numeric, not lexicographic, dated, or API ordered", () => {
    const a = stableVersion("v1.10.0");
    const b = stableVersion("v1.9.99");
    assert.ok(a && b);
    assert.equal(compareStable(a, b), 1);
    assert.equal(compareStable(b, a), -1);
    assert.equal(compareStable(a, a), 0);
    assert.equal(
        majorTagDecision({ ...release, tag_name: "v1.9.99" }, [
            tag("v1.9.99"),
            tag("v1.10.0"),
        ]).eligible,
        false,
    );
});

Deno.test("SemVer core numbers are compared without machine integer overflow", () => {
    const a = stableVersion("v999999999999999999999.0.2");
    const b = stableVersion("v999999999999999999999.0.1");
    assert.ok(a && b);
    assert.equal(compareStable(a, b), 1);
});

Deno.test("each major follows its own highest stable tag, even after a newer major is released", () => {
    assert.deepEqual(
        majorTagDecision(release, [
            tag("v1.0.0", old),
            tag("v2.0.0", newer),
            tag("v1.0.1"),
            tag("v1.1.0-beta1"),
        ]),
        {
            eligible: true,
            tag: "v1.0.1",
            alias: "v1",
            sha,
        },
    );
    assert.deepEqual(
        majorTagDecision({ ...release, tag_name: "v2.0.0" }, [
            tag("v1.99.99"),
            tag("v2.0.0"),
        ]),
        {
            eligible: true,
            tag: "v2.0.0",
            alias: "v2",
            sha,
        },
    );
});

Deno.test("drafts, unpublished releases, GitHub prerelease flags, and prerelease tag names never promote", () => {
    for (const change of [
        { draft: true },
        { prerelease: true },
        { published_at: null },
        { published_at: "" },
        { tag_name: "v1.0.2-beta1" },
        { tag_name: "v1.0.2-rc.1" },
        { tag_name: "v1" },
    ])
        assert.equal(
            majorTagDecision({ ...release, ...change }, []).eligible,
            false,
        );
});

Deno.test("a higher stable tag blocks an older release even without a corresponding published release", () => {
    assert.equal(
        majorTagDecision(release, [tag("v1.0.1"), tag("v1.0.2", newer)])
            .eligible,
        false,
    );
});

Deno.test("build metadata has no precedence and equal versions must point to the same commit", () => {
    assert.equal(
        majorTagDecision(release, [tag("v1.0.1"), tag("1.0.1+build.2")])
            .eligible,
        true,
    );
    assert.throws(
        () =>
            majorTagDecision(release, [
                tag("v1.0.1"),
                tag("1.0.1+build.2", newer),
            ]),
        /ambiguous/,
    );
    assert.equal(
        majorTagDecision({ ...release, tag_name: "1.0.1+build.2" }, [
            tag("v1.0.1"),
            tag("1.0.1+build.2"),
        ]).eligible,
        true,
    );
});

Deno.test("older releases skip consistently regardless of API ordering or ambiguities below the maximum", () => {
    const tags = [
        tag("v1.0.1"),
        tag("1.0.1+build.1", old),
        tag("v1.0.2", newer),
    ];
    assert.deepEqual(
        majorTagDecision(release, tags),
        majorTagDecision(release, [...tags].reverse()),
    );
    assert.equal(majorTagDecision(release, tags).eligible, false);
});

Deno.test("missing, duplicate, and malformed release tag targets are rejected", () => {
    for (const tags of [
        [],
        [tag("v1.0.1"), tag("v1.0.1")],
        [tag("v1.0.1", "not-a-sha")],
        [tag("v1.0.1", absent)],
    ]) {
        assert.throws(
            () => majorTagDecision(release, tags),
            /exactly one matching/,
        );
    }
});

interface GitObject {
    type: string;
    sha: string;
}

interface Scenario {
    release?: Partial<PublishedRelease>;
    releaseAfterFirst?: Partial<PublishedRelease>;
    tags?: VersionTag[];
    tagsAfterFirst?: VersionTag[];
    pages?: VersionTag[][];
    current?: GitObject | null;
    currentAfterFirst?: GitObject | null;
    source?: GitObject;
    annotated?: "single" | "nested" | "cycle";
    aliasError?: number;
    missingSource?: boolean;
    denied?: boolean;
    malformedResponse?: boolean;
    newerDuringMutation?: boolean;
    raceCreation?: boolean;
    alwaysRace?: boolean;
}

interface RefMutation {
    name: string;
    beforeOid: string;
    afterOid: string;
    force: boolean;
}

function github(scenario: Scenario = {}) {
    const calls: { endpoint: string; method: string; body?: unknown }[] = [];
    let inspections = 0;
    let current =
        scenario.current === undefined
            ? { type: "commit", sha: old }
            : scenario.current;
    let tags = scenario.tags ?? [tag("v1.0.1")];
    let updates = 0;
    let mutations = 0;
    function currentRelease() {
        return {
            ...release,
            ...scenario.release,
            ...(inspections > 1 ? scenario.releaseAfterFirst : {}),
        };
    }
    const request: GitHubRequest = (endpoint, method = "GET", body) => {
        calls.push({ endpoint, method, body });
        if (endpoint === "/releases/7") {
            inspections++;
            if (inspections === 2 && scenario.currentAfterFirst !== undefined)
                current = scenario.currentAfterFirst;
            if (inspections === 2 && scenario.tagsAfterFirst)
                tags = scenario.tagsAfterFirst;
            return Promise.resolve(currentRelease());
        }
        if (endpoint.startsWith("/tags?")) {
            const page = Number(
                new URL(`https://example.test${endpoint}`).searchParams.get(
                    "page",
                ),
            );
            return Promise.resolve(
                scenario.pages?.[page - 1] ?? (page === 1 ? tags : []),
            );
        }
        if (
            endpoint ===
            `/git/ref/tags/${encodeURIComponent(currentRelease().tag_name)}`
        ) {
            if (scenario.missingSource) throw new GitHubError(404, endpoint);
            return Promise.resolve({
                object:
                    scenario.source ??
                    (scenario.annotated
                        ? { type: "tag", sha: annotation }
                        : { type: "commit", sha }),
            });
        }
        if (endpoint === `/git/tags/${annotation}`) {
            return Promise.resolve({
                object:
                    scenario.annotated === "nested"
                        ? { type: "tag", sha: nested }
                        : scenario.annotated === "cycle"
                          ? { type: "tag", sha: annotation }
                          : { type: "commit", sha },
            });
        }
        if (endpoint === `/git/tags/${nested}`)
            return Promise.resolve({ object: { type: "commit", sha } });
        if (
            endpoint === "/git/ref/tags/v1" ||
            endpoint === "/git/ref/tags/v2"
        ) {
            if (scenario.aliasError)
                throw new GitHubError(scenario.aliasError, endpoint);
            if (!current) throw new GitHubError(404, endpoint);
            return Promise.resolve({ object: current });
        }
        if (endpoint === "")
            return Promise.resolve({ node_id: "repository-node-id" });
        if (endpoint === "/graphql" && method === "POST") {
            mutations++;
            const input = (
                body as {
                    variables: {
                        input: {
                            repositoryId: string;
                            refUpdates: RefMutation[];
                        };
                    };
                }
            ).variables.input;
            assert.equal(input.repositoryId, "repository-node-id");
            assert.equal(input.refUpdates.length, 1);
            const update = input.refUpdates[0];
            assert.ok(update);
            assert.match(update.name, /^refs\/tags\/v(0|[1-9]\d*)$/);
            assert.equal(update.beforeOid, current?.sha ?? absent);
            assert.equal(update.afterOid, sha);
            assert.equal(update.force, true);
            if (scenario.newerDuringMutation) {
                current = { type: "commit", sha: newer };
                tags = [...tags, tag("v1.0.2", newer)];
                // GitHub can return an opaque error for a beforeOid mismatch.
                // The updater must inspect the actual ref, not parse messages.
                return Promise.resolve({
                    errors: [
                        {
                            message:
                                "Something went wrong while executing your query.",
                        },
                    ],
                });
            }
            if (scenario.raceCreation && mutations === 1) {
                current = { type: "commit", sha };
                return Promise.resolve({
                    errors: [{ message: "reference already exists" }],
                });
            }
            if (scenario.alwaysRace) {
                current = {
                    type: "commit",
                    sha: current?.sha === old ? newer : old,
                };
                return Promise.resolve({
                    errors: [{ message: "beforeOid mismatch" }],
                });
            }
            if (scenario.denied)
                return Promise.resolve({
                    errors: [{ message: "permission denied" }],
                });
            if (scenario.malformedResponse) return Promise.resolve({});
            updates++;
            current = { type: "commit", sha: update.afterOid };
            return Promise.resolve({
                data: { updateRefs: { clientMutationId: null } },
            });
        }
        throw new Error(`Unexpected GitHub request: ${method} ${endpoint}`);
    };
    return {
        request,
        calls,
        writes: () => calls.filter((call) => call.method !== "GET"),
        updates: () => updates,
    };
}

const options: MajorTagOptions = {
    repository: "engity-com/bifroest-action",
    releaseId: "7",
    token: "test-token",
    mode: "update",
    info: () => {},
};

Deno.test("published stable releases automatically advance only their major alias to the exact release commit", async () => {
    const api = github();
    assert.deepEqual(await updateMajorTag(options, api.request), {
        status: "updated",
        tag: "v1.0.1",
        alias: "v1",
        sha,
    });
    assert.equal(api.updates(), 1);
    assert.equal(api.writes().length, 1);
});

Deno.test("a new major alias is created with a conditional assertion that it does not exist", async () => {
    const api = github({
        release: { tag_name: "v2.0.0" },
        tags: [tag("v2.0.0")],
        current: null,
    });
    assert.deepEqual(await updateMajorTag(options, api.request), {
        status: "updated",
        tag: "v2.0.0",
        alias: "v2",
        sha,
    });
    const body = api.writes()[0]?.body as {
        variables: { input: { refUpdates: RefMutation[] } };
    };
    assert.equal(body.variables.input.refUpdates[0]?.beforeOid, absent);
});

Deno.test("inspect mode checks the real release and all tags without writing anything", async () => {
    const api = github();
    assert.deepEqual(
        await updateMajorTag({ ...options, mode: "inspect" }, api.request),
        { status: "inspected", tag: "v1.0.1", alias: "v1", sha },
    );
    assert.equal(api.writes().length, 0);
});

Deno.test("duplicate publication, promotion, and edit events converge without further tag updates", async () => {
    const api = github();
    assert.equal(
        (await updateMajorTag(options, api.request)).status,
        "updated",
    );
    assert.equal(
        (await updateMajorTag(options, api.request)).status,
        "unchanged",
    );
    assert.equal(api.updates(), 1);
    assert.equal(api.writes().length, 1);
});

Deno.test("a major alias already at the release commit needs no write", async () => {
    const api = github({ current: { type: "commit", sha } });
    assert.equal(
        (await updateMajorTag(options, api.request)).status,
        "unchanged",
    );
    assert.equal(api.writes().length, 0);
});

Deno.test("annotated and nested release tags are peeled to commits, never copied as tag objects", async () => {
    for (const annotated of ["single", "nested"] as const) {
        const api = github({ annotated });
        assert.equal(
            (await updateMajorTag(options, api.request)).status,
            "updated",
        );
        assert.ok(
            api.calls.some(
                (call) => call.endpoint === `/git/tags/${annotation}`,
            ),
        );
        assert.equal(api.updates(), 1);
    }
});

Deno.test("an annotated major alias is compared atomically using its raw tag object ID", async () => {
    const api = github({ current: { type: "tag", sha: annotation } });
    await updateMajorTag(options, api.request);
    const body = api.writes()[0]?.body as {
        variables: { input: { refUpdates: RefMutation[] } };
    };
    assert.equal(body.variables.input.refUpdates[0]?.beforeOid, annotation);
});

Deno.test("every tag page is considered, including a newer version on the second page", async () => {
    const filler = Array.from({ length: 99 }, (_, i) =>
        tag(`archive-${i}`, old),
    );
    const api = github({
        pages: [[...filler, tag("v1.0.1")], [tag("v1.0.2", newer)]],
    });
    assert.equal(
        (await updateMajorTag(options, api.request)).status,
        "skipped",
    );
    assert.ok(api.calls.some((call) => call.endpoint.endsWith("page=2")));
    assert.equal(api.writes().length, 0);
});

Deno.test("the release's own tag may be on a later page", async () => {
    const filler = Array.from({ length: 100 }, (_, i) =>
        tag(`archive-${i}`, old),
    );
    const api = github({ pages: [filler, [tag("v1.0.1")]] });
    assert.equal(
        (await updateMajorTag(options, api.request)).status,
        "updated",
    );
});

Deno.test("nonstable releases do not even read refs, much less move them", async () => {
    for (const change of [
        { draft: true },
        { prerelease: true },
        { published_at: null },
        { tag_name: "v1.0.2-beta1" },
        { tag_name: "latest" },
    ]) {
        const api = github({ release: change });
        assert.equal(
            (await updateMajorTag(options, api.request)).status,
            "skipped",
        );
        assert.deepEqual(
            api.calls.map((call) => call.endpoint),
            ["/releases/7"],
        );
    }
});

Deno.test("an older stable release never rolls the major alias back", async () => {
    const api = github({
        tags: [tag("v1.0.1"), tag("v1.1.0", newer)],
        current: { type: "commit", sha: newer },
    });
    assert.equal(
        (await updateMajorTag(options, api.request)).status,
        "skipped",
    );
    assert.equal(api.writes().length, 0);
});

Deno.test("a newer tag appearing during validation invalidates the old decision", async () => {
    const api = github({
        tagsAfterFirst: [tag("v1.0.1"), tag("v1.0.2", newer)],
    });
    assert.equal(
        (await updateMajorTag(options, api.request)).status,
        "skipped",
    );
    assert.equal(api.writes().length, 0);
});

Deno.test("a release marked prerelease during validation cannot move a major alias", async () => {
    const api = github({ releaseAfterFirst: { prerelease: true } });
    assert.equal(
        (await updateMajorTag(options, api.request)).status,
        "skipped",
    );
    assert.equal(api.writes().length, 0);
});

Deno.test("a concurrent newer release winning the atomic update is never overwritten", async () => {
    const api = github({ newerDuringMutation: true });
    assert.equal(
        (await updateMajorTag(options, api.request)).status,
        "skipped",
    );
    assert.equal(api.writes().length, 1);
    assert.equal(api.updates(), 0);
});

Deno.test("concurrent creation of the same alias converges without an unconditional overwrite", async () => {
    const api = github({ current: null, raceCreation: true });
    assert.equal(
        (await updateMajorTag(options, api.request)).status,
        "unchanged",
    );
    assert.equal(api.writes().length, 1);
    assert.equal(api.updates(), 0);
});

Deno.test("an alias changing before the mutation is re-read and never updated with an old expected object", async () => {
    const api = github({ currentAfterFirst: { type: "commit", sha: newer } });
    assert.equal(
        (await updateMajorTag(options, api.request)).status,
        "updated",
    );
    const body = api.writes()[0]?.body as {
        variables: { input: { refUpdates: RefMutation[] } };
    };
    assert.equal(body.variables.input.refUpdates[0]?.beforeOid, newer);
});

Deno.test("repeated concurrent changes stop safely instead of falling back to a force update", async () => {
    const api = github({ alwaysRace: true });
    await assert.rejects(updateMajorTag(options, api.request), /kept changing/);
    assert.equal(api.writes().length, 3);
    assert.equal(api.updates(), 0);
});

Deno.test("permission denials and malformed GraphQL responses fail without retrying an unchanged ref", async () => {
    for (const scenario of [{ denied: true }, { malformedResponse: true }]) {
        const api = github(scenario);
        await assert.rejects(
            updateMajorTag(options, api.request),
            /refused the conditional/,
        );
        assert.equal(api.writes().length, 1);
    }
});

Deno.test("missing source tags, cycles, noncommits, and changed source targets fail without writes", async () => {
    for (const scenario of [
        { missingSource: true },
        { annotated: "cycle" as const },
        { source: { type: "tree", sha } },
        { source: { type: "commit", sha: newer } },
    ]) {
        const api = github(scenario);
        await assert.rejects(updateMajorTag(options, api.request));
        assert.equal(api.writes().length, 0);
    }
});

Deno.test("only a genuine 404 denotes an absent major alias", async () => {
    for (const aliasError of [401, 403, 500]) {
        const api = github({ aliasError });
        await assert.rejects(
            updateMajorTag(options, api.request),
            new RegExp(`HTTP ${aliasError}`),
        );
        assert.equal(api.writes().length, 0);
    }
});

Deno.test("build metadata is URL encoded and equal-precedence aliases never choose an arbitrary commit", async () => {
    const api = github({
        release: { tag_name: "v1.0.1+build.1" },
        tags: [tag("v1.0.1+build.1")],
    });
    assert.equal(
        (await updateMajorTag(options, api.request)).status,
        "updated",
    );
    assert.ok(
        api.calls.some(
            (call) => call.endpoint === "/git/ref/tags/v1.0.1%2Bbuild.1",
        ),
    );
    const ambiguous = github({ tags: [tag("v1.0.1"), tag("1.0.1", newer)] });
    await assert.rejects(
        updateMajorTag(options, ambiguous.request),
        /ambiguous/,
    );
    assert.equal(ambiguous.writes().length, 0);
});

Deno.test("invalid task inputs fail before making any API request", async () => {
    for (const change of [
        { repository: "../other" },
        { repository: "owner/.." },
        { repository: "owner/repo\n" },
        { repository: "" },
        { releaseId: "../refs" },
        { releaseId: "0" },
        { releaseId: "7\n" },
        { token: "" },
        { mode: "" },
        { mode: "force" },
    ]) {
        const api = github();
        await assert.rejects(
            updateMajorTag({ ...options, ...change }, api.request),
        );
        assert.equal(api.calls.length, 0);
    }
});
