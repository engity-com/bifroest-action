import * as core from "@actions/core";
import * as cache from "@actions/tool-cache";
import { runAction } from "./action.ts";
import { GitHubReleases } from "./github.ts";
import { extractArchive, install } from "./install.ts";
import { detectPlatform } from "./platform.ts";

void runAction(core, async (inputs) => {
    const platform = detectPlatform(inputs.edition);
    const tempRoot = process.env.RUNNER_TEMP;
    if (!tempRoot || !process.env.RUNNER_TOOL_CACHE) {
        throw new Error(
            "RUNNER_TEMP and RUNNER_TOOL_CACHE must be set by the Actions runner.",
        );
    }
    return install(inputs, platform, {
        source: new GitHubReleases(inputs.token),
        cache,
        extract: extractArchive,
        tempRoot,
        info: core.info,
    });
});
