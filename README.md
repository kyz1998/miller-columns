# Miller Columns

An Obsidian plugin that turns vault structure into cascading pages. Pages can contain child pages, and each parent page keeps a simple linked list of its direct children.

## Features

- **Cascading pages** — the vault root is the first column; clicking a page with subpages opens its children in a new column to the right.
- **Unified pages** — selecting a page with children creates/opens `Page/Page.md`, so pages and notes behave as one concept.
- **Automatic child links** — each parent page keeps a managed block of direct child page titles, linked without embedding their contents.
- **Adjustable columns** — drag a column's right edge to resize that column depth, or set the default width from plugin settings.
- **Page operations** — right-click any item (or a column's empty space) for New page, Rename, and Delete (respects your trash setting). The header button creates a page in the deepest selected page.
- **Drag & drop** — drop an item onto any page with subpages (or column background) to move it.
- **Live updates** — vault create/delete/rename events refresh only the affected columns and preserve your selection path; externally deleted paths prune back to the deepest valid ancestor.
- **Keyboard navigation** — Arrow Up/Down move within a column, Right descends into a page, Left returns to the parent column, Enter opens the selected page.
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
