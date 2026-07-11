# Miller Columns

An Obsidian plugin that turns vault structure into cascading pages. Folder-backed pages open like notes, and their direct subpages are embedded automatically.

## Features

- **Cascading pages** — the vault root is the first column; clicking a page with subpages opens its children in a new column to the right.
- **Folder-backed page notes** — selecting a page folder creates/opens `Page/Page.md`, so a page can also contain subpages.
- **Automatic embeds** — each folder-backed page keeps a managed `Subpages` block that embeds its direct markdown subpages.
- **Adjustable columns** — set the column width from the plugin settings.
- **File operations** — right-click any item (or a column's empty space) for New page, New note, Rename, and Delete (respects your trash setting). Header buttons create items in the deepest selected page.
- **Drag & drop** — drop an item onto any page with subpages (or column background) to move it.
- **Live updates** — vault create/delete/rename events refresh only the affected columns and preserve your selection path; externally deleted paths prune back to the deepest valid ancestor.
- **Keyboard navigation** — Arrow Up/Down move within a column, Right descends into a page, Left returns to the parent column, Enter opens the selected page note.
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
