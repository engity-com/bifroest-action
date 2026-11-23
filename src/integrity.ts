import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export function archiveChecksum(contents: string, archiveName: string): string {
    const matches: string[] = [];
    for (const line of contents.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const match = /^([a-fA-F0-9]{64})[ \t]+\*?([^\r\n]+)$/.exec(line);
        if (!match) throw new Error("Malformed Bifröst checksum file.");
        if (match[2] === archiveName)
            matches.push(match[1]?.toLowerCase() ?? "");
    }
    if (matches.length !== 1) {
        throw new Error(`Expected exactly one checksum for ${archiveName}.`);
    }
    return matches[0] as string;
}

export async function verifyArchive(
    file: string,
    expected: string,
): Promise<void> {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    const actual = hash.digest("hex");
    if (actual !== expected) {
        throw new Error(
            `SHA-256 mismatch for the Bifröst archive: expected ${expected}, got ${actual}. The archive will not be extracted or executed.`,
        );
    }
}
