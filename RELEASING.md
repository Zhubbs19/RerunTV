# Releasing RerunTV

This is the maintainer's checklist for publishing a release. Releases are built by CI from the
`deploy` branch; nothing is built or uploaded by hand.

## How versions work

Releases are `MAJOR.MINOR.PATCH-beta.N`.

- The base (`MAJOR.MINOR.PATCH`) comes from `package.json`. Bump it by hand for a new minor or major.
- `N` is the run number of the **Build installer** workflow. It only ever counts up (it does not
  reset when the base changes), so every release is newer than the one before it.
- Every release is marked a pre-release, and CI keeps only the latest one published. Older
  pre-releases are deleted when a new one is created.

## Before you push

1. `master` is green: the **CI** and **CodeQL** runs pass, and there is nothing unreviewed in Dependabot.
2. `npm test` passes locally.
3. If something users will notice changed, add a dated entry at the top of `CHANGELOG` in
   `renderer/js/setup/settings.js` (HELP > What's New), and a `HIGHLIGHTS` item in
   `renderer/js/update/highlights.js` if it is worth a call-out.
4. For a new minor or major version, bump `version` in `package.json` **and** the two matching
   `version` fields at the top of `package-lock.json`.
5. If the in-app manual or the README changed, regenerate the wiki (`node scripts/generate-wiki.js`,
   see that file's header) and push it.

## Publish

Push the commit you want to release to `deploy`, from a checkout whose history is the public history:

```bash
git push origin master:deploy
```

Only repository admins can push `deploy` (it is protected by a ruleset), because the push starts a
release build. The workflow then:

1. installs dependencies and runs `npm test`,
2. computes the version (`<base>-beta.<run number>`),
3. builds the Windows installer with electron-builder,
4. writes `SHA256SUMS.txt` and a signed build-provenance attestation for the installer,
5. creates the GitHub pre-release with the installer, its blockmap, `latest.yml` and `SHA256SUMS.txt`.

When that workflow succeeds, the **Demo pack** workflow runs automatically and attaches
`RerunTV-demo-library.zip` (generated, copyright-free test video, with a build attestation) to the
same release. You can also run it by hand from the Actions tab against any release tag.

Every push and pull request to `master` also runs the **Installer smoke test**: it builds the real
installer, installs it silently on a throwaway runner, launches the installed app and checks that it
boots (right version, all bundled plugins load, no uncaught errors). Fix a red run before releasing.

## Verify the release

- The release exists, is marked **pre-release**, and has all four build assets, plus
  `RerunTV-demo-library.zip` once the Demo pack workflow has finished.
- `latest.yml` names the new version and the installer's size matches the asset.
- The attestation exists: `gh attestation verify <installer> --repo Zhubbs19/RerunTV`, or look the
  installer's SHA-256 (from `SHA256SUMS.txt`) up under the repository's attestations.
- Install it on a clean machine, and upgrade a machine that has the previous version to confirm the
  in-app update works. Expect the Windows SmartScreen warning while installers are unsigned.

## If a release is bad

Delete it and its tag, fix the problem, and push `deploy` again. The next build gets a higher number.

```bash
gh release delete <tag> --repo Zhubbs19/RerunTV --cleanup-tag --yes
```

## Not done yet

Installers are not code-signed. When signing is added, update this checklist, the README's
"Download and install" section, and `SECURITY.md`, and set `publisherName` in the electron-builder
config so the updater verifies each update's signature.
