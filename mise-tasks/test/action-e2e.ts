#!/usr/bin/env -S deno run --no-config --no-lock --no-npm --no-remote --allow-read --allow-env --allow-run
//MISE description="Temporary assertions for the published action's end-to-end test"
//MISE env={DENO_NO_PACKAGE_JSON="1"}
import assert from "node:assert/strict";
import path from "node:path";

const first = Deno.env.get("FIRST_PATH") || "";
const second = Deno.env.get("SECOND_PATH") || "";
assert.equal(Deno.env.get("FIRST_VERSION"), "v1.0.0-beta3");
assert.equal(Deno.env.get("SECOND_VERSION"), "v1.0.0-beta3");
assert.ok(path.isAbsolute(first));
assert.ok(path.isAbsolute(second));
assert.notEqual(first, second, "cache hits must extract into a new directory");
assert.ok((await Deno.stat(first)).isFile);
assert.ok((await Deno.stat(second)).isFile);
assert.ok(
    (Deno.env.get("PATH") || "")
        .split(path.delimiter)
        .includes(path.dirname(second)),
);
for (const prefix of ["PIN", "RANGE"]) {
    assert.equal(Deno.env.get(`${prefix}_OUTCOME`), "failure");
    assert.equal(Deno.env.get(`${prefix}_VERSION`), "");
    assert.equal(Deno.env.get(`${prefix}_PATH`), "");
}
const result = await new Deno.Command("bifroest", {
    args: ["version"],
    stdout: "piped",
    stderr: "piped",
}).output();
await Deno.stdout.write(result.stdout);
await Deno.stderr.write(result.stderr);
assert.equal(result.code, 0);
assert.match(
    new TextDecoder().decode(result.stdout),
    /Version:\s+v1\.0\.0-beta3/,
);
console.log(
    "Published action, output propagation, PATH, cache, digest rejection, and stable-only selection passed.",
);
