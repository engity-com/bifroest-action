import path from "node:path";
import { distFiles } from "./dist-files.ts";

export interface WorkflowRun {
    event: string;
    conclusion: string | null;
    path: string;
    head_repository: { full_name: string } | null;
    head_branch: string | null;
    head_sha: string;
    run_attempt: number;
    pull_requests?: { number: number }[];
}

export interface PullRequest {
    number: number;
    state: string;
    draft: boolean;
    base: { ref: string };
    head: { repo: { full_name: string } | null; ref: string; sha: string };
}

export function isSuccessfulInternalPRRun(
    run: WorkflowRun,
    repository: string,
): boolean {
    return (
        run.event === "pull_request" &&
        run.conclusion === "success" &&
        run.path === ".github/workflows/ci.yml" &&
        run.head_repository?.full_name === repository &&
        typeof run.head_branch === "string" &&
        run.head_branch.length > 0 &&
        run.head_branch !== "main" &&
        /^[a-f0-9]{40}$/.test(run.head_sha) &&
        Number.isSafeInteger(run.run_attempt) &&
        run.run_attempt > 0
    );
}

export function isCurrentInternalRun(
    run: WorkflowRun,
    pr: PullRequest,
    repository: string,
): boolean {
    return (
        isSuccessfulInternalPRRun(run, repository) &&
        pr.state === "open" &&
        pr.base?.ref === "main" &&
        pr.head?.repo?.full_name === repository &&
        pr.head?.ref !== "main" &&
        pr.head?.ref === run.head_branch &&
        pr.head?.sha === run.head_sha
    );
}

export async function readBundle(
    directory: string,
): Promise<Map<string, Uint8Array>> {
    const root = await Deno.lstat(directory);
    if (!root.isDirectory || root.isSymlink) {
        throw new Error(
            "Bundle artifact must be a regular directory, not a link.",
        );
    }
    const entries = await Array.fromAsync(Deno.readDir(directory));
    if (
        entries.length !== distFiles.length ||
        entries.some((entry) => !distFiles.includes(entry.name))
    ) {
        throw new Error(
            "Bundle artifact must contain exactly the two permitted dist files.",
        );
    }
    const files = new Map<string, Uint8Array>();
    for (const name of distFiles) {
        const filename = path.join(directory, name);
        const metadata = await Deno.lstat(filename);
        if (
            !metadata.isFile ||
            metadata.isSymlink ||
            metadata.nlink !== 1 ||
            metadata.size > 16 * 1024 * 1024
        ) {
            throw new Error(`Unsafe bundle artifact entry: ${name}.`);
        }
        files.set(name, await Deno.readFile(filename));
    }
    return files;
}
