import path from "node:path";
import type { Inputs } from "./inputs.ts";
import { parseInputs } from "./inputs.ts";
import type { Installation } from "./install.ts";

export interface ActionCore {
    getInput(name: string): string;
    setSecret(secret: string): void;
    addPath(directory: string): void;
    setOutput(name: string, value: string): void;
    setFailed(message: string): void;
    info(message: string): void;
}

export async function runAction(
    core: ActionCore,
    setup: (inputs: Inputs) => Promise<Installation>,
): Promise<void> {
    try {
        const token = core.getInput("token").trim();
        if (token) core.setSecret(token);
        const result = await setup(parseInputs((name) => core.getInput(name)));
        core.addPath(path.dirname(result.binaryPath));
        core.setOutput("version", result.version);
        core.setOutput("binary-path", result.binaryPath);
        core.info(
            `Bifröst ${result.version} is available at ${result.binaryPath}.`,
        );
    } catch (error) {
        core.setFailed(error instanceof Error ? error.message : String(error));
    }
}
