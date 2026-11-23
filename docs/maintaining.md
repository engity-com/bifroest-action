# Repository maintenance

This guide is for repository maintainers. It is not required to use the action. For local development commands, see [CONTRIBUTING.md](../CONTRIBUTING.md).

## One-time GitHub setup

The source checkout does not configure GitHub settings. Before relying on the automation:

1. Publish the initial trusted `main` commit with sources, lockfile, and a bundle built using `mise run build` and checked with `mise run check`.
2. Install the existing GitHub App on this repository and make these Actions secrets available:
   - `DEPENDENCY_UPDATES_APP_CLIENT_ID`
   - `DEPENDENCY_UPDATES_APP_PRIVATE_KEY`
3. Allow the App to mint a token with `contents: write` for this repository. It does not need a branch-protection bypass or a personal access token.
4. Protect `main`: require PR review, up-to-date branches, **CI passed**, and **Bundle matches source**. Block direct pushes and bypasses as appropriate for the repository's policy.
5. Check that the configured Linux, Windows, macOS, and ARM64 runners are available to the repository, then verify the workflows on a real PR.

Keep the App private key out of Dependabot secrets and build jobs. The trusted `workflow_run` job can use normal Actions secrets even when the triggering Dependabot workflow has only a read-only token and no App secrets.

## How the bundle reaches `main`

```text
PR source change
    → CI tests and builds without App credentials or repository write access
    → Update bundle validates the successful run and current internal PR
    → App commits changed dist files on that PR branch
    → fresh CI and bundle-integrity checks
    → reviewed merge carries sources and bundle together to main
```

This applies to human, Dependabot, and draft PRs targeting `main`. No preliminary review, label, Git hook, or manual dispatch is needed to generate the bundle. An unchanged bundle creates no commit, so the App-triggered CI does not loop. The merge itself is not automatic.

**Bundle integrity** rebuilds in memory and compares both distribution files byte for byte on PRs, `main`, and `v*` tags. A stale bundle can make that check red while the automatic writer is working. The writer waits for the separate **CI** workflow, not for the stale-bundle check; making it wait for both would deadlock.

There is no post-merge bundle commit. Without enforced branch protection, however, red checks only report problems: they do not prevent a bad commit reaching `main`.

## Writer safeguards

The writer executes tooling only from trusted `main` and does not restore build or tool caches. It never checks out PR code, installs PR dependencies, or executes artifact JavaScript. The App token can write repository contents; the trusted writer—not token path permissions—limits changes to:

- `dist/index.cjs`
- `dist/licenses.txt`

It requires exactly one matching open internal PR, successful CI, and the current source SHA. Missing PR associations are recovered through GitHub's commit-to-PR API, not a PR number supplied in an artifact. Forks, closed PRs, stale heads, and ambiguous matches are rejected.

Artifacts are named by source SHA and build attempt, within their CI run. The writer checks the actual successful **Build bundle** job: a failed-jobs-only retry may reuse an earlier successful build from the same source commit. It rejects changed workflow attempts or mismatched artifacts during processing.

After validating the artifact, the writer compares it with the source commit and rechecks eligibility. GitHub's `createCommitOnBranch` uses `expectedHeadOid` to check and update the branch atomically. A concurrent push or Dependabot rebase cannot be overwritten; the next successful CI run handles the new head.

These checks protect the write operation, not the correctness of arbitrary PR code. Review dependency, generator, and workflow changes before merging. See [security boundaries](../SECURITY.md) for artifact and runner trust.

## Dependabot and dependency updates

`.github/dependabot.yml` updates npm dependencies and SHA-pinned GitHub Actions weekly. Toolkit packages are grouped; `@types/node` stays on the Node 24 major line. Dependabot PRs use the same automatic bundle flow as other internal PRs.

Generated App commits carry **`[dependabot skip]`**. This permits Dependabot to discard those generated-only commits during its next rebase or update. The next CI run regenerates the bundle. It does **not** skip GitHub Actions. Never add the marker to source changes that must be preserved.

Dependabot does not update inline Deno imports or MISE pins. Its current [Deno updater](https://github.com/dependabot/dependabot-core/blob/main/deno/lib/dependabot/deno/file_fetcher.rb) requires a `deno.json` or `deno.jsonc` import mapping. Do not add a nonfunctional Deno ecosystem entry for this manifest-free task setup. Until a separate updater is chosen, update these pins explicitly and run `mise run check`:

- Tool versions in `mise.toml`.
- External Deno imports, such as the esbuild import in `mise-tasks/lib/build.ts`.

## Troubleshooting bundle updates

| Symptom | What to check |
| --- | --- |
| Writer never starts | The workflow must already exist on default branch `main`; the triggering CI must have succeeded. |
| Writer reports no eligible source | Check the PR's repository, target branch, open state, source SHA, and successful build job. A newer push needs its own completed CI. |
| App authentication fails | Check App installation and access to the two normal Actions secrets. Do not give the build access to the private key. |
| Artifact is missing or expired | Rerun the full CI for the current head to produce a fresh build artifact. |
| Writer rejects a stale update | A push, rebase, or retry changed the checked state. Let the newer CI finish; do not force an old bundle onto the branch. |
| Dependabot stops rebasing | Check that generated-only commits contain `[dependabot skip]`. Extra source edits must not be marked discardable. |

The manual **Update bundle** dispatch on `main` accepts a successful CI `run-id` as an optional recovery mechanism if the normal trigger was missed. It applies the same eligibility checks; it is not an override.

For fork contributions, review and transfer the changes to an internal branch. The normal automatic flow then applies. Do not build fork code with App secrets or use `pull_request_target` to bypass the restriction.

## Publishing releases

**Publication is not yet gated by a release workflow.** The tag-triggered bundle check runs after a tag exists and cannot prevent callers using it or an administrator manually publishing a release. Do not claim otherwise.

Before publishing an action release:

1. Select a reviewed `main` commit with fresh successful CI and bundle-integrity checks. It must already contain the final `dist/` files.
2. Run **Release download matrix** against the intended Bifröst baseline. That release must have assets for all claimed platforms, including macOS. Prepared jobs are not evidence of passing coverage.
3. Create the full SemVer action tag, such as `v1.0.0`, at that exact commit and publish the GitHub release and Marketplace entry.
4. Keep full version tags immutable; enable immutable releases where available.
5. After successful stable publication, move the compatible major alias, such as `v1`. Do not attach an immutable release to that movable alias.

For enforced publication, a future trusted workflow must verify a specific protected `main` commit first and create its tag/release only in a later privileged job. Restrict full-version tag creation, movement, and deletion through GitHub repository rules.

GitHub runs the committed bundle directly. A release asset does not replace the entrypoint, and missing JavaScript must never be generated after publishing a tag.
