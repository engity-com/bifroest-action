export interface PublishedRelease {
    tag_name: string;
    draft: boolean;
    prerelease: boolean;
    published_at: string | null;
}

export interface VersionTag {
    name: string;
    commit: { sha: string };
}

export interface StableVersion {
    major: bigint;
    minor: bigint;
    patch: bigint;
}

export type MajorTagDecision =
    | { eligible: false; reason: string }
    | { eligible: true; tag: string; alias: string; sha: string };

// The stable subset of SemVer 2.0.0: no prerelease, optional build metadata,
// no leading zeroes in core numbers. A conventional v prefix is optional.
// BigInt avoids imposing a machine-sized limit on SemVer's numeric fields.
export function stableVersion(tag: string): StableVersion | null {
    const match =
        /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
            tag,
        );
    if (!match || match[0] !== tag) return null;
    return {
        major: BigInt(match[1] as string),
        minor: BigInt(match[2] as string),
        patch: BigInt(match[3] as string),
    };
}

export function compareStable(a: StableVersion, b: StableVersion): number {
    for (const field of ["major", "minor", "patch"] as const) {
        if (a[field] !== b[field]) return a[field] < b[field] ? -1 : 1;
    }
    return 0;
}

export function isPublishedStable(release: PublishedRelease): boolean {
    return (
        release.draft === false &&
        release.prerelease === false &&
        typeof release.published_at === "string" &&
        release.published_at.length > 0 &&
        stableVersion(release.tag_name) !== null
    );
}

export function majorTagDecision(
    release: PublishedRelease,
    tags: readonly VersionTag[],
): MajorTagDecision {
    const version = stableVersion(release.tag_name);
    if (!version || !isPublishedStable(release)) {
        return {
            eligible: false,
            reason: "Not a published stable SemVer release.",
        };
    }
    const matches = tags.filter((tag) => tag.name === release.tag_name);
    const sha = matches[0]?.commit.sha ?? "";
    if (
        matches.length !== 1 ||
        sha.length !== 40 ||
        !/^[a-f0-9]{40}$/.test(sha) ||
        sha === "0".repeat(40)
    ) {
        throw new Error(
            "The published release must have exactly one matching version tag pointing to a commit.",
        );
    }
    let newer: { tag: string; version: StableVersion } | undefined;
    let ambiguous = false;
    for (const tag of tags) {
        const other = stableVersion(tag.name);
        if (!other || other.major !== version.major) continue;
        const order = compareStable(other, version);
        if (order > 0 && (!newer || compareStable(other, newer.version) > 0))
            newer = { tag: tag.name, version: other };
        if (order === 0 && tag.commit.sha !== sha) ambiguous = true;
    }
    if (newer) {
        return {
            eligible: false,
            reason: `${newer.tag} is a newer stable tag in this major series.`,
        };
    }
    if (ambiguous) {
        throw new Error(
            "Stable tags with equal SemVer precedence point to different commits; refusing an ambiguous major alias.",
        );
    }
    return {
        eligible: true,
        tag: release.tag_name,
        alias: `v${version.major}`,
        sha,
    };
}
