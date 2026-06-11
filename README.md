# Weblate Localization GitHub Actions

This repository provides two dependency-free Node 24 GitHub Actions for Weblate localization automation:

- `setup-upload`: creates missing Weblate projects, components, and translation languages, then uploads local localization files.
- `download`: downloads translated files from Weblate and exposes outputs that a workflow can use to create a pull request.

The actions intentionally do not call Weblate `push`. GitHub Actions owns pull request creation.

## Manual Bootstrap

You still need to configure these once outside the action:

- A Weblate API token with permissions to create/manage projects, components, repository operations, languages, and uploads.
- A GitHub secret, for example `WEBLATE_TOKEN`.

Repository-backed components also need GitHub/Weblate repository access so Weblate can clone the repository. `local-files` components do not.

Native Apple String Catalog (`.xcstrings`) manifests require a Weblate deployment that exposes `file_format: "xcstrings"`.

## Manifest

The manifest is JSON and defaults to `.weblate-localization.json`. `version` should be set to `1`; omitted versions are treated as version `1` for early compatibility.

```json
{
  "version": 1,
  "defaults": {
    "mode": "repository",
    "repo": "https://github.com/example/mobile.git",
    "branch": "main",
    "vcs": "git",
    "upload": {
      "method": "translate",
      "conflicts": "ignore"
    }
  },
  "projects": [
    {
      "slug": "mobile",
      "name": "Mobile App",
      "web": "https://github.com/example/mobile"
    }
  ],
  "components": [
    {
      "project": "mobile",
      "slug": "android-app",
      "name": "Android App Strings",
      "file_format": "aresource",
      "filemask": "android/app/src/main/res/values-*/strings.xml",
      "template": "android/app/src/main/res/values/strings.xml",
      "translations": [
        {
          "language": "de",
          "path": "android/app/src/main/res/values-de/strings.xml"
        }
      ]
    }
  ]
}
```

Required project fields for setup are `slug`, `name`, and `web`.

Components support two modes:

- `repository` is the default. Weblate clones the repository itself. Setup requires `project`, `slug`, `name`, `repo` or `defaults.repo`, `file_format`, `filemask`, and `translations`. `branch` defaults to `main`; `vcs` defaults to `git`.
- `local-files` keeps Weblate disconnected from GitHub. Setup requires `project`, `slug`, `name`, `mode: "local-files"`, `docfile`, `file_format`, `filemask`, and `translations`. The action creates a VCS-less Weblate component and bootstraps it from `docfile`.

For normal per-language file formats, each `filemask` must contain exactly one `*` language placeholder. For native `.xcstrings` catalogs, set `file_format` to `xcstrings` and use the single catalog path as `filemask` without a `*`.

Use `template` for the monolingual base/source file when the Weblate component format needs one, for example Android `res/values/strings.xml` or repo-backed iOS `Resources/en.lproj/Localizable.strings`.

Use `docfile` only for `local-files` setup. It names the source file that must be present in the local file set.
For `local-files` components, the action automatically packages `docfile` plus the listed translation paths into a ZIP bootstrap.
For Weblate ZIP component creation, the action also defaults `new_base` to `docfile` and `new_lang` to `"none"` unless the manifest overrides them.
For bilingual formats such as `.strings`, `template` should be omitted in `local-files` mode.

Each translation requires `language` and `path` for uploads/downloads. `file` is accepted as an alias for `path`. For `.xcstrings`, `path` is optional and defaults to the catalog `filemask`; all languages share that one catalog file.

Upload validation requires translation paths to exist and point to regular files. Empty files are allowed, because some localization formats use zero-byte target files to represent an untranslated language.

Repository fields such as `repo`, `branch`, `push`, and `push_branch` must not be used with `mode: "local-files"`.

## Setup And Upload

