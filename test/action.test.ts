import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { type ActionCore, runAction } from "../src/action.ts";

function harness(inputs: Record<string, string> = {}) {
    const calls: [string, ...string[]][] = [];
    const core: ActionCore = {
        getInput: (name) => inputs[name] ?? "",
        setSecret: (value) => calls.push(["secret", value]),
        addPath: (value) => calls.push(["path", value]),
        setOutput: (name, value) => calls.push(["output", name, value]),
        setFailed: (value) => calls.push(["failed", value]),
        info: (value) => calls.push(["info", value]),
    };
    return { core, calls };
}

test("setup publishes exact version and executable path and masks tokens first", async () => {
    const { core, calls } = harness({ token: "secret" });
    const binaryPath = path.resolve("directory with spaces", "bifroest");
    await runAction(core, async () => ({
        version: "v1.0.0-beta3",
        binaryPath,
    }));
    assert.deepEqual(calls.slice(0, 4), [
        ["secret", "secret"],
        ["path", path.dirname(binaryPath)],
        ["output", "version", "v1.0.0-beta3"],
        ["output", "binary-path", binaryPath],
    ]);
});

test("invalid inputs fail without installation or success outputs", async () => {
    const { core, calls } = harness({ version: "main" });
    await runAction(core, async () => {
        throw new Error("must not install");
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.[0], "failed");
    assert.match(calls[0]?.[1] ?? "", /Invalid version/);
});

test("download and verification errors fail the action without changing PATH", async () => {
    const { core, calls } = harness();
    await runAction(core, async () => {
        throw new Error("checksum mismatch");
    });
    assert.deepEqual(calls, [["failed", "checksum mismatch"]]);
});
