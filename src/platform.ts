export interface Platform {
    os: "linux" | "darwin" | "windows";
    arch: "amd64" | "arm64";
    edition: "generic" | "extended";
    archiveName: string;
    binaryName: string;
}

export function detectPlatform(
    edition: "generic" | "extended",
    os: string = process.platform,
    architecture: string = process.arch,
): Platform {
    if (os !== "linux" && os !== "darwin" && os !== "win32") {
        throw new Error(`Unsupported runner operating system: ${os}.`);
    }
    if (architecture !== "x64" && architecture !== "arm64") {
        throw new Error(`Unsupported runner architecture: ${architecture}.`);
    }
    if (edition === "extended" && os !== "linux") {
        throw new Error('The "extended" edition is only available on Linux.');
    }
    const name = os === "win32" ? "windows" : os;
    const arch = architecture === "x64" ? "amd64" : "arm64";
    return {
        os: name,
        arch,
        edition,
        archiveName: `bifroest-${name}-${arch}-${edition}.${os === "win32" ? "zip" : "tgz"}`,
        binaryName: os === "win32" ? "bifroest.exe" : "bifroest",
    };
}
