# Contributing

Use [MISE](https://mise.jdx.dev/) for the toolchain and project commands. You do not need global npm packages or a separate Go installation.

## Get started

Review `mise.toml`, then run from the repository root:

```text
mise trust
mise install
mise run install
mise run check
```

`mise run install` installs the exact npm lockfile without running dependency lifecycle scripts. The checked-in bundle should pass the initial check.

## Make a change

1. Edit the action in `src/` and add or update tests in `test/`.
2. Run `mise run format`, `mise run lint`, and `mise run test`.
3. Open a PR. For internal PRs, CI updates changed `dist/` files automatically, including for Dependabot. There is no separate approval or command to trigger bundle generation.
4. Review the final PR after the bot commit and wait for all required checks.

If you want to test the built action locally, run `mise run build`. This is also how to refresh a stale bundle before running `mise run check`. You do not need to maintain generated files by hand.

Fork contributors can submit source and test changes without manually updating the bundle. A maintainer must transfer the reviewed contribution to an internal branch for the automatic writer; the bot cannot push to a contributor's fork.

## Useful commands

| Command | Purpose |
| --- | --- |
| `mise run format` | Apply formatting and safe lint fixes. |
| `mise run lint` | Check formatting, both TypeScript contexts, and workflows. |
| `mise run test` | Run the Node action tests and Deno tooling tests. |
| `mise run build` | Build the minified action and dependency notices in `dist/`. |
| `mise run check:dist` | Rebuild in memory and compare against `dist/`; never overwrite it. |
| `mise run check` | Run lint, tests, and the bundle comparison. |
| `mise run test:download v0.7.7` | Download and run a real release twice to exercise setup and caching. |

Follow `.editorconfig`; use the formatter rather than manually formatting the generated bundle.

## Tests and platform coverage

- `test/*.test.ts` runs under **Node 24**, the action's actual runtime.
- `test/tasks/` runs under **Deno**, without network or subprocess permissions.
- The download test launches the shipped bundle under real Node, then runs the installed `bifroest version` through `PATH`.

The default download-test version is `v1.0.0-beta3`. It requires published assets for your platform; it fails if the upload is incomplete. Use an explicit available version when needed. `v0.7.7` works on Linux and Windows but has no macOS archive.

CI runs action tests on Linux, Windows, and macOS, each on x64 and ARM64. Its regular download checks use `v0.7.7` on Linux and Windows, including both Linux editions. The manual **Release download matrix** workflow tests a chosen version across all six runner combinations. Do not describe a prepared matrix as tested until its runs have actually passed.

Some writer filesystem tests require Unix link counts and are skipped on Windows. The pure policy tests still run there.

## Tooling conventions

MISE pins Node, Deno, Biome, actionlint, and ShellCheck. Longer tasks are native TypeScript file tasks under `mise-tasks/`; preserve their executable bits (`100755`) for Unix. MISE interprets their shebangs on Windows.

Deno tasks pin external dependencies directly in their imports. They disable project config and lockfile discovery; MISE also disables automatic `package.json` resolution. They use Deno's global dependency cache, not the project's npm tree. Keep new tasks consistent with that setup.

`package.json` and `package-lock.json` belong to the Node action and its type-checking dependencies. Both runtime JavaScript dependencies and their license notices are included in the generated distribution. If you change a dependency or the bundler, verify both generated files.

Do not commit `node_modules/` or local files under `var/`. The two generated `dist/` files are versioned because GitHub runs the action without building it.

See [maintenance](docs/maintaining.md) for dependency updates, bot setup, branch protection, and releases. Report vulnerabilities as described in [SECURITY.md](SECURITY.md).
