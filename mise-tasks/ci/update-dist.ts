#!/usr/bin/env -S deno run --no-config --no-lock --no-npm --no-remote --allow-read --allow-write --allow-env --allow-net=api.github.com
//MISE description="Automatically commit generated bundle files from a successful internal PR build; never execute PR code"
//MISE env={DENO_NO_PACKAGE_JSON="1"}
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
    isCurrentInternalRun,
    isSuccessfulInternalPRRun,
    type PullRequest,
    readBundle,
    type WorkflowRun,
} from "../lib/bundle-policy.ts";

export type ApiRequest = (
    endpoint: string,
    token: string,
    method?: string,
    body?: unknown,
) => Promise<unknown>;

export interface UpdateOptions {
    repository?: string;
    runId?: string;
    readToken?: string;
    writeToken?: string;
    mode?: string;
    directory?: string;
    expectedSha?: string;
    expectedAttempt?: string;
    expectedArtifact?: string;
}

export interface BundleSource {
    sha: string;
    attempt: number;
    artifact: string;
}

interface GitTree {
    tree: { path: string; type: string; sha: string }[];
}

interface BuildJob {
    name: string;
    run_id: number;
    run_attempt: number;
    head_sha: string;
    conclusion: string | null;
}

function githubRequest(repository: string | undefined): ApiRequest {
    return async (endpoint, token, method = "GET", body) => {
        const url =
            endpoint === "/graphql"
                ? "https://api.github.com/graphql"
                : `https://api.github.com/repos/${repository}${endpoint}`;
        const response = await fetch(url, {
            method,
            headers: {
                accept: "application/vnd.github+json",
                authorization: `Bearer ${token}`,
                "x-github-api-version": "2022-11-28",
                ...(body ? { "content-type": "application/json" } : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
            signal: AbortSignal.timeout(60_000),
        });
        if (!response.ok) {
            throw new Error(
                `GitHub ${method} ${endpoint} failed (HTTP ${response.status}).`,
            );
        }
        return response.status === 204 ? null : response.json();
    };
}

export async function updateBundle(
    options: UpdateOptions,
    request: ApiRequest = githubRequest(options.repository),
): Promise<BundleSource | null> {
    const {
        repository,
        runId,
        readToken,
        writeToken,
        mode,
        directory,
        expectedSha,
        expectedAttempt,
        expectedArtifact,
    } = options;
    if (
        !repository ||
        !/^[\w.-]+\/[\w.-]+$/.test(repository) ||
        !runId ||
        !/^[1-9]\d*$/.test(runId)
    ) {
        throw new Error(
            "GITHUB_REPOSITORY and a numeric SOURCE_RUN_ID are required.",
        );
    }
    if (!readToken) throw new Error("READ_TOKEN is required.");
    if (mode !== "inspect" && mode !== "update") {
        throw new Error("BUNDLE_UPDATE_MODE must be inspect or update.");
    }
    // Capture validated values for the nested request helpers.
    const repo = repository;
    const reader = readToken;
    function api<T>(
        endpoint: string,
        token: string,
        method = "GET",
        body?: unknown,
    ): Promise<T> {
        return request(endpoint, token, method, body) as Promise<T>;
    }

    async function eligibleSource() {
        const run = await api<WorkflowRun>(`/actions/runs/${runId}`, reader);
        if (!isSuccessfulInternalPRRun(run, repo)) return null;
        const candidates: PullRequest[] = [];
        if (run.pull_requests?.length) {
            for (const number of new Set(
                run.pull_requests.map((pr) => pr.number),
            )) {
                candidates.push(
                    await api<PullRequest>(`/pulls/${number}`, reader),
                );
            }
        } else {
            // workflow_run can have no PR association. Look up current PRs for
            // the exact commit instead of trusting a PR number in the artifact.
            for (let page = 1; ; page++) {
                const batch = await api<PullRequest[]>(
                    `/commits/${run.head_sha}/pulls?per_page=100&page=${page}`,
                    reader,
                );
                candidates.push(...batch);
                if (batch.length < 100) break;
            }
        }
        const matching = new Map(
            candidates
                .filter((pr) => isCurrentInternalRun(run, pr, repo))
                .map((pr) => [pr.number, pr]),
        );
        if (matching.size !== 1) return null;
        const pr = matching.values().next().value;
        if (!pr) return null;
        // Failed-jobs-only reruns can reuse an earlier successful build. Bind
        // the artifact to that job's actual attempt, not the workflow's latest.
        const builds: BuildJob[] = [];
        for (let page = 1; ; page++) {
            const batch = await api<{ jobs: BuildJob[] }>(
                `/actions/runs/${runId}/jobs?filter=all&per_page=100&page=${page}`,
                reader,
            );
            builds.push(
                ...batch.jobs.filter((job) => job.name === "Build bundle"),
            );
            if (batch.jobs.length < 100) break;
        }
        if (
            builds.length === 0 ||
            builds.some(
                (job) =>
                    String(job.run_id) !== runId ||
                    job.head_sha !== run.head_sha ||
                    !Number.isSafeInteger(job.run_attempt) ||
                    job.run_attempt < 1 ||
                    job.run_attempt > run.run_attempt,
            )
        )
            return null;
        const buildAttempt = Math.max(...builds.map((job) => job.run_attempt));
        const latest = builds.filter((job) => job.run_attempt === buildAttempt);
        if (latest.length !== 1 || latest[0]?.conclusion !== "success")
            return null;
        return { run, pr, buildAttempt };
    }

    const source = await eligibleSource();
    if (!source) {
        console.log(
            "No update: requires successful CI for exactly one current internal PR head targeting main.",
        );
        return null;
    }
    const result: BundleSource = {
        sha: source.run.head_sha,
        attempt: source.run.run_attempt,
        artifact: `dist-${source.run.head_sha}-${source.buildAttempt}`,
    };
    if (mode === "inspect") return result;
    if (!writeToken || !directory)
        throw new Error("WRITE_TOKEN and BUNDLE_DIRECTORY are required.");
    if (
        result.sha !== expectedSha ||
        String(result.attempt) !== expectedAttempt ||
        result.artifact !== expectedArtifact
    ) {
        throw new Error(
            "The source commit or CI attempt changed after inspection.",
        );
    }

    const files = await readBundle(directory);
    const parent = await api<{ tree: { sha: string } }>(
        `/git/commits/${result.sha}`,
        reader,
    );
    const root = await api<GitTree>(`/git/trees/${parent.tree.sha}`, reader);
    const dist = root.tree.find((entry) => entry.path === "dist");
    if (dist && dist.type !== "tree")
        throw new Error("dist/ is not a Git directory.");
    const previous = dist
        ? (await api<GitTree>(`/git/trees/${dist.sha}`, reader)).tree
        : [];
    const additions: { path: string; contents: string }[] = [];
    for (const [name, contents] of files) {
        // Git's blob ID, not a security digest. Avoid creating an unchanged
        // commit; this makes App-triggered CI converge without a bot loop.
        const oid = createHash("sha1")
            .update(`blob ${contents.byteLength}\0`)
            .update(contents)
            .digest("hex");
        const current = previous.find((entry) => entry.path === name);
        if (current?.type === "blob" && current.sha === oid) continue;
        additions.push({
            path: `dist/${name}`,
            contents: Buffer.from(contents).toString("base64"),
        });
    }
    if (additions.length === 0) {
        console.log("dist/ is already current; no commit needed.");
        return result;
    }

    const current = await eligibleSource();
    if (
        !current ||
        current.run.head_sha !== result.sha ||
        current.run.run_attempt !== result.attempt ||
        current.buildAttempt !== source.buildAttempt
    ) {
        throw new Error(
            "PR head or CI attempt changed; refusing a stale bundle update.",
        );
    }
    // GitHub checks expectedHeadOid atomically with the commit. This also
    // rejects a force-push/rebase in the gap after the last eligibility check.
    const response = await api<{
        errors?: unknown[];
        data?: { createCommitOnBranch?: { commit?: { oid: string } } };
    }>("/graphql", writeToken, "POST", {
        query: "mutation UpdateBundle($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }",
        variables: {
            input: {
                branch: {
                    repositoryNameWithOwner: repo,
                    branchName: source.pr.head.ref,
                },
                expectedHeadOid: result.sha,
                message: {
                    // Dependabot may discard these generated files on a rebase;
                    // the next CI regenerates them. This does NOT skip Actions.
                    headline: "build: update bundled action [dependabot skip]",
                },
                fileChanges: { additions },
            },
        },
    });
    if (
        response.errors?.length ||
        !response.data?.createCommitOnBranch?.commit?.oid
    ) {
        throw new Error(
            "GitHub refused the atomic bundle update. The branch may have moved or the App lacks contents:write permission.",
        );
    }
    console.log(
        `Updated only dist/ on PR #${source.pr.number}. The App push triggers a fresh CI run.`,
    );
    return result;
}

if (import.meta.main) {
    if (Deno.build.os !== "linux")
        throw new Error("The privileged bundle writer is Linux-only.");
    const source = await updateBundle({
        repository: Deno.env.get("GITHUB_REPOSITORY"),
        runId: Deno.env.get("SOURCE_RUN_ID"),
        readToken: Deno.env.get("READ_TOKEN"),
        writeToken: Deno.env.get("WRITE_TOKEN"),
        mode: Deno.env.get("BUNDLE_UPDATE_MODE"),
        directory: Deno.env.get("BUNDLE_DIRECTORY"),
        expectedSha: Deno.env.get("SOURCE_SHA"),
        expectedAttempt: Deno.env.get("SOURCE_ATTEMPT"),
        expectedArtifact: Deno.env.get("SOURCE_ARTIFACT"),
    });
    const output = Deno.env.get("GITHUB_OUTPUT");
    if (output)
        await Deno.writeTextFile(
            output,
            source
                ? `eligible=true\nsha=${source.sha}\nattempt=${source.attempt}\nartifact=${source.artifact}\n`
                : "eligible=false\n",
            { append: true },
        );
}
