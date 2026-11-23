# Setup Bifröst

Install [Bifröst](https://github.com/engity-com/bifroest) in a GitHub Actions job. The action verifies the download and adds `bifroest` to `PATH` for all subsequent steps in that job.

Use `@v1` for compatible action updates, or pin a reviewed full commit SHA for production.

The `v1` tag is updated automatically when the highest stable `1.x.y` action release is published. Prereleases do not move it.

## Quick start

Save this as `.github/workflows/bifroest.yml`:

```yaml
name: Bifröst
on: [push, pull_request]

permissions:
  contents: read

jobs:
  example:
    runs-on: ubuntu-24.04
    steps:
    - uses: engity-com/bifroest-action@v1
      id: bifroest
      with:
        token: ${{ github.token }} # optional; increases the API rate limit
    - run: bifroest version
```

This installs the latest stable Bifröst release. To select another version, add `version` under `with:` as described below. Then invoke any CLI command supported by that release in a normal `run:` step. Check out your repository first if the command needs files from it.

## Choose a Bifröst version

The action reference (`@v1` above) and the installed Bifröst version are separate. Choose a release from the [Bifröst release page](https://github.com/engity-com/bifroest/releases). Use the `v` prefix for numbered selectors.

| `version`          | Selection                       |
| ------------------ | ------------------------------- |
| `latest` (default) | Highest stable release.         |
| `v1`               | Highest stable `1.x.y` release. |
| `v1.2`             | Highest stable `1.2.x` release. |
| `v1.2.3`           | Exactly that release.           |
| `v1.2.3-beta4`     | Exactly that prerelease.        |

Moving selectors exclude prereleases and use semantic version order, not release dates. Prereleases require an exact tag. The selected release must include a download for your platform; otherwise setup fails instead of substituting another version. Older releases may not provide newer commands such as `bifroest test`.

## Inputs

All inputs are optional.

| Input | Default | Description |
| --- | --- | --- |
| `version` | `latest` | Bifröst version selector from the table above. |
| `edition` | `generic` | `generic`, or `extended` on Linux. |
| `token` | unset | A github.com token for API requests and downloads. |
| `sha256` | unset | Independently trusted SHA-256 of the selected platform's **archive**, as 64 hexadecimal characters. |

Downloads always come from github.com. On GitHub Enterprise Server, omit `token` or supply a separate github.com token; do not send an enterprise token.

## Outputs

With the example's `id: bifroest`, read outputs as `${{ steps.bifroest.outputs.version }}` or `${{ steps.bifroest.outputs.binary-path }}`.

| Output        | Description                                 |
| ------------- | ------------------------------------------- |
| `version`     | Exact installed release tag, including `v`. |
| `binary-path` | Absolute path to the installed executable.  |

## Supported runners

Linux, Windows, and macOS on **x64 and ARM64**, where the selected Bifröst release provides a matching binary. For example, `v0.7.7` has no macOS archive.

The Linux `extended` edition needs compatible glibc and PAM libraries; the action does not install system packages. See the [Bifröst distribution requirements](https://bifroest.engity.org/setup/distribution/). Self-hosted runners need Node 24 action support and `tar` on Linux/macOS or PowerShell on Windows.

## Download security

Every archive is checked against the release's SHA-256 checksum, including cache hits. For stronger pinning, use a reviewed action commit, an exact Bifröst version, and an independently trusted `sha256` value. See [security details](SECURITY.md).

## Contributing and license

- [Development and tests](CONTRIBUTING.md)
- [Repository maintenance and releases](docs/maintaining.md)

This action is [MIT licensed](LICENSE). Bifröst and bundled dependencies retain their own licenses; see [third-party notices](dist/licenses.txt).
