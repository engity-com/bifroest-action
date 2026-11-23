# Security

## Report a vulnerability

Do not publish credentials, private keys, or sensitive evidence in an issue. Report security vulnerabilities privately through this repository's GitHub security advisory reporting feature when enabled. If private reporting is not enabled, ask a maintainer for a private reporting channel without disclosing vulnerability details publicly.

## Release and download trust

The action installs software from the public `engity-com/bifroest` releases on github.com. It verifies each archive against `bifroest-checksums.txt` before extraction, including cached archives. A mismatch fails setup rather than adding an unverified executable to `PATH`.

A checksum supplied by the same release is not independent authentication against a compromised upstream release. For stronger binding, pin all three:

- The action's full reviewed commit SHA.
- An exact Bifröst version.
- An independently trusted SHA-256 of the platform-specific release **archive**.

Archive digests differ by OS, architecture, and edition. Combining a fixed digest with a moving selector such as `latest` intentionally fails when the selected release's digest changes. Update trusted pins explicitly rather than disabling verification.

## Tokens and GitHub Enterprise

The optional `token` is sent only to github.com download endpoints and its public API, not the enterprise API selected by a caller's workflow. On GitHub Enterprise Server, omit it or supply a separate github.com token; never pass an enterprise token to github.com. Tokens are masked in Actions logs, and the HTTP toolkit removes authorization on cross-host download redirects and honors proxy settings.

## Runner and cache boundaries

Self-hosted runner filesystems and tools are trusted. The action does not isolate other jobs or defend against another process replacing files concurrently on a compromised runner. Keep runner workspaces, temporary files, and tool caches private and clean them according to your runner lifecycle policy.

The cache stores verified archives, keyed by resolved version, platform, edition, and digest. Each hit is rehashed against the freshly retrieved release checksum and extracted into a new runner temporary directory. There is no automatic cross-job cache upload or upload of user files.

## Automated bundle updates

Build jobs do not receive App credentials or repository write permissions. The separate writer executes trusted default-branch tooling and treats build artifacts only as data. It accepts only the two fixed distribution files, each a regular non-symlink file with one hard link and a maximum size of 16 MiB, in a non-symlink directory. It does not execute their contents.

The writer's App token has repository-wide `contents: write`; it is not inherently path-scoped. The trusted writer enforces the fixed paths, PR branch, source SHA, and CI provenance. Code review and enforced branch protection remain necessary before merging. See [repository maintenance](docs/maintaining.md) for setup and the complete publication limitations.

## Automated major release tags

The post-publication updater executes only trusted `main` tooling and does not execute the published release's code. Its repository-scoped `GITHUB_TOKEN` has `contents: write`; the task restricts mutations to the stable release's derived `refs/tags/v<major>` alias. It never modifies full version tags or branches, and does not use App secrets. All tag pages, current release flags, the source tag, and concurrent alias changes are checked before the conditional update. Moving major aliases are intentionally mutable and are not a replacement for a reviewed full commit SHA pin.
