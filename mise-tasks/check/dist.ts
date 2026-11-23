#!/usr/bin/env -S deno run --no-config --no-lock --node-modules-dir=none --allow-read --allow-env --allow-run
//MISE description="Compare a clean Deno-driven build with the versioned bundle without writing dist/"
//MISE env={DENO_NO_PACKAGE_JSON="1"}
import { buildBundle } from "../lib/build.ts";

await buildBundle(true);
