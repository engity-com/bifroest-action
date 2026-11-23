#!/usr/bin/env -S deno run --no-config --no-lock --no-npm --no-remote --allow-env --allow-net=api.github.com
//MISE description="Automatically advance a stable release's major alias after checking every version tag"
//MISE env={DENO_NO_PACKAGE_JSON="1"}
import {
    isPublishedStable,
    type MajorTagDecision,
    majorTagDecision,
    type PublishedRelease,
    type VersionTag,
} from "../lib/release-policy.ts";

export type GitHubRequest = (
    endpoint: string,
    method?: string,
    body?: unknown,
) => Promise<unknown>;

export class GitHubError extends Error {
    constructor(
        public readonly status: number,
        endpoint: string,
    ) {
        super(`GitHub request ${endpoint} failed (HTTP ${status}).`);
    }
}

export interface MajorTagOptions {
    repository?: string;
    releaseId?: string;
    token?: string;
    mode?: string;
    info?: (message: string) => void;
}

interface GitObject {
    type: string;
    sha: string;
}

interface Snapshot {
    tag: string;
    alias: string;
    sha: string;
    sourceOid: string;
    beforeOid: string;
}

export type MajorTagResult =
    | { status: "skipped"; reason: string }
    | {
          status: "inspected" | "unchanged" | "updated";
          tag: string;
          alias: string;
          sha: string;
      };

const absent = "0".repeat(40);

