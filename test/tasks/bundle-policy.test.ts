import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
    type ApiRequest,
    type UpdateOptions,
    updateBundle,
} from "../../mise-tasks/ci/update-dist.ts";
import {
    isCurrentInternalRun,
    type PullRequest,
    readBundle,
    type WorkflowRun,
} from "../../mise-tasks/lib/bundle-policy.ts";

const test = Deno.test;
// Deno exposes the link counts required by the privileged writer only on Unix.
const fileTest = (name: string, fn: () => void | Promise<void>) =>
    Deno.test({ name, fn, ignore: Deno.build.os === "windows" });

const repository = "engity-com/bifroest-action";
const sha = "a".repeat(40);
const run: WorkflowRun = {
    event: "pull_request",
    conclusion: "success",
    path: ".github/workflows/ci.yml",
    head_repository: { full_name: repository },
    head_branch: "feature/setup",
    head_sha: sha,
    run_attempt: 1,
};
const pr: PullRequest = {
    number: 5,
    state: "open",
    draft: false,
    base: { ref: "main" },
    head: { repo: { full_name: repository }, ref: "feature/setup", sha },
};
const expectedSource = { sha, attempt: 1, artifact: `dist-${sha}-1` };
const fixtureFiles = {
    "index.cjs": 'throw new Error("MUST NOT EXECUTE ARTIFACT");\n',
    "licenses.txt": "notices\n",
};

test("bundle updates require successful CI for exactly the current internal PR head", () => {
    assert.equal(isCurrentInternalRun(run, pr, repository), true);
    for (const change of [
        { event: "pull_request_target" },
        { conclusion: "failure" },
        { conclusion: null },
        { path: ".github/workflows/untrusted.yml" },
        { head_sha: "b".repeat(40) },
        { head_repository: { full_name: "fork/repo" } },
        { head_branch: "other" },
        { run_attempt: 0 },
        { run_attempt: Number.NaN },
    ])
        assert.equal(
            isCurrentInternalRun({ ...run, ...change }, pr, repository),
            false,
        );
    for (const change of [
        { state: "closed" },
        { base: { ref: "other" } },
        { head: { ...pr.head, repo: { full_name: "fork/repo" } } },
        { head: { ...pr.head, ref: "main" } },
    ])
        assert.equal(
            isCurrentInternalRun(run, { ...pr, ...change }, repository),
            false,
        );
    assert.equal(
        isCurrentInternalRun(run, { ...pr, draft: true }, repository),
        true,
    );
});

async function bundle() {
    const directory = await mkdtemp(
        path.join(process.env.RUNNER_TEMP || os.tmpdir(), "bifroest-bundle-"),
    );
    for (const [name, contents] of Object.entries(fixtureFiles)) {
        await writeFile(path.join(directory, name), contents);
    }
    return directory;
}