```yaml
- uses: Inventas/github-action-weblate/setup-upload@v1
  with:
    weblate-url: https://weblate.example.com
    api-token: ${{ secrets.WEBLATE_TOKEN }}
    manifest: .weblate-localization.json
```

Useful inputs:

- `dry-run`: validates and performs API lookups without mutating Weblate.
- `setup`: create missing projects/components/translations. Default `true`.
- `upload`: upload files. Default `true`.
- `task-timeout-ms`: async Weblate task timeout. Default `300000`.
- `task-poll-interval-ms`: async Weblate task polling interval. Default `3000`.
- `fail-on-unsupported-xcstrings`: deprecated no-op kept for old workflows.

Outputs:

- `projects-created`
- `components-created`
- `translations-created`
- `files-uploaded`

## Download And PR

The download action writes files into the checkout and sets `changed=true` when the downloaded files differ.

```yaml
name: Sync Weblate

on:
  schedule:
    - cron: "0 4 * * *"
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - id: weblate
        uses: Inventas/github-action-weblate/download@v1
        with:
          weblate-url: https://weblate.example.com
          api-token: ${{ secrets.WEBLATE_TOKEN }}
          manifest: .weblate-localization.json
          lock: "true"

      - name: Create pull request
        if: steps.weblate.outputs.changed == 'true'
        uses: peter-evans/create-pull-request@v6
        with:
          add-paths: ${{ steps.weblate.outputs.changed-files }}
          commit-message: "chore(l10n): sync Weblate translations"
          title: "chore(l10n): sync Weblate translations"
          body: |
            Automated Weblate localization sync.

            Changed files:
            ${{ steps.weblate.outputs.changed-files }}
          branch: chore/weblate-sync
```

Download inputs:

- `repository-operation`: `none`, `pull`, `file-scan`, or `file-sync`. Default `pull`.
- `commit-before-download`: commit pending Weblate changes before download when `repository-operation` is not `none`. Default `true`.
- `fail-on-merge-needed`: abort on `needs_merge` or `merge_failure`. Default `true`.
- `lock`: lock components during download and always unlock components this action locked. Default `false`.
- `output-root`: directory where downloaded files are written. Default `.`.
- `task-timeout-ms`: async Weblate task timeout. Default `300000`.
- `task-poll-interval-ms`: async Weblate task polling interval. Default `3000`.
- `fail-on-unsupported-xcstrings`: deprecated no-op kept for old workflows.

For `local-files` manifests, the action skips Weblate repository preparation automatically because those components have no remote VCS. Keeping `repository-operation: none` in workflows is still the clearest configuration.

Outputs:

- `changed`
- `files-downloaded`
- `changed-files`

## Component Examples

Android:

```json
{
  "file_format": "aresource",
  "filemask": "app/src/main/res/values-*/strings.xml",
  "template": "app/src/main/res/values/strings.xml"
}
```

Local files:

```json
{
  "mode": "local-files",
  "name": "iOS Intents",
  "docfile": "Shared/en.lproj/OneSecIntents.strings",
  "file_format": "strings",
  "filemask": "Shared/*.lproj/OneSecIntents.strings",
  "translations": [
    { "language": "de", "path": "Shared/de.lproj/OneSecIntents.strings" }
  ]
}
```

iOS `.strings`:

```json
{
  "file_format": "strings",
  "filemask": "Resources/*.lproj/Localizable.strings",
  "template": "Resources/en.lproj/Localizable.strings"
}
```

iOS `.stringsdict`:

```json
{
  "file_format": "stringsdict",
  "filemask": "Resources/*.lproj/Localizable.stringsdict",
  "template": "Resources/en.lproj/Localizable.stringsdict"
}
```

iOS `.xcstrings`:

```json
{
  "file_format": "xcstrings",
  "filemask": "Resources/Localizable.xcstrings",
  "translations": [
    { "language": "de" },
    { "language": "nl" }
  ]
}
```

## Development

```bash
npm test
npm run lint
```
