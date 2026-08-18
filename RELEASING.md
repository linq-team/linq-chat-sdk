# Releasing

Only one package is published from this repo: [`@linqapp/chat-sdk-adapter`](packages/adapter-linq)
(`apps/api` is an example app and stays private).

Publishing is driven by the `version` field in
`packages/adapter-linq/package.json`. Changing that field on `main` is what
triggers a release — there is no separate "publish" button to remember.

## Cutting a release

1. Bump the version on a branch:

   ```bash
   pnpm version:adapter minor   # or patch / major / 0.2.0
   ```

2. Open a PR with just that bump (or fold it into the last feature PR — either
   works) and get it merged into `main`.

3. That's it. The [Publish adapter](.github/workflows/publish.yml) workflow runs
   on merge and:
   - re-runs lint, format, typecheck, test, and build;
   - publishes to npm with [provenance](https://docs.npmjs.com/generating-provenance-statements);
   - pushes a `v<version>` tag;
   - creates a GitHub release with auto-generated notes.

Watch it under
[Actions → Publish adapter](https://github.com/linq-team/linq-chat-sdk/actions/workflows/publish.yml).
The job is a no-op if that version is already on npm, so re-running it or
merging an unrelated `package.json` change is safe.

## Versioning

The adapter is pre-1.0, so we use `0.MINOR.PATCH`:

- **minor** (`0.1.0` → `0.2.0`) — new adapter capabilities, or a change to
  `LinqAdapterConfig` / exported types that callers may need to react to.
- **patch** (`0.2.0` → `0.2.1`) — bug fixes and internal changes that keep the
  public surface identical.

## One-time setup

The publish workflow needs a single repository or org secret:

| Secret      | Used for                                                              |
| ----------- | --------------------------------------------------------------------- |
| `NPM_TOKEN` | An npm **automation** token with publish access to the `@linqapp` scope. |

`GITHUB_TOKEN` is provided by Actions; the workflow requests `contents: write`
(tag + release) and `id-token: write` (provenance).

## Publishing by hand

Only needed if Actions is down or the token is broken:

```bash
pnpm install --frozen-lockfile
pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build

cd packages/adapter-linq
npm publish --access public

git tag "v$(node -p 'require("./package.json").version')"
git push origin --tags
```

## If we outgrow this

The current setup deliberately has no changelog tooling. If release notes per
change become important, [Changesets](https://github.com/changesets/changesets)
drops in cleanly: it would own the version bump and `CHANGELOG.md`, and
`publish.yml` would trigger off the changesets release PR instead of the
`package.json` path filter.
