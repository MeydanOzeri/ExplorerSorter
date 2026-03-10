# ExplorerSorter

Control VS Code Explorer ordering with `.order` files while keeping the built-in Explorer view.

## Features

- Built-in Explorer support, no custom tree view
- Exact workspace-relative path rules
- Glob rules
- Recursive `.order` inheritance
- Folders kept before files
- Lexical fallback for unmatched entries

## Install

Install from the VS Code Marketplace.

## Example

Create a `.order` file in your workspace:

```text
src/index.ts
src/**/*.test.ts
README.md
```

ExplorerSorter sets `explorer.sortOrder` to `modified` and updates mtimes to reflect the order produced by your rules.

## How Ordering Works

- Rules are evaluated per directory.
- For a child directory, the child `.order` file has priority and parent `.order` files are applied after it.
- Exact and glob matches are applied first.
- Entries with no matching rule stay in lexical order.
- Ignored directories are skipped through `explorerSorter.ignoredDirectories` and `explorerSorter.extraIgnoredDirectories`.

## Settings

- `explorerSorter.ignoredDirectories` - default directory names skipped during traversal
- `explorerSorter.extraIgnoredDirectories` - project-specific additions to the ignore list
