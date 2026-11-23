#!/usr/bin/env -S deno run --no-config --no-lock --node-modules-dir=none --allow-read --allow-write=dist --allow-env --allow-run
//MISE description="Bundle the Node action and third-party license notices using Deno"
//MISE env={DENO_NO_PACKAGE_JSON="1"}
import { buildBundle } from "./lib/build.ts";

await buildBundle(false);
