#!/usr/bin/env -S deno run --no-config --no-lock --no-npm --no-remote --allow-read --allow-write --allow-env --allow-run
//MISE description="Download and execute a real Bifröst release twice to test the Node action and cache"
//MISE env={DENO_NO_PACKAGE_JSON="1"}
//USAGE arg "[version]" help="Release selector (defaults to BIFROEST_TEST_VERSION or v1.0.0-beta3)"
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const temp = await Deno.makeTempDir({
    dir: Deno.env.get("RUNNER_TEMP"),
    prefix: "bifroest-smoke-",
});
const decoder = new TextDecoder();

async function execute(
    command: string,
    args: string[],
    env: Record<string, string>,
): Promise<string> {
    const result = await new Deno.Command(command, {
        args,
        env,
        stdout: "piped",
        stderr: "piped",
    }).output();
    await Deno.stdout.write(result.stdout);
    await Deno.stderr.write(result.stderr);
    assert.equal(result.code, 0, `${command} failed`);
    return decoder.decode(result.stdout);
}

try {
    const cache = path.join(temp, "cache");
    await Deno.mkdir(cache);
    const pathFile = path.join(temp, "path");
    const outputFile = path.join(temp, "outputs");
    await Deno.writeTextFile(pathFile, "");
    await Deno.writeTextFile(outputFile, "");
    const env = {
        RUNNER_TEMP: temp,
        RUNNER_TOOL_CACHE: cache,
        GITHUB_PATH: pathFile,
        GITHUB_OUTPUT: outputFile,
        INPUT_VERSION:
            Deno.env.get("usage_version") ||
            Deno.args[0] ||
            Deno.env.get("BIFROEST_TEST_VERSION") ||
            "v1.0.0-beta3",
        INPUT_EDITION: Deno.env.get("BIFROEST_TEST_EDITION") || "generic",
        INPUT_SHA256: Deno.env.get("BIFROEST_TEST_SHA256") || "",
        INPUT_TOKEN: Deno.env.get("GITHUB_TOKEN") || "",
    };
    for (let attempt = 0; attempt < 2; attempt++) {
        // Intentionally run the shipped bundle under Node, never Deno's Node shim.
        const stdout = await execute(
            "node",
            [path.join(root, "dist/index.cjs")],
            env,
        );
        if (attempt === 1) assert.match(stdout, /Using cached archive/);
    }
    const directory = (await Deno.readTextFile(pathFile))
        .trim()
        .split(/\r?\n/)
        .at(-1);
    assert.ok(directory, "setup did not add a directory to PATH");
    const executable = path.join(
        directory,
        Deno.build.os === "windows" ? "bifroest.exe" : "bifroest",
    );
    const outputs = await Deno.readTextFile(outputFile);
    assert.ok(outputs.includes("version<<"));
    assert.ok(outputs.includes("binary-path<<"));
    assert.ok(outputs.includes(executable));
    await execute("bifroest", ["version"], {
        PATH: `${directory}${path.delimiter}${Deno.env.get("PATH") || ""}`,
    });
} finally {
    await Deno.remove(temp, { recursive: true });
}
