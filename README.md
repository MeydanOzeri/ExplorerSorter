# ExplorerSorter

Control VS Code Explorer ordering with `.order` files while keeping the built-in Explorer view.

ExplorerSorter does not add a custom file tree. Instead, it uses the built-in Explorer and updates file and folder mtimes so VS Code displays the order produced by your rules.

## Features

- Built-in Explorer support, no custom tree view
- Exact workspace-relative path rules
- Glob rules
- Recursive `.order` inheritance
- Folders kept before files
- Lexical fallback for unmatched entries

## Install

Install from the VS Code Marketplace.

## Quick Start

Create a `.order` file in your workspace:

```text
src/index.ts
src/**/*.test.ts
README.md
```

Then let ExplorerSorter do the rest:

- it sets `explorer.sortOrder` to `modified`
- it applies your `.order` rules per directory
- it keeps unmatched entries in lexical order

## Rule Types

- Exact rule: `src/index.ts`
- Glob rule: `src/**/*.test.ts`
- Comment: `# keep important files first`

Rules are always workspace-relative.
Lines starting with `#` are ignored.

## How Ordering Works

- Rules are evaluated per directory.
- For a child directory, the child `.order` file is applied first, then inherited parent rules are applied after it.
- Exact and glob matches are applied first.
- Entries with no matching rule stay in lexical order.
- Folders and files are sorted separately, so folders stay before files.
- Ignored directories are skipped through `explorerSorter.ignoredDirectories` and `explorerSorter.extraIgnoredDirectories`.

## Example Inheritance

If the workspace root `.order` has:

```text
src
README.md
```

and `docs/.order` has:

```text
guide.md
```

then the merged order file will look like this:

```text
guide.md
src
README.md
```

## Settings

- `explorerSorter.ignoredDirectories` - replace the built-in ignored directory list completely, use when you want full control.
- `explorerSorter.extraIgnoredDirectories` - add more ignored directories without replacing the built-in defaults, use when you only want to append a few extra directories.

## License

Licensed under the MIT License.