fileTest(
    "the writer accepts only the two fixed regular bundle files",
    async () => {
        const directory = await bundle();
        try {
            assert.equal((await readBundle(directory)).size, 2);
            await writeFile(path.join(directory, "unexpected.ts"), "throw 1");
            await assert.rejects(readBundle(directory), /exactly the two/);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    },
);

fileTest(
    "the writer rejects package metadata and non-regular entries",
    async () => {
        const directory = await bundle();
        try {
            await writeFile(
                path.join(directory, "package.json"),
                '{"scripts":{"prepare":"untrusted"}}',
            );
            await assert.rejects(readBundle(directory), /exactly the two/);
            await rm(path.join(directory, "package.json"));
            await rm(path.join(directory, "index.cjs"));
            await mkdir(path.join(directory, "index.cjs"));
            await assert.rejects(readBundle(directory), /Unsafe bundle/);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    },
);

fileTest(
    "hard-linked artifact files cannot escape the writer's file boundary",
    async () => {
        const directory = await bundle();
        const external = `${directory}-external-link`;
        try {
            await link(path.join(directory, "index.cjs"), external);
            await assert.rejects(readBundle(directory), /Unsafe bundle/);
        } finally {
            await rm(external, { force: true });
            await rm(directory, { recursive: true, force: true });
        }
    },
);

fileTest(
    "symlinked artifact roots and files are rejected without following them",
    async () => {
        const directory = await bundle();
        const alias = `${directory}-alias`;
        try {
            await symlink(directory, alias);
            await assert.rejects(readBundle(alias), /regular directory/);
            await rm(path.join(directory, "index.cjs"));
            await symlink(
                path.join(directory, "licenses.txt"),
                path.join(directory, "index.cjs"),
            );
            await assert.rejects(readBundle(directory), /Unsafe bundle/);
        } finally {
            await rm(alias, { force: true });
            await rm(directory, { recursive: true, force: true });
        }
    },
);

interface Scenario {
    run?: Partial<WorkflowRun>;
    pr?: Partial<PullRequest>;
    author?: string;
    associations?: "listed" | "empty" | "missing";
    associatedPRs?: PullRequest[];
    paginate?: boolean;
    moveHead?: boolean;
    moveAttempt?: boolean;
    unchanged?: boolean;
    onlyLicenseChanged?: boolean;
    denyCommit?: boolean;
    buildAttempt?: number;
    buildConclusion?: string;
    missingBuild?: boolean;
}

function writerApi(scenario: Scenario = {}) {
    const calls: { endpoint: string; method: string; body: unknown }[] = [];
    let inspections = 0;
    const sourceRun = { ...run, ...scenario.run };
    const currentPR = () => {
        const value = { ...pr, ...scenario.pr };
        return {
            ...value,
            head: {
                ...value.head,
                sha:
                    scenario.moveHead && inspections > 1
                        ? "b".repeat(40)
                        : value.head.sha,
            },
            user: {
                login: scenario.author || "developer",
                type: scenario.author === "dependabot[bot]" ? "Bot" : "User",
            },
        };
    };
    const request: ApiRequest = async (
        endpoint,
        token,
        method = "GET",
        body,
    ) => {
        calls.push({ endpoint, method, body });
        assert.equal(token, method === "GET" ? "read-token" : "write-token");
        if (endpoint === "/actions/runs/1") {
            inspections++;
            const value = {
                ...sourceRun,
                run_attempt:
                    scenario.moveAttempt && inspections > 1
                        ? sourceRun.run_attempt + 1
                        : sourceRun.run_attempt,
            };
            if (scenario.associations === "missing") return value;
            return {
                ...value,
                pull_requests:
                    scenario.associations === "empty" ? [] : [{ number: 5 }],
            };
        }
        if (endpoint === "/pulls/5") return currentPR();
        if (endpoint.startsWith("/actions/runs/1/jobs?")) {
            return {
                jobs: scenario.missingBuild
                    ? []
                    : [
                          {
                              name: "Build bundle",
                              run_id: 1,
                              head_sha: sourceRun.head_sha,
                              run_attempt:
                                  scenario.buildAttempt ??
                                  sourceRun.run_attempt,
                              conclusion: scenario.buildConclusion ?? "success",
                          },
                      ],
            };
        }
        if (endpoint.startsWith(`/commits/${sourceRun.head_sha}/pulls?`)) {
            if (scenario.paginate && endpoint.endsWith("page=1")) {
                return Array.from({ length: 100 }, (_, number) => ({
                    ...currentPR(),
                    number: number + 100,
                    state: "closed",
                }));
            }
            return scenario.associatedPRs ?? [currentPR()];
        }
        if (endpoint === `/git/commits/${sourceRun.head_sha}`)
            return { tree: { sha: "root-tree" } };
        if (endpoint === "/git/trees/root-tree")
            return { tree: [{ path: "dist", type: "tree", sha: "dist-tree" }] };
        if (endpoint === "/git/trees/dist-tree") {
            return {
                tree: Object.entries(fixtureFiles).map(([name, contents]) => ({
                    path: name,
                    type: "blob",
                    sha:
                        scenario.unchanged ||
                        (scenario.onlyLicenseChanged && name === "index.cjs")
                            ? createHash("sha1")
                                  .update(
                                      `blob ${Buffer.byteLength(contents)}\0`,
                                  )
                                  .update(contents)
                                  .digest("hex")
                            : "old-blob",
                })),
            };
        }
        if (endpoint === "/graphql" && method === "POST") {
            return scenario.denyCommit
                ? { errors: [{ message: "expectedHeadOid mismatch" }] }
                : {
                      data: {
                          createCommitOnBranch: {
                              commit: { oid: "c".repeat(40) },
                          },
                      },
                  };
        }
        // In particular, no review or collaborator-permission API is allowed.
        throw new Error(`Unexpected API request ${endpoint}`);
    };
    return {
        request,
        calls,
        writes: () => calls.filter((call) => call.method !== "GET"),
    };
}

const writerOptions: UpdateOptions = {
    repository,
    runId: "1",
    readToken: "read-token",
    writeToken: "write-token",
    mode: "update",
    expectedSha: sha,
    expectedAttempt: "1",
    expectedArtifact: expectedSource.artifact,
};

test("internal PRs including Dependabot and drafts need no review or manual authorization", async () => {
    for (const author of ["developer", "dependabot[bot]"]) {
        const api = writerApi({ author, pr: { draft: true } });
        assert.deepEqual(
            await updateBundle(
                { ...writerOptions, mode: "inspect" },
                api.request,
            ),
            expectedSource,
        );
        assert.deepEqual(api.writes(), []);
    }
});

test("Dependabot PRs are recovered by exact commit when workflow_run omits PR associations", async () => {
    for (const associations of ["empty", "missing"] as const) {
        const api = writerApi({
            author: "dependabot[bot]",
            associations,
            paginate: true,
        });
        assert.deepEqual(
            await updateBundle(
                { ...writerOptions, mode: "inspect" },
                api.request,
            ),
            expectedSource,
        );
        assert.ok(api.calls.some((call) => call.endpoint.endsWith("page=2")));
    }
});

test("failed, stale, fork, closed and ambiguous PR sources never authorize a write", async () => {
    const scenarios: Scenario[] = [
        { run: { conclusion: "failure" } },
        { run: { event: "pull_request_target" } },
        { run: { head_repository: { full_name: "fork/repo" } } },
        { pr: { state: "closed" } },
        { pr: { head: { ...pr.head, sha: "b".repeat(40) } } },
        { pr: { head: { ...pr.head, repo: { full_name: "fork/repo" } } } },
        { associations: "empty", associatedPRs: [] },
        { associations: "empty", associatedPRs: [pr, { ...pr, number: 6 }] },
        { missingBuild: true },
        { buildConclusion: "failure" },
    ];
    for (const scenario of scenarios) {
        const api = writerApi(scenario);
        assert.equal(
            await updateBundle(
                { ...writerOptions, mode: "inspect" },
                api.request,
            ),
            null,
        );
        assert.deepEqual(api.writes(), []);
    }
});

test("repeated CI attempts have distinct artifact names and reject the previously inspected attempt", async () => {
    const api = writerApi({ run: { run_attempt: 2 } });
    assert.deepEqual(
        await updateBundle({ ...writerOptions, mode: "inspect" }, api.request),
        {
            sha,
            attempt: 2,
            artifact: `dist-${sha}-2`,
        },
    );
    await assert.rejects(
        updateBundle(
            { ...writerOptions, directory: "must-not-read" },
            api.request,
        ),
        /CI attempt changed/,
    );
    assert.deepEqual(api.writes(), []);
});

interface CommitInput {
    branch: { repositoryNameWithOwner: string; branchName: string };
    expectedHeadOid: string;
    message: { headline: string };
    fileChanges: { additions: { path: string; contents: string }[] };
}

fileTest(
    "failed-only CI retries automatically reuse the exact earlier successful build artifact",
    async () => {
        const directory = await bundle();
        const api = writerApi({
            run: { run_attempt: 2 },
            buildAttempt: 1,
            author: "dependabot[bot]",
        });
        try {
            const expected = { ...expectedSource, attempt: 2 };
            assert.deepEqual(
                await updateBundle(
                    { ...writerOptions, mode: "inspect" },
                    api.request,
                ),
                expected,
            );
            assert.deepEqual(
                await updateBundle(
                    { ...writerOptions, directory, expectedAttempt: "2" },
                    api.request,
                ),
                expected,
            );
            assert.equal(api.writes().length, 1);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    },
);

fileTest(
    "Dependabot bundles are committed automatically with atomic SHA binding and fixed dist paths",
    async () => {
        const directory = await bundle();
        const branch = "dependabot/npm_and_yarn/actions-toolkit";
        const api = writerApi({
            author: "dependabot[bot]",
            run: { head_branch: branch },
            pr: { head: { ...pr.head, ref: branch } },
            associations: "empty",
        });
        try {
            assert.deepEqual(
                await updateBundle(
                    { ...writerOptions, directory },
                    api.request,
                ),
                expectedSource,
            );
            assert.equal(api.writes().length, 1);
            const call = api.writes()[0];
            assert.ok(call);
            assert.equal(call.endpoint, "/graphql");
            const input = (call.body as { variables: { input: CommitInput } })
                .variables.input;
            assert.deepEqual(input.branch, {
                repositoryNameWithOwner: repository,
                branchName: branch,
            });
            assert.equal(input.expectedHeadOid, sha);
            assert.match(input.message.headline, /\[dependabot skip\]/);
            assert.doesNotMatch(
                input.message.headline,
                /\[(skip ci|ci skip|skip actions|actions skip|no ci)\]/i,
            );
            assert.deepEqual(
                input.fileChanges.additions.map((item) => item.path),
                ["dist/index.cjs", "dist/licenses.txt"],
            );
            assert.deepEqual(
                input.fileChanges.additions.map((item) =>
                    Buffer.from(item.contents, "base64").toString(),
                ),
                Object.values(fixtureFiles),
            );
            assert.equal("deletions" in input.fileChanges, false);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    },
);

fileTest(
    "a Dependabot rebase automatically regenerates its discarded bundle for the new source SHA",
    async () => {
        const directory = await bundle();
        const nextSha = "b".repeat(40);
        const branch = "dependabot/npm_and_yarn/actions-toolkit";
        const api = writerApi({
            author: "dependabot[bot]",
            associations: "empty",
            run: { head_sha: nextSha, head_branch: branch },
            pr: { head: { ...pr.head, ref: branch, sha: nextSha } },
        });
        try {
            const result = await updateBundle(
                {
                    ...writerOptions,
                    directory,
                    expectedSha: nextSha,
                    expectedArtifact: `dist-${nextSha}-1`,
                },
                api.request,
            );
            assert.equal(result?.sha, nextSha);
            assert.equal(api.writes().length, 1);
            const call = api.writes()[0];
            assert.ok(call);
            const input = (call.body as { variables: { input: CommitInput } })
                .variables.input;
            assert.equal(input.expectedHeadOid, nextSha);
            assert.match(input.message.headline, /\[dependabot skip\]/);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    },
);

fileTest(
    "head changes and CI reruns during processing prevent the final commit",
    async () => {
        const directory = await bundle();
        try {
            for (const scenario of [
                { moveHead: true },
                { moveAttempt: true },
            ]) {
                const api = writerApi(scenario);
                await assert.rejects(
                    updateBundle({ ...writerOptions, directory }, api.request),
                    /refusing a stale/,
                );
                assert.deepEqual(api.writes(), []);
            }
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    },
);

fileTest(
    "GitHub atomically rejecting a concurrent force-push does not fall back to a force update",
    async () => {
        const directory = await bundle();
        const api = writerApi({ denyCommit: true });
        try {
            await assert.rejects(
                updateBundle({ ...writerOptions, directory }, api.request),
                /refused the atomic/,
            );
            assert.equal(api.writes().length, 1);
            assert.equal(api.writes()[0]?.endpoint, "/graphql");
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    },
);

fileTest(
    "an App-triggered CI for an already current bundle converges without another commit",
    async () => {
        const directory = await bundle();
        const nextSha = "c".repeat(40);
        const api = writerApi({
            unchanged: true,
            run: { head_sha: nextSha },
            pr: { head: { ...pr.head, sha: nextSha } },
        });
        try {
            const result = await updateBundle(
                {
                    ...writerOptions,
                    directory,
                    expectedSha: nextSha,
                    expectedArtifact: `dist-${nextSha}-1`,
                },
                api.request,
            );
            assert.equal(result?.sha, nextSha);
            assert.deepEqual(api.writes(), []);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    },
);

fileTest(
    "a notices-only change updates only the changed permitted file",
    async () => {
        const directory = await bundle();
        const api = writerApi({ onlyLicenseChanged: true });
        try {
            await updateBundle({ ...writerOptions, directory }, api.request);
            const call = api.writes()[0];
            assert.ok(call);
            const input = (call.body as { variables: { input: CommitInput } })
                .variables.input;
            assert.deepEqual(
                input.fileChanges.additions.map((item) => item.path),
                ["dist/licenses.txt"],
            );
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    },
);