function githubRequest(
    repository: string | undefined,
    token: string | undefined,
): GitHubRequest {
    return async (endpoint, method = "GET", body) => {
        const url =
            endpoint === "/graphql"
                ? "https://api.github.com/graphql"
                : `https://api.github.com/repos/${repository}${endpoint}`;
        const response = await fetch(url, {
            method,
            headers: {
                accept: "application/vnd.github+json",
                authorization: `Bearer ${token}`,
                "cache-control": "no-cache",
                "x-github-api-version": "2022-11-28",
                ...(body ? { "content-type": "application/json" } : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
            signal: AbortSignal.timeout(60_000),
        });
        if (!response.ok) throw new GitHubError(response.status, endpoint);
        return response.json();
    };
}

export async function updateMajorTag(
    options: MajorTagOptions,
    request: GitHubRequest = githubRequest(options.repository, options.token),
): Promise<MajorTagResult> {
    const { repository, releaseId, token, mode } = options;
    const info = options.info ?? console.info;
    if (
        !repository ||
        repository !== repository.trim() ||
        !/^[\w.-]+\/[\w.-]+$/.test(repository) ||
        repository.split("/").some((part) => part === "." || part === "..") ||
        !releaseId ||
        releaseId !== releaseId.trim() ||
        !/^[1-9]\d*$/.test(releaseId)
    ) {
        throw new Error(
            "GITHUB_REPOSITORY and a numeric RELEASE_ID are required.",
        );
    }
    if (!token) throw new Error("GITHUB_TOKEN is required.");
    if (mode !== "update" && mode !== "inspect") {
        throw new Error("MAJOR_TAG_MODE must be update or inspect.");
    }
    function api<T>(
        endpoint: string,
        method = "GET",
        body?: unknown,
    ): Promise<T> {
        return request(endpoint, method, body) as Promise<T>;
    }
    function object(value: GitObject): GitObject {
        if (
            !value ||
            typeof value.sha !== "string" ||
            value.sha.length !== 40 ||
            !/^[a-f0-9]{40}$/.test(value.sha) ||
            value.sha === absent ||
            (value.type !== "commit" && value.type !== "tag")
        ) {
            throw new Error(
                "A release or major tag has an unexpected Git object.",
            );
        }
        return value;
    }
    async function reference(
        name: string,
        optional = false,
    ): Promise<GitObject | null> {
        try {
            const value = await api<{ object: GitObject }>(
                `/git/ref/tags/${encodeURIComponent(name)}`,
            );
            return object(value.object);
        } catch (error) {
            if (
                optional &&
                error instanceof GitHubError &&
                error.status === 404
            )
                return null;
            throw error;
        }
    }
    async function inspect(): Promise<
        Snapshot | Extract<MajorTagDecision, { eligible: false }>
    > {
        // Re-read the release rather than trusting stale webhook fields.
        const release = await api<PublishedRelease>(`/releases/${releaseId}`);
        if (!isPublishedStable(release))
            return {
                eligible: false,
                reason: "Not a published stable SemVer release.",
            };
        const tags: VersionTag[] = [];
        for (let page = 1; ; page++) {
            const batch = await api<VersionTag[]>(
                `/tags?per_page=100&page=${page}`,
            );
            tags.push(...batch);
            if (batch.length < 100) break;
        }
        const decision = majorTagDecision(release, tags);
        if (!decision.eligible) return decision;
        const source = await reference(decision.tag);
        if (!source) throw new Error("The published release tag is missing.");
        let target = source;
        const seen = new Set<string>();
        while (target.type === "tag") {
            if (seen.size >= 16 || seen.has(target.sha))
                throw new Error("Release tag nesting is cyclic or too deep.");
            seen.add(target.sha);
            target = object(
                (await api<{ object: GitObject }>(`/git/tags/${target.sha}`))
                    .object,
            );
        }
        if (target.sha !== decision.sha)
            throw new Error(
                "The release tag changed while reading the version tags.",
            );
        const current = await reference(decision.alias, true);
        return {
            tag: decision.tag,
            alias: decision.alias,
            sha: decision.sha,
            sourceOid: source.sha,
            beforeOid: current?.sha ?? absent,
        };
    }
    function skipped(reason: string): MajorTagResult {
        info(`No major-tag update: ${reason}`);
        return { status: "skipped", reason };
    }
    function result(
        status: "inspected" | "unchanged" | "updated",
        snapshot: Snapshot,
    ): MajorTagResult {
        return {
            status,
            tag: snapshot.tag,
            alias: snapshot.alias,
            sha: snapshot.sha,
        };
    }

    // Different releases may run in parallel. Fresh reads plus beforeOid make
    // updates conditional; there is never an unconditional force-push fallback.
    for (let attempt = 0; attempt < 3; attempt++) {
        const initial = await inspect();
        if ("eligible" in initial) return skipped(initial.reason);
        if (mode === "inspect") {
            info(
                `Would point ${initial.alias} at ${initial.tag} (${initial.sha}).`,
            );
            return result("inspected", initial);
        }
        const current = await inspect();
        if ("eligible" in current) return skipped(current.reason);
        if (
            current.tag !== initial.tag ||
            current.sha !== initial.sha ||
            current.sourceOid !== initial.sourceOid ||
            current.beforeOid !== initial.beforeOid
        )
            continue;
        if (current.beforeOid === current.sha) {
            info(
                `${current.alias} already points to ${current.tag}; no update needed.`,
            );
            return result("unchanged", current);
        }
        const repo = await api<{ node_id: string }>("");
        if (!repo.node_id)
            throw new Error("GitHub returned no repository node ID.");
        const response = await api<{
            errors?: unknown[];
            data?: { updateRefs?: { clientMutationId: string | null } };
        }>("/graphql", "POST", {
            query: "mutation UpdateMajorTag($input: UpdateRefsInput!) { updateRefs(input: $input) { clientMutationId } }",
            variables: {
                input: {
                    repositoryId: repo.node_id,
                    refUpdates: [
                        {
                            name: `refs/tags/${current.alias}`,
                            beforeOid: current.beforeOid,
                            afterOid: current.sha,
                            force: true,
                        },
                    ],
                },
            },
        });
        if (!response.errors?.length && response.data?.updateRefs) {
            info(
                `Updated ${current.alias} to ${current.tag} (${current.sha}).`,
            );
            return result("updated", current);
        }
        const moved = await reference(current.alias, true);
        if ((moved?.sha ?? absent) !== current.beforeOid) continue;
        throw new Error(
            "GitHub refused the conditional major-tag update. Check contents:write permission and tag protection; do not attach an immutable release to the moving major alias.",
        );
    }
    throw new Error(
        "Release tags or the major alias kept changing; refusing a stale update.",
    );
}

if (import.meta.main) {
    await updateMajorTag({
        repository: Deno.env.get("GITHUB_REPOSITORY"),
        releaseId: Deno.env.get("RELEASE_ID"),
        token: Deno.env.get("GITHUB_TOKEN"),
        mode: Deno.env.get("MAJOR_TAG_MODE"),
    });
}
