import {
	App,
	ItemView,
	Menu,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TAbstractFile,
	TFile,
	TFolder,
	WorkspaceLeaf,
	addIcon,
	normalizePath,
	setIcon,
} from "obsidian";

export const VIEW_TYPE_MILLER = "miller-columns-view";

const ICON_ID = "miller-columns";
const ICON_SVG =
	'<rect x="10" y="18" width="80" height="64" rx="8" fill="none" stroke="currentColor" stroke-width="8"/>' +
	'<line x1="37" y1="18" x2="37" y2="82" stroke="currentColor" stroke-width="8"/>' +
	'<line x1="63" y1="18" x2="63" y2="82" stroke="currentColor" stroke-width="8"/>';

/** Sentinel meaning "re-render every column" (used for renames, where paths cascade). */
const REFRESH_ALL = "*";
const SUBPAGE_BLOCK_START = "<!-- miller-columns-subpages:start -->";
const SUBPAGE_BLOCK_END = "<!-- miller-columns-subpages:end -->";
const MIN_COLUMN_WIDTH = 64;
const COMPACT_COLUMN_WIDTH = 96;
const MAX_COLUMN_WIDTH = 520;
const MIN_MAX_PANE_COLUMNS = 1;
const MAX_MAX_PANE_COLUMNS = 6;
const DEFAULT_SETTINGS: MillerColumnsSettings = {
	columnWidth: 220,
	columnWidths: [],
	maxPaneColumns: 3,
	appearances: {},
};
const DEFAULT_PAGE_ICON = "file-text";
const ICON_PRESETS = ["file-text", "book-open", "notebook", "library", "folder", "star", "bookmark", "lightbulb", "pen-line"];
const COLOR_PRESETS = ["", "#e06c75", "#d19a66", "#e5c07b", "#98c379", "#56b6c2", "#61afef", "#c678dd"];

function compareNames(a: TAbstractFile, b: TAbstractFile): number {
	return a.name.localeCompare(b.name, undefined, {
		sensitivity: "base",
		numeric: true,
	});
}

function parentPathOf(path: string): string {
	const idx = path.lastIndexOf("/");
	return idx <= 0 ? "/" : path.substring(0, idx);
}

function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

function markdownLinkPath(file: TFile): string {
	return file.path.replace(/\.md$/i, "");
}

function markdownPageLink(file: TFile): string {
	return `[[${markdownLinkPath(file)}|${file.basename}]]`;
}

interface Column {
	folder: TFolder;
	el: HTMLElement;
}

interface MillerColumnsSettings {
	columnWidth: number;
	columnWidths: Array<number | null>;
	maxPaneColumns: number;
	appearances: Record<string, PageAppearance>;
}

interface PageAppearance {
	icon?: string;
	color?: string;
}

class MillerColumnsView extends ItemView {
	/** selection[i] is the selected item in column i; only the last entry may be a file. */
	private selection: TAbstractFile[] = [];
	private activeColumn = 0;
	private columns: Column[] = [];
	private columnsEl: HTMLElement;
	private pageLeaf: WorkspaceLeaf | null = null;
	private millerPaneWidth: number | null = null;
	private affected = new Set<string>();
	private refreshQueued = false;

	constructor(leaf: WorkspaceLeaf, private readonly plugin: MillerColumnsPlugin) {
		super(leaf);
		this.navigation = false;
	}

	getViewType(): string {
		return VIEW_TYPE_MILLER;
	}

	getDisplayText(): string {
		return "Miller Columns";
	}

	getIcon(): string {
		return ICON_ID;
	}

