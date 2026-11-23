import { parseSelector, type VersionSelector } from "./versions.ts";

export interface Inputs {
    selector: VersionSelector;
    edition: "generic" | "extended";
    sha256: string;
    token: string;
}

export function parseInputs(getInput: (name: string) => string): Inputs {
    const selector = parseSelector(getInput("version"));
    const edition = getInput("edition").trim() || "generic";
    if (edition !== "generic" && edition !== "extended") {
        throw new Error('Invalid edition. Use "generic" or "extended".');
    }
    const sha256 = getInput("sha256").trim().toLowerCase();
    if (sha256 && !/^[a-f0-9]{64}$/.test(sha256)) {
        throw new Error(
            "Invalid sha256. Expected exactly 64 hexadecimal characters.",
        );
    }
    return { selector, edition, sha256, token: getInput("token").trim() };
}
