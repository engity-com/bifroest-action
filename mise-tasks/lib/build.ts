import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, stop } from "npm:esbuild@0.28.2";
import { distFiles } from "./dist-files.ts";

interface PackageMetadata {
    name: string;
    version: string;
    license?: string;
}

async function maybe<T>(operation: Promise<T>, fallback: T): Promise<T> {
    try {
        return await operation;
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) return fallback;
        throw error;
    }
}

async function notices(
    directory: string,
    prefix = "",
): Promise<{ name: string; text: string }[]> {
    const result: { name: string; text: string }[] = [];
    for await (const entry of Deno.readDir(directory)) {
        if (entry.name === "node_modules") continue;
        const relative = `${prefix}${entry.name}`;
        if (entry.isDirectory) {
            result.push(
                ...(await notices(
                    path.join(directory, entry.name),
                    `${relative}/`,
                )),
            );
        } else if (
            /^(license|licence|copying|notice)(\..*)?$/i.test(entry.name)
        ) {
            result.push({
                name: relative,
                text: await Deno.readTextFile(path.join(directory, entry.name)),
            });
        }
    }
    return result.sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
}

export async function buildBundle(checking: boolean): Promise<void> {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    try {
        const result = await build({
            absWorkingDir: root,
            entryPoints: ["src/main.ts"],
            outfile: "dist/index.cjs",
            bundle: true,
            platform: "node",
            target: "node24",
            format: "cjs",
            minify: true,
            legalComments: "eof",
            metafile: true,
            write: false,
            banner: {
                js: "// Copyright (c) 2026 Engity GmbH. MIT; dependency notices: licenses.txt.",
            },
        });
        const packages = new Map<
            string,
            { directory: string; metadata: PackageMetadata }
        >();
        for (const input of Object.keys(result.metafile.inputs)) {
            if (!input.includes("node_modules/")) continue;
            let directory = path.dirname(path.join(root, input));
            while (directory !== root) {
                const contents = await maybe(
                    Deno.readTextFile(path.join(directory, "package.json")),
                    "",
                );
                if (contents) {
                    const metadata: PackageMetadata = JSON.parse(contents);
                    if (metadata.name && metadata.version) {
                        packages.set(`${metadata.name}@${metadata.version}`, {
                            directory,
                            metadata,
                        });
                        break;
                    }
                }
                directory = path.dirname(directory);
            }
        }

        let licenseText =
            "Third-party notices for the bundled Bifröst setup action.\n";
        licenseText +=
            "The action's own code is licensed under MIT; see ../LICENSE.\n";
        licenseText +=
            "The downloaded Bifröst binary is separate and is not included in this bundle.\n";
        for (const name of [...packages.keys()].sort()) {
            const entry = packages.get(name);
            if (!entry)
                throw new Error(`Missing dependency metadata: ${name}.`);
            const files = await notices(entry.directory);
            if (files.length === 0)
                throw new Error(
                    `No license notice found for bundled dependency ${name}.`,
                );
            licenseText += `\n${"=".repeat(72)}\n${name} (${entry.metadata.license ?? "see notices"})\n`;
            for (const file of files)
                licenseText += `\n--- ${file.name} ---\n${file.text.trimEnd()}\n`;
        }
        const output = result.outputFiles[0];
        if (!output)
            throw new Error("The bundler produced no JavaScript output.");
        const encoder = new TextEncoder();
        const files = new Map<string, Uint8Array>([
            ["index.cjs", output.contents],
            ["licenses.txt", encoder.encode(licenseText)],
        ]);
        const directory = path.join(root, "dist");
        const directoryStat = await maybe<Deno.FileInfo | null>(
            Deno.lstat(directory),
            null,
        );
        if (
            directoryStat &&
            (!directoryStat.isDirectory || directoryStat.isSymlink)
        ) {
            throw new Error("dist/ must be a regular directory, not a link.");
        }
        if (!checking) await Deno.mkdir(directory, { recursive: true });
        const entries = await maybe(
            Array.fromAsync(Deno.readDir(directory)),
            [],
        );
        if (entries.some((entry) => !distFiles.includes(entry.name))) {
            throw new Error(
                "Unexpected files in dist/. Refusing to overwrite or ignore them.",
            );
        }
        for (const [name, content] of files) {
            const filename = path.join(directory, name);
            const stat = await maybe<Deno.FileInfo | null>(
                Deno.lstat(filename),
                null,
            );
            // Deno exposes link counts on Unix; Windows filesystems remain trusted.
            if (
                stat &&
                (!stat.isFile ||
                    stat.isSymlink ||
                    (stat.nlink !== null && stat.nlink !== 1))
            ) {
                throw new Error(
                    `Not an independent regular file: ${filename}.`,
                );
            }
            if (checking) {
                const actual = await maybe(
                    Deno.readFile(filename),
                    new Uint8Array(),
                );
                if (
                    actual.length !== content.length ||
                    actual.some((byte, index) => byte !== content[index])
                ) {
                    throw new Error(
                        `dist/${name} is stale. Run mise run build, or use the approved internal bundle-update workflow.`,
                    );
                }
            } else await Deno.writeFile(filename, content);
        }
        console.log(
            checking
                ? "dist/ matches a clean build."
                : "Built dist/ including third-party license notices.",
        );
    } finally {
        stop();
    }
}