	async onOpen(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("miller-columns");
		this.applySettings();

		this.columnsEl = contentEl.createDiv({ cls: "mc-columns" });
		this.columnsEl.setAttr("tabindex", "0");
		this.columnsEl.addEventListener("keydown", (e) => this.onKeyDown(e));

		this.registerEvent(
			this.app.vault.on("create", (f) => this.queueRefresh(this.parentsOf(f.path)))
		);
		this.registerEvent(
			this.app.vault.on("delete", (f) => this.queueRefresh(this.parentsOf(f.path)))
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				void this.plugin.moveAppearance(oldPath, file.path);
				this.queueRefresh([REFRESH_ALL]);
			})
		);
		this.registerEvent(
			this.app.workspace.on("resize", () => {
				this.enforceMillerPaneMaxWidth();
				this.rememberMillerPaneWidth();
			})
		);

		this.buildColumnsFrom(0);
	}

	async onClose(): Promise<void> {
		this.columns = [];
		this.contentEl.empty();
	}

	applySettings(): void {
		this.contentEl.style.setProperty(
			"--mc-column-width",
			`${this.plugin.settings.columnWidth}px`
		);
		this.columns.forEach((col, i) => this.applyColumnWidth(col.el, i));
		this.enforceMillerPaneMaxWidth();
	}

	// ---------------------------------------------------------------- columns

	/** Number of columns implied by the current selection (root + one per selected folder). */
	private columnCount(): number {
		let n = 1;
		for (const item of this.selection) {
			if (item instanceof TFolder) n++;
			else break;
		}
		return n;
	}

	private folderForColumn(i: number): TFolder | null {
		if (i === 0) return this.app.vault.getRoot();
		const sel = this.selection[i - 1];
		return sel instanceof TFolder ? sel : null;
	}

	private folderPagePath(folder: TFolder): string | null {
		if (folder.isRoot()) return null;
		return normalizePath(`${folder.path}/${folder.name}.md`);
	}

	private isFolderPage(folder: TFolder, item: TAbstractFile): boolean {
		const pagePath = this.folderPagePath(folder);
		return pagePath !== null && item instanceof TFile && item.path === pagePath;
	}

	private visibleChildren(folder: TFolder): TAbstractFile[] {
		const configDir = this.app.vault.configDir;
		return folder.children.filter((c) => c.path !== configDir && !this.isFolderPage(folder, c));
	}

	private itemsForColumn(i: number): TAbstractFile[] {
		const col = this.columns[i];
		if (!col) return [];
		const children = this.visibleChildren(col.folder);
		const folders = children.filter((c) => c instanceof TFolder).sort(compareNames);
		const files = children.filter((c) => c instanceof TFile).sort(compareNames);
		return [...folders, ...files];
	}

	/** Remove columns from `index` on, then (re)create every column the selection implies. */
	private buildColumnsFrom(index: number, scroll = true): void {
		for (const col of this.columns.splice(index)) col.el.detach();
		const total = this.columnCount();
		for (let i = this.columns.length; i < total; i++) {
			const folder = this.folderForColumn(i);
			if (!folder) break;
			const el = this.columnsEl.createDiv({ cls: "mc-column" });
			this.columns.push({ folder, el });
			this.applyColumnWidth(el, i);
			this.attachColumnHandlers(el, i);
			this.renderColumn(i);
		}
		this.updateSelectionClasses();
		if (scroll) this.scrollToNewestColumn();
	}

	private renderColumn(i: number): void {
		const col = this.columns[i];
		if (!col) return;
		col.el.empty();
		const items = this.itemsForColumn(i);
		if (items.length === 0) {
			col.el.createDiv({ cls: "mc-empty", text: "No pages. Right-click to create one." });
			this.renderResizeHandle(col.el, i);
			return;
		}
		for (const item of items) this.renderRow(col.el, i, item);
		this.renderResizeHandle(col.el, i);
	}

	private applyColumnWidth(el: HTMLElement, index: number): void {
		const width = this.plugin.columnWidthFor(index);
		el.style.setProperty("--mc-column-width", `${width}px`);
		el.toggleClass("is-narrow", width < COMPACT_COLUMN_WIDTH);
	}

	private renderResizeHandle(colEl: HTMLElement, colIndex: number): void {
		const handle = colEl.createDiv({ cls: "mc-resize-handle" });
		handle.setAttr("aria-label", "Resize column");
		handle.addEventListener("pointerdown", (e) => {
			e.preventDefault();
			e.stopPropagation();
			const startX = e.clientX;
			const startWidth = this.plugin.columnWidthFor(colIndex);
			handle.addClass("is-resizing");
			const onMove = (moveEvent: PointerEvent) => {
				const width = this.plugin.setColumnWidth(
					colIndex,
					startWidth + moveEvent.clientX - startX
				);
				this.applyColumnWidth(colEl, colIndex);
				colEl.style.setProperty("--mc-column-width", `${width}px`);
			};
			const onUp = () => {
				handle.removeClass("is-resizing");
				window.removeEventListener("pointermove", onMove);
				window.removeEventListener("pointerup", onUp);
				void this.plugin.saveSettings();
			};
			window.addEventListener("pointermove", onMove);
			window.addEventListener("pointerup", onUp);
		});
		handle.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
		});
		handle.addEventListener("dblclick", async (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.plugin.resetColumnWidth(colIndex);
			this.applyColumnWidth(colEl, colIndex);
			await this.plugin.saveSettings();
		});
	}

	private renderRow(colEl: HTMLElement, colIndex: number, item: TAbstractFile): void {
		const row = colEl.createDiv({ cls: "mc-item" });
		row.dataset.path = item.path;
		row.setAttr("draggable", "true");

		const iconEl = row.createSpan({ cls: "mc-icon" });
		const appearance = this.plugin.appearanceFor(item.path);
		setIcon(iconEl, appearance.icon ?? DEFAULT_PAGE_ICON);
		if (appearance.color) iconEl.style.color = appearance.color;

		const displayName =
			item instanceof TFile && item.extension === "md" ? item.basename : item.name;
		row.createSpan({ cls: "mc-name", text: displayName });

		if (item instanceof TFolder) {
			row.createSpan({ cls: "mc-chevron", text: "›" });
		}

		row.addEventListener("click", () => {
			this.columnsEl.focus({ preventScroll: true });
			this.selectItem(colIndex, item);
		});
		row.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.showItemMenu(e, item);
		});
		row.addEventListener("dragstart", (e) => {
			if (!e.dataTransfer) return;
			e.dataTransfer.setData("text/plain", item.path);
			e.dataTransfer.effectAllowed = "move";
		});
		if (item instanceof TFolder) {
			this.addDropHandlers(row, () => item);
		}
	}

	private attachColumnHandlers(el: HTMLElement, index: number): void {
		el.addEventListener("contextmenu", (e) => {
			if ((e.target as HTMLElement).closest(".mc-item")) return;
			e.preventDefault();
			const col = this.columns[index];
			if (col) this.showFolderMenu(e, col.folder);
		});
		this.addDropHandlers(el, () => this.columns[index]?.folder ?? null);
	}

	private updateSelectionClasses(): void {
		const tipIndex = this.selection.length - 1;
		this.columns.forEach((col, i) => {
			const selPath = this.selection[i] ? this.selection[i].path : null;
			col.el.querySelectorAll<HTMLElement>(".mc-item").forEach((row) => {
				const selected = selPath !== null && row.dataset.path === selPath;
				row.classList.toggle("is-selected", selected);
				row.classList.toggle("is-active", selected && i === tipIndex);
			});
		});
	}

	private scrollToNewestColumn(): void {
		window.requestAnimationFrame(() => {
			this.columnsEl.scrollLeft = this.columnsEl.scrollWidth;
		});
	}

	private scrollRowIntoView(colIndex: number, path: string): void {
		const col = this.columns[colIndex];
		if (!col) return;
		const rows = Array.from(col.el.querySelectorAll<HTMLElement>(".mc-item"));
		for (const row of rows) {
			if (row.dataset.path === path) {
				row.scrollIntoView({ block: "nearest" });
				return;
			}
		}
	}

	// -------------------------------------------------------------- selection

	private selectItem(colIndex: number, item: TAbstractFile, openFile = true): void {
		this.selection = this.selection.slice(0, colIndex);
		this.selection[colIndex] = item;
		this.activeColumn = colIndex;
		this.buildColumnsFrom(colIndex + 1);
		this.scrollRowIntoView(colIndex, item.path);
		if (openFile && item instanceof TFile) {
			void this.openPageFile(item);
		} else if (openFile && item instanceof TFolder) {
			void this.openFolderPage(item);
		}
	}

	/** Select the full ancestor chain of `item` and rebuild all columns around it. */
	private revealPath(item: TAbstractFile): void {
		const chain: TAbstractFile[] = [];
		let cur: TAbstractFile | null = item;
		while (cur && cur.parent) {
			chain.unshift(cur);
			cur = cur.parent;
		}
		this.selection = chain;
		this.activeColumn = Math.max(0, chain.length - 1);
		this.buildColumnsFrom(0);
		if (chain.length > 0) this.scrollRowIntoView(chain.length - 1, item.path);
	}

	// --------------------------------------------------------------- keyboard

	private onKeyDown(e: KeyboardEvent): void {
		if (this.columns.length === 0) return;
		const col = Math.min(this.activeColumn, this.columns.length - 1);
		this.activeColumn = col;
		const items = this.itemsForColumn(col);
		const current = this.selection[col];
		const idx = current ? items.indexOf(current) : -1;

		switch (e.key) {
			case "ArrowDown": {
				if (items.length === 0) break;
				const next = items[Math.min(items.length - 1, idx + 1)];
				this.selectItem(col, next, false);
				break;
			}
			case "ArrowUp": {
				if (items.length === 0) break;
				const next = items[idx === -1 ? items.length - 1 : Math.max(0, idx - 1)];
				this.selectItem(col, next, false);
				break;
			}
			case "ArrowLeft": {
				if (col > 0) this.activeColumn = col - 1;
				break;
			}
			case "ArrowRight": {
				this.descendIntoSelectedFolder(col);
				break;
			}
			case "Enter": {
				const sel = this.selection[col];
				if (sel instanceof TFile) {
					void this.openPageFile(sel);
				} else if (sel instanceof TFolder) {
					void this.openFolderPage(sel);
				}
				break;
			}
			default:
				return;
		}
		e.preventDefault();
	}

	private descendIntoSelectedFolder(col: number): void {
		const sel = this.selection[col];
		if (!(sel instanceof TFolder) || this.columns.length <= col + 1) return;
		this.activeColumn = col + 1;
		if (!this.selection[col + 1]) {
			const childItems = this.itemsForColumn(col + 1);
			if (childItems.length > 0) this.selectItem(col + 1, childItems[0], false);
		}
	}

	// ------------------------------------------------------------ live update

	private parentsOf(path: string): string[] {
		const parent = parentPathOf(path);
		// The grandparent column may need to refresh its child-folder row.
		return [parent, parentPathOf(parent)];
	}

	private queueRefresh(paths: string[]): void {
		for (const p of paths) this.affected.add(p);
		if (this.refreshQueued) return;
		this.refreshQueued = true;
		window.setTimeout(() => {
			this.refreshQueued = false;
			const affected = this.affected;
			this.affected = new Set();
			this.refresh(affected);
		}, 0);
	}

	private refresh(affected: Set<string>): void {
		// Prune the selection back to the deepest entry that still exists in place.
		let valid = 0;
		while (valid < this.selection.length) {
			const item = this.selection[valid];
			if (this.app.vault.getAbstractFileByPath(item.path) !== item) break;
			if (item.parent !== this.folderForColumn(valid)) break;
			valid++;
		}
		if (valid < this.selection.length) this.selection.length = valid;
		this.activeColumn = Math.min(this.activeColumn, this.columnCount() - 1);

		// Drop columns the (possibly pruned) selection no longer supports.
		this.buildColumnsFrom(this.columnCount(), false);

		const all = affected.has(REFRESH_ALL);
		this.columns.forEach((col, i) => {
			if (all || affected.has(col.folder.path)) {
				this.renderColumn(i);
				void this.syncFolderPage(col.folder);
			}
		});
		this.updateSelectionClasses();
	}

	// ---------------------------------------------------------- page content

	private async openFolderPage(folder: TFolder): Promise<void> {
		try {
			const page = await this.ensureFolderPage(folder);
			if (!page) return;
			await this.syncFolderPage(folder, page);
			if (folder.parent) await this.syncFolderPage(folder.parent);
			await this.openPageFile(page);
		} catch (e) {
			new Notice("Could not open page: " + errorMessage(e));
		}
	}

	private async openPageFile(file: TFile): Promise<void> {
		const hadPageLeaf = this.pageLeaf !== null && this.isLeafAttached(this.pageLeaf);
		if (!hadPageLeaf) this.enforceMillerPaneMaxWidth();
		const leaf = this.rightPageLeaf();
		if (!hadPageLeaf) this.restoreMillerPaneWidth();
		await leaf.openFile(file, { state: { mode: "preview" } });
		this.app.workspace.setActiveLeaf(leaf, { focus: true });
		this.rememberMillerPaneWidthSoon();
	}

	private rightPageLeaf(): WorkspaceLeaf {
		if (this.pageLeaf && this.isLeafAttached(this.pageLeaf)) return this.pageLeaf;
		this.app.workspace.setActiveLeaf(this.leaf, { focus: false });
		this.pageLeaf = this.app.workspace.getLeaf("split", "vertical");
		return this.pageLeaf;
	}

	private millerPaneEl(): HTMLElement | null {
		return (
			this.containerEl.closest<HTMLElement>(".workspace-tabs") ??
			this.containerEl.closest<HTMLElement>(".workspace-leaf")
		);
	}

	private rememberMillerPaneWidth(): void {
		if (!this.pageLeaf || !this.isLeafAttached(this.pageLeaf)) return;
		const width = this.millerPaneEl()?.getBoundingClientRect().width;
		if (width && Number.isFinite(width)) {
			this.millerPaneWidth = Math.min(Math.round(width), this.plugin.maxMillerPaneWidth());
		}
	}

	private rememberMillerPaneWidthSoon(): void {
		window.requestAnimationFrame(() => this.rememberMillerPaneWidth());
	}

	private restoreMillerPaneWidth(): void {
		const width = Math.min(
			this.millerPaneWidth ?? this.plugin.maxMillerPaneWidth(),
			this.plugin.maxMillerPaneWidth()
		);
		if (!width) return;
		window.requestAnimationFrame(() => {
			const el = this.millerPaneEl();
			if (!el) return;
			el.style.width = `${width}px`;
			el.style.flexBasis = `${width}px`;
		});
	}

	private enforceMillerPaneMaxWidth(): void {
		const el = this.millerPaneEl();
		if (!el) return;
		const maxWidth = this.plugin.maxMillerPaneWidth();
		const currentWidth = el.getBoundingClientRect().width;
		if (currentWidth > maxWidth) {
			el.style.width = `${maxWidth}px`;
			el.style.flexBasis = `${maxWidth}px`;
		}
	}

	private isLeafAttached(target: WorkspaceLeaf): boolean {
		let found = false;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf === target) found = true;
		});
		return found;
	}

	private async ensureFolderPage(folder: TFolder): Promise<TFile | null> {
		const path = this.folderPagePath(folder);
		if (!path) return null;
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) return existing;
		if (existing) {
			new Notice(`Could not create page because ${path} already exists.`);
			return null;
		}
		return await this.app.vault.create(path, this.subpageBlock(folder));
	}

	private async syncFolderPage(folder: TFolder, knownPage?: TFile | null): Promise<void> {
		if (folder.isRoot()) return;
		try {
			const page = knownPage ?? (await this.ensureFolderPage(folder));
			if (!page) return;
			const block = this.subpageBlock(folder);
			const raw = await this.app.vault.read(page);
			const current = this.stripGeneratedTitle(raw, folder);
			const next = this.replaceSubpageBlock(current, block);
			if (next !== raw) await this.app.vault.modify(page, next);
		} catch (e) {
			new Notice("Could not update subpage links: " + errorMessage(e));
		}
	}

	private subpageBlock(folder: TFolder): string {
		const links = this.subpageFiles(folder).map((file) => `- ${markdownPageLink(file)}`);
		const body = links.length > 0 ? `${links.join("\n")}\n` : "";
		return `${SUBPAGE_BLOCK_START}\n${body}${SUBPAGE_BLOCK_END}`;
	}

	private subpageFiles(folder: TFolder): TFile[] {
		const files: TFile[] = [];
		for (const child of this.visibleChildren(folder)) {
			if (child instanceof TFile && child.extension === "md") {
				files.push(child);
			}
			if (child instanceof TFolder) {
				const pagePath = this.folderPagePath(child);
				const page = pagePath ? this.app.vault.getAbstractFileByPath(pagePath) : null;
				if (page instanceof TFile) files.push(page);
			}
		}
		return files.sort(compareNames);
	}

	private replaceSubpageBlock(content: string, block: string): string {
		const start = content.indexOf(SUBPAGE_BLOCK_START);
		const end = content.indexOf(SUBPAGE_BLOCK_END);
		if (start >= 0 && end >= start) {
			const afterEnd = end + SUBPAGE_BLOCK_END.length;
			return content.substring(0, start) + block + content.substring(afterEnd);
		}
		const trimmed = content.trimEnd();
		return `${trimmed}${trimmed ? "\n\n" : ""}${block}`;
	}

	private stripGeneratedTitle(content: string, folder: TFolder): string {
		const heading = `# ${folder.name}`;
		const trimmedStart = content.trimStart();
		if (trimmedStart !== heading && !trimmedStart.startsWith(`${heading}\n`)) return content;
		const leadingWhitespaceLength = content.length - trimmedStart.length;
		const afterHeading = trimmedStart.substring(heading.length);
		if (!/^\s*\n\s*\n?<!-- miller-columns-subpages:start -->/.test(afterHeading)) {
			return content;
		}
		return content.substring(0, leadingWhitespaceLength) + afterHeading.trimStart();
	}

	// ---------------------------------------------------------- file actions

	private showItemMenu(e: MouseEvent, item: TAbstractFile): void {
		const targetFolder =
			item instanceof TFolder ? item : item.parent ?? this.app.vault.getRoot();
		const menu = new Menu();
		menu.addItem((mi) =>
			mi.setTitle("New page").setIcon("file-plus").onClick(() => this.createPage(targetFolder))
		);
		menu.addSeparator();
		menu.addItem((mi) =>
			mi
				.setTitle("Icon and color")
				.setIcon("palette")
				.onClick(() => new AppearanceModal(this.app, this.plugin, item, () => this.refreshPath(item)).open())
		);
		menu.addSeparator();
		menu.addItem((mi) =>
			mi.setTitle("Rename").setIcon("pencil").onClick(() => new RenameModal(this.app, item).open())
		);
		menu.addSeparator();
		menu.addItem((mi) =>
			mi.setTitle("Delete").setIcon("trash").onClick(async () => {
				try {
					await this.app.fileManager.trashFile(item);
				} catch (err) {
					new Notice("Could not delete: " + errorMessage(err));
				}
			})
		);
		menu.showAtMouseEvent(e);
	}

	private refreshPath(item: TAbstractFile): void {
		const parent = item.parent ?? this.app.vault.getRoot();
		this.queueRefresh([parent.path]);
	}

	private showFolderMenu(e: MouseEvent, folder: TFolder): void {
		const menu = new Menu();
		menu.addItem((mi) =>
			mi.setTitle("New page").setIcon("file-plus").onClick(() => this.createPage(folder))
		);
		menu.showAtMouseEvent(e);
	}

	private uniquePath(folder: TFolder, base: string, ext: string): string {
		const prefix = folder.isRoot() ? "" : folder.path + "/";
		let candidate = base;
		let n = 1;
		while (this.app.vault.getAbstractFileByPath(normalizePath(prefix + candidate + ext))) {
			candidate = `${base} ${n++}`;
		}
		return normalizePath(prefix + candidate + ext);
	}

	private async createPage(parent: TFolder): Promise<void> {
		try {
			const path = this.uniquePath(parent, "Untitled", "");
			const folder = await this.app.vault.createFolder(path);
			const page = await this.ensureFolderPage(folder);
			if (page) await this.syncFolderPage(folder, page);
			await this.syncFolderPage(parent);
			this.revealPath(folder);
			if (page) await this.openPageFile(page);
		} catch (e) {
			new Notice("Could not create page: " + errorMessage(e));
		}
	}

	// ------------------------------------------------------------ drag & drop

	private addDropHandlers(el: HTMLElement, getFolder: () => TFolder | null): void {
		el.addEventListener("dragover", (e) => {
			if (!e.dataTransfer || !e.dataTransfer.types.includes("text/plain")) return;
			e.preventDefault();
			e.stopPropagation();
			e.dataTransfer.dropEffect = "move";
			el.addClass("mc-drop-target");
		});
		el.addEventListener("dragleave", () => el.removeClass("mc-drop-target"));
		el.addEventListener("drop", (e) => {
			el.removeClass("mc-drop-target");
			const path = e.dataTransfer?.getData("text/plain");
			if (!path) return;
			e.preventDefault();
			e.stopPropagation();
			const src = this.app.vault.getAbstractFileByPath(path);
			const target = getFolder();
			if (src && target) void this.moveInto(src, target);
		});
	}

	private async moveInto(src: TAbstractFile, target: TFolder): Promise<void> {
		if (src === target || src.parent === target) return;
		if (src instanceof TFolder && (target === src || target.path.startsWith(src.path + "/"))) {
			new Notice("Cannot move a folder into itself.");
			return;
		}
		const dest = normalizePath((target.isRoot() ? "" : target.path + "/") + src.name);
		if (this.app.vault.getAbstractFileByPath(dest)) {
			new Notice("An item with that name already exists there.");
			return;
		}
		try {
			await this.app.fileManager.renameFile(src, dest);
		} catch (e) {
			new Notice("Could not move: " + errorMessage(e));
		}
	}
}

