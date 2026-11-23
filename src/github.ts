import { HttpClient, HttpClientError } from "@actions/http-client";
import { downloadTool } from "@actions/tool-cache";
import type { Release, VersionSelector } from "./versions.ts";
import { selectStable } from "./versions.ts";

const repository = "engity-com/bifroest";
const api = `https://api.github.com/repos/${repository}`;

export interface ReleaseAsset {
    name: string;
    browser_download_url: string;
}

export interface ReleaseSource {
    resolve(selector: VersionSelector): Promise<Release>;
    assets(release: Release): Promise<ReleaseAsset[]>;
    download(asset: ReleaseAsset, destination: string): Promise<string>;
}

export class GitHubReleases implements ReleaseSource {
    private readonly http: HttpClient;
    private readonly headers: Record<string, string>;
    private readonly token: string;

    constructor(token = "") {
        this.token = token;
        this.headers = {
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
        };
        if (token) this.headers.authorization = `Bearer ${token}`;
        this.http = new HttpClient("engity-bifroest-action", [], {
            allowRetries: true,
            maxRetries: 3,
            socketTimeout: 60_000,
            allowRedirectDowngrade: false,
        });
    }

    private async json<T>(path: string): Promise<T> {
        try {
            const response = await this.http.getJson<T>(
                `${api}${path}`,
                this.headers,
            );
            if (response.statusCode === 404 || response.result === null) {
                throw new Error(`GitHub resource not found: ${path}.`);
            }
            return response.result;
        } catch (error) {
            if (error instanceof HttpClientError) {
                throw new Error(
                    `Bifröst release API failed (HTTP ${error.statusCode}). Check release availability and token permissions; an optional github.com token increases the API rate limit.`,
                );
            }
            throw error;
        }
    }

    private async pages<T>(path: string): Promise<T[]> {
        const result: T[] = [];
        for (let page = 1; ; page++) {
            const batch = await this.json<T[]>(
                `${path}?per_page=100&page=${page}`,
            );
            result.push(...batch);
            if (batch.length < 100) return result;
        }
    }

    async resolve(selector: VersionSelector): Promise<Release> {
        if (selector.kind === "stable") {
            return selectStable(
                await this.pages<Release>("/releases"),
                selector,
            );
        }
        const release = await this.json<Release>(
            `/releases/tags/${encodeURIComponent(selector.value)}`,
        );
        if (release.draft || release.tag_name !== selector.value) {
            throw new Error(
                `Bifröst release ${selector.value} is not published.`,
            );
        }
        return release;
    }

    async assets(release: Release): Promise<ReleaseAsset[]> {
        const assets = await this.pages<ReleaseAsset>(
            `/releases/${release.id}/assets`,
        );
        // Do not send a token to a URL chosen by API data or an enterprise endpoint.
        for (const asset of assets) {
            const url = new URL(asset.browser_download_url);
            const expectedPath = `/${repository}/releases/download/${release.tag_name}/${asset.name}`;
            if (
                url.origin !== "https://github.com" ||
                decodeURIComponent(url.pathname) !== expectedPath ||
                url.username ||
                url.password ||
                url.search ||
                url.hash
            ) {
                throw new Error(
                    `Unexpected download URL for release asset ${asset.name}.`,
                );
            }
        }
        return assets;
    }

    async download(asset: ReleaseAsset, destination: string): Promise<string> {
        const url = new URL(asset.browser_download_url);
        if (
            url.origin !== "https://github.com" ||
            !url.pathname.startsWith(`/${repository}/releases/download/`) ||
            url.username ||
            url.password ||
            url.search ||
            url.hash
        ) {
            throw new Error(
                "Refusing a release download outside the Bifröst repository.",
            );
        }
        // The toolkit strips Authorization on cross-host redirects and honors proxies.
        return downloadTool(
            url.href,
            destination,
            this.token ? `Bearer ${this.token}` : undefined,
        );
    }
}
