import { compare, parse, satisfies, valid } from "semver";

export interface Release {
    id: number;
    tag_name: string;
    draft: boolean;
    prerelease: boolean;
}

export type VersionSelector =
    | { kind: "exact"; value: string }
    | { kind: "stable"; value: string; range: string };

export function releaseVersion(tag: string): string | null {
    if (
        !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(tag)
    ) {
        return null;
    }
    return valid(tag.slice(1));
}

export function parseSelector(input: string): VersionSelector {
    const value = input.trim() || "latest";
    if (value === "latest") return { kind: "stable", value, range: "*" };
    if (/^v(0|[1-9]\d*)(\.(0|[1-9]\d*))?$/.test(value)) {
        const range = `${value.slice(1)}.x`;
        // SemVer also rejects numeric components above Number.MAX_SAFE_INTEGER.
        if (valid(`${value.slice(1)}${value.includes(".") ? ".0" : ".0.0"}`)) {
            return { kind: "stable", value, range };
        }
    }
    if (releaseVersion(value)) return { kind: "exact", value };
    throw new Error(
        'Invalid version. Use "latest", "v1", "v1.2", or an exact release tag such as "v1.2.3" or "v1.0.0-beta3".',
    );
}

export function selectStable(
    releases: readonly Release[],
    selector: Extract<VersionSelector, { kind: "stable" }>,
): Release {
    const candidates = releases.filter((release) => {
        const version = releaseVersion(release.tag_name);
        const parsed = version ? parse(version) : null;
        return (
            !release.draft &&
            !release.prerelease &&
            parsed !== null &&
            parsed.prerelease.length === 0 &&
            satisfies(parsed, selector.range)
        );
    });
    candidates.sort(
        (a, b) =>
            compare(b.tag_name, a.tag_name) ||
            b.tag_name.localeCompare(a.tag_name, "en"),
    );
    const result = candidates[0];
    if (!result) {
        throw new Error(
            `No published stable Bifröst release matches "${selector.value}". Prereleases must be selected by their exact tag.`,
        );
    }
    return result;
}