class RenameModal extends Modal {
	constructor(app: App, private readonly item: TAbstractFile) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("Rename page");
		const input = this.contentEl.createEl("input", {
			cls: "mc-rename-input",
			type: "text",
			value: this.item.name,
		});
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				void this.submit(input.value);
			}
		});
		new Setting(this.contentEl).addButton((btn) =>
			btn.setButtonText("Rename").setCta().onClick(() => void this.submit(input.value))
		);
		input.focus();
		if (this.item instanceof TFile && this.item.extension) {
			input.setSelectionRange(0, Math.max(0, this.item.name.length - this.item.extension.length - 1));
		} else {
			input.select();
		}
	}

	private async submit(name: string): Promise<void> {
		name = name.trim();
		if (!name || name.includes("/") || name.includes("\\")) {
			new Notice("Invalid name.");
			return;
		}
		const parent = this.item.parent;
		const prefix = parent && !parent.isRoot() ? parent.path + "/" : "";
		const oldName = this.item.name;
		const destination = normalizePath(prefix + name);
		try {
			await this.app.fileManager.renameFile(this.item, destination);
			if (this.item instanceof TFolder) {
				await this.renameCompanionPage(destination, oldName, name);
			}
			this.close();
		} catch (e) {
			new Notice("Rename failed: " + errorMessage(e));
		}
	}

	private async renameCompanionPage(
		folderPath: string,
		oldFolderName: string,
		newFolderName: string
	): Promise<void> {
		const oldPagePath = normalizePath(`${folderPath}/${oldFolderName}.md`);
		const newPagePath = normalizePath(`${folderPath}/${newFolderName}.md`);
		if (oldPagePath === newPagePath) return;
		const oldPage = this.app.vault.getAbstractFileByPath(oldPagePath);
		if (!(oldPage instanceof TFile)) return;
		if (this.app.vault.getAbstractFileByPath(newPagePath)) return;
		await this.app.fileManager.renameFile(oldPage, newPagePath);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class AppearanceModal extends Modal {
	private icon = "";
	private color = "";
	private previewEl: HTMLElement;

	constructor(
		app: App,
		private readonly plugin: MillerColumnsPlugin,
		private readonly item: TAbstractFile,
		private readonly onChange: () => void
	) {
		super(app);
		const appearance = plugin.appearanceFor(item.path);
		this.icon = appearance.icon ?? DEFAULT_PAGE_ICON;
		this.color = appearance.color ?? "";
	}

	onOpen(): void {
		this.titleEl.setText("Icon and color");
		this.contentEl.addClass("mc-appearance-modal");

		const preview = this.contentEl.createDiv({ cls: "mc-appearance-preview" });
		this.previewEl = preview.createSpan({ cls: "mc-appearance-preview-icon" });
		preview.createSpan({ text: this.item.name });
		this.renderPreview();

		new Setting(this.contentEl)
			.setName("Icon")
			.setDesc("Use a Lucide icon name, such as notebook, book-open, star, or bookmark.")
			.addText((text) =>
				text.setValue(this.icon).onChange((value) => {
					this.icon = value.trim();
					this.renderPreview();
				})
			);

		const iconGrid = this.contentEl.createDiv({ cls: "mc-picker-grid" });
		for (const icon of ICON_PRESETS) {
			const btn = iconGrid.createEl("button", { cls: "mc-icon-choice", attr: { type: "button" } });
			const iconEl = btn.createSpan();
			setIcon(iconEl, icon);
			btn.setAttr("aria-label", icon);
			btn.addEventListener("click", () => {
				this.icon = icon;
				this.display();
			});
		}

		new Setting(this.contentEl)
			.setName("Color")
			.setDesc("Choose a preset or enter any CSS color.")
			.addText((text) =>
				text.setPlaceholder("default, #61afef, var(--text-accent)")
					.setValue(this.color)
					.onChange((value) => {
						this.color = value.trim();
						this.renderPreview();
					})
			);

		const colorGrid = this.contentEl.createDiv({ cls: "mc-picker-grid" });
		for (const color of COLOR_PRESETS) {
			const btn = colorGrid.createEl("button", { cls: "mc-color-choice", attr: { type: "button" } });
			btn.setAttr("aria-label", color || "Default color");
			if (color) btn.style.backgroundColor = color;
			btn.addEventListener("click", () => {
				this.color = color;
				this.display();
			});
		}

		new Setting(this.contentEl)
			.addButton((btn) =>
				btn.setButtonText("Reset").onClick(async () => {
					delete this.plugin.settings.appearances[this.item.path];
					await this.plugin.saveSettings();
					this.onChange();
					this.close();
				})
			)
			.addButton((btn) =>
				btn.setButtonText("Save").setCta().onClick(async () => {
					this.plugin.setAppearance(this.item.path, {
						icon: this.icon || DEFAULT_PAGE_ICON,
						color: this.color || undefined,
					});
					await this.plugin.saveSettings();
					this.onChange();
					this.close();
				})
			);
	}

	private display(): void {
		this.contentEl.empty();
		this.onOpen();
	}

	private renderPreview(): void {
		if (!this.previewEl) return;
		this.previewEl.empty();
		setIcon(this.previewEl, this.icon || DEFAULT_PAGE_ICON);
		this.previewEl.style.color = this.color;
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export default class MillerColumnsPlugin extends Plugin {
	settings: MillerColumnsSettings;

	async onload(): Promise<void> {
		await this.loadSettings();
		addIcon(ICON_ID, ICON_SVG);
		this.registerView(VIEW_TYPE_MILLER, (leaf) => new MillerColumnsView(leaf, this));
		this.addSettingTab(new MillerColumnsSettingTab(this.app, this));
		this.addRibbonIcon(ICON_ID, "Open Miller Columns", () => void this.activateView());
		this.addCommand({
			id: "open",
			name: "Open",
			callback: () => void this.activateView(),
		});
	}

	async loadSettings(): Promise<void> {
		const loaded = (await this.loadData()) as Partial<MillerColumnsSettings> | null;
		this.settings = {
			...DEFAULT_SETTINGS,
			...loaded,
			columnWidths: Array.isArray(loaded?.columnWidths) ? loaded.columnWidths : [],
			appearances: loaded?.appearances && typeof loaded.appearances === "object" ? loaded.appearances : {},
		};
		this.settings.columnWidth = this.clampColumnWidth(this.settings.columnWidth);
		this.settings.columnWidths = this.settings.columnWidths.map((width) =>
			typeof width === "number" ? this.clampColumnWidth(width) : null
		);
		this.settings.maxPaneColumns = this.clampMaxPaneColumns(this.settings.maxPaneColumns);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_MILLER)) {
			const view = leaf.view;
			if (view instanceof MillerColumnsView) view.applySettings();
		}
	}

	columnWidthFor(index: number): number {
		const width = this.settings.columnWidths[index];
		return typeof width === "number" ? width : this.settings.columnWidth;
	}

	setColumnWidth(index: number, width: number): number {
		const next = this.clampColumnWidth(width);
		this.settings.columnWidths[index] = next;
		return next;
	}

	resetColumnWidth(index: number): void {
		this.settings.columnWidths[index] = null;
	}

	maxMillerPaneWidth(): number {
		return this.settings.columnWidth * this.settings.maxPaneColumns;
	}

	appearanceFor(path: string): PageAppearance {
		return this.settings.appearances[path] ?? {};
	}

	setAppearance(path: string, appearance: PageAppearance): void {
		this.settings.appearances[path] = appearance;
	}

	async moveAppearance(oldPath: string, newPath: string): Promise<void> {
		let changed = false;
		const next: Record<string, PageAppearance> = {};
		for (const [path, appearance] of Object.entries(this.settings.appearances)) {
			let targetPath = path;
			if (path === oldPath) {
				targetPath = newPath;
			} else if (path.startsWith(oldPath + "/")) {
				targetPath = newPath + path.substring(oldPath.length);
			}
			if (targetPath !== path) changed = true;
			next[targetPath] = appearance;
		}
		if (!changed) return;
		this.settings.appearances = next;
		await this.saveSettings();
	}

	private clampColumnWidth(width: number): number {
		if (!Number.isFinite(width)) return DEFAULT_SETTINGS.columnWidth;
		return Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, Math.round(width)));
	}

	private clampMaxPaneColumns(columns: number): number {
		if (!Number.isFinite(columns)) return DEFAULT_SETTINGS.maxPaneColumns;
		return Math.min(
			MAX_MAX_PANE_COLUMNS,
			Math.max(MIN_MAX_PANE_COLUMNS, Math.round(columns))
		);
	}

	private async activateView(): Promise<void> {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(VIEW_TYPE_MILLER)[0] ?? null;
		if (!leaf) {
			leaf = workspace.getLeaf(true);
			await leaf.setViewState({ type: VIEW_TYPE_MILLER, active: true });
		}
		await workspace.revealLeaf(leaf);
	}
}

class MillerColumnsSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: MillerColumnsPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Default column width")
			.setDesc("Width in pixels for columns that have not been resized.")
			.addSlider((slider) =>
				slider
					.setLimits(MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH, 10)
					.setValue(this.plugin.settings.columnWidth)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.columnWidth = value;
						await this.plugin.saveSettings();
					})
			)
			.addExtraButton((button) =>
				button
					.setIcon("reset")
					.setTooltip("Reset to default")
					.onClick(async () => {
						this.plugin.settings.columnWidth = DEFAULT_SETTINGS.columnWidth;
						await this.plugin.saveSettings();
						this.display();
					})
			);

		new Setting(containerEl)
			.setName("Individual column widths")
			.setDesc("Drag the right edge of any column to resize that column depth. Double-click the edge to reset it.")
			.addButton((button) =>
				button.setButtonText("Reset all").onClick(async () => {
					this.plugin.settings.columnWidths = [];
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Maximum Miller pane width")
			.setDesc("Limits the workspace pane to this many default-width columns when a page pane is opened.")
			.addSlider((slider) =>
				slider
					.setLimits(MIN_MAX_PANE_COLUMNS, MAX_MAX_PANE_COLUMNS, 1)
					.setValue(this.plugin.settings.maxPaneColumns)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.maxPaneColumns = value;
						await this.plugin.saveSettings();
					})
			)
			.addExtraButton((button) =>
				button
					.setIcon("reset")
					.setTooltip("Reset to default")
					.onClick(async () => {
						this.plugin.settings.maxPaneColumns = DEFAULT_SETTINGS.maxPaneColumns;
						await this.plugin.saveSettings();
						this.display();
					})
			);
	}
}
