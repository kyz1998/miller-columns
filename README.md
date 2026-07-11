# Miller Columns

An Obsidian plugin that replaces tree-style folder browsing with macOS Finder / OneNote-style cascading columns.

## Features

- **Cascading columns** — the vault root is the first column; clicking a folder opens its contents in a new column to the right, infinitely deep, with horizontal scrolling.
- **File opening** — clicking a file opens it in the workspace and trims columns to its right.
- **File operations** — right-click any item (or a column's empty space) for New note, New folder, Rename, and Delete (respects your trash setting). Header buttons create items in the deepest selected folder.
- **Drag & drop** — drop an item onto any folder (or column background) to move it.
- **Live updates** — vault create/delete/rename events refresh only the affected columns and preserve your selection path; externally deleted paths prune back to the deepest valid ancestor.
- **Keyboard navigation** — Arrow Up/Down move within a column, Right descends into a folder, Left returns to the parent column, Enter opens a file or descends into a folder.
- **Theme-aware** — styled entirely with Obsidian CSS variables; matches any theme.

## Development

```sh
npm install
npm run dev    # watch mode
npm run build  # type-check + production bundle to main.js
```

## Manual installation

1. Run `npm run build`.
2. Copy `manifest.json`, `main.js`, and `styles.css` into `<vault>/.obsidian/plugins/miller-columns/`.
3. In Obsidian, open **Settings → Community plugins**, refresh, and enable **Miller Columns**.
4. Open the view via the ribbon icon or the command palette: **Miller Columns: Open**.
