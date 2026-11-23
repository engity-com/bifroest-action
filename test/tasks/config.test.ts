import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const entrypoints = [
    "build.ts",
    "check/dist.ts",
    "ci/update-dist.ts",
    "ci/update-major-tag.ts",
    "test/download.ts",
];

Deno.test("file tasks explicitly disable project manifests and lock discovery", async () => {
    for (const entry of entrypoints) {
        const source = await Deno.readTextFile(
            path.join(root, "mise-tasks", entry),
        );
        const shebang = source.split("\n")[0] ?? "";
        assert.match(shebang, /^#!.*\bdeno run\b/, entry);
        assert.match(shebang, /--no-config\b/, entry);
        assert.match(shebang, /--no-lock\b/, entry);
        assert.match(
            source,
            /^\/\/MISE env=\{DENO_NO_PACKAGE_JSON="1"\}/m,
            entry,
        );
        if (Deno.build.os !== "windows") {
            const metadata = await Deno.stat(
                path.join(root, "mise-tasks", entry),
            );
            assert.ok(
                (metadata.mode ?? 0) & 0o111,
                `${entry} must be executable for MISE task discovery`,
            );
        }
    }
});

Deno.test("major aliases update automatically from trusted main with only the repository token", async () => {
    const workflow = await Deno.readTextFile(
        path.join(root, ".github/workflows/update-major-tag.yml"),
    );
    assert.match(
        workflow,
        /release:\s*\n\s*types: \[published, released, edited\]/,
    );
    assert.match(workflow, /ref: main/);
    assert.match(workflow, /persist-credentials: false/);
    assert.match(workflow, /cache: false/);
    assert.match(workflow, /contents: write/);
    assert.match(
        workflow,
        /release\.draft == false && github\.event\.release\.prerelease == false/,
    );
    assert.match(
        workflow,
        /group: major-tag-release-\$\{\{ github\.event\.release\.id \}\}/,
    );
    assert.match(workflow, /mise run ci:update-major-tag/);
    assert.match(workflow, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
    assert.match(
        workflow,
        /RELEASE_ID: \$\{\{ github\.event\.release\.id \}\}/,
    );
    assert.doesNotMatch(
        workflow,
        /secrets\.|workflow_dispatch|pull_request_target|git push/,
    );
});

async function sources(directory: string): Promise<string[]> {
    const result: string[] = [];
    for await (const entry of Deno.readDir(directory)) {
        if (entry.isDirectory)
            result.push(...(await sources(path.join(directory, entry.name))));
        else if (entry.name.endsWith(".ts"))
            result.push(path.join(directory, entry.name));
    }
    return result;
}

Deno.test("Deno imports are relative, built-in, or explicitly version-pinned", async () => {
    const files = [
        ...(await sources(path.join(root, "mise-tasks"))),
        ...(await sources(path.join(root, "test/tasks"))),
    ];
    for (const file of files) {
        const source = await Deno.readTextFile(file);
        for (const match of source.matchAll(
            /\bfrom\s+["']([^"']+)["']|\bimport\s*["']([^"']+)["']/g,
        )) {
            const specifier = match[1] ?? match[2] ?? "";
            if (specifier.startsWith(".") || specifier.startsWith("node:"))
                continue;
            assert.match(
                specifier,
                /^(npm:|jsr:)(@[^/@]+\/)?[^@/]+@\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\/.*)?$/,
                `${file}: ${specifier}`,
            );
        }
    }
});

Deno.test("CI and the automatic writer bind artifacts to the same commit and attempt without build secrets", async () => {
    const ci = await Deno.readTextFile(
        path.join(root, ".github/workflows/ci.yml"),
    );
    const writer = await Deno.readTextFile(
        path.join(root, ".github/workflows/update-dist.yml"),
    );
    assert.match(
        ci,
        /name: dist-\$\{\{ github\.event\.pull_request\.head\.sha \}\}-\$\{\{ github\.run_attempt \}\}/,
    );
    assert.doesNotMatch(ci, /DEPENDENCY_UPDATES_APP|pull_request_target/);
    assert.match(writer, /workflow_run:/);
    assert.match(writer, /ref: main/);
    assert.match(writer, /cache: false/);
    assert.match(writer, /steps\.source\.outputs\.artifact/);
    assert.match(
        writer,
        /SOURCE_ATTEMPT: \$\{\{ steps\.source\.outputs\.attempt \}\}/,
    );
    assert.match(
        writer,
        /SOURCE_ARTIFACT: \$\{\{ steps\.source\.outputs\.artifact \}\}/,
    );
    assert.doesNotMatch(
        writer,
        /outputs\.approved|maintainer approv|pull_request_target/,
    );
});
