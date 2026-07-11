import {
	App,
	ItemView,
	Menu,
	Modal,
	Notice,
	Plugin,
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

interface Column {
	folder: TFolder;
	el: HTMLElement;
}

class MillerColumnsView extends ItemView {
	/** selection[i] is the selected item in column i; only the last entry may be a file. */
	private selection: TAbstractFile[] = [];
	private activeColumn = 0;
	private columns: Column[] = [];
	private columnsEl: HTMLElement;
	private affected = new Set<string>();
	private refreshQueued = false;

	constructor(leaf: WorkspaceLeaf) {
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

		const header = contentEl.createDiv({ cls: "mc-header" });
		this.makeHeaderButton(header, "file-plus", "New page", () =>
			this.createPage(this.deepestSelectedFolder())
		);
		this.makeHeaderButton(header, "file-plus-2", "New note", () =>
			this.createNote(this.deepestSelectedFolder())
		);

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
			this.app.vault.on("rename", () => this.queueRefresh([REFRESH_ALL]))
		);

		this.buildColumnsFrom(0);
	}

	async onClose(): Promise<void> {
		this.columns = [];
		this.contentEl.empty();
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
			return;
		}
		for (const item of items) this.renderRow(col.el, i, item);
	}

	private renderRow(colEl: HTMLElement, colIndex: number, item: TAbstractFile): void {
		const row = colEl.createDiv({ cls: "mc-item" });
		row.dataset.path = item.path;
		row.setAttr("draggable", "true");

		const iconEl = row.createSpan({ cls: "mc-icon" });
		setIcon(iconEl, "file-text");

		const displayName =
			item instanceof TFile && item.extension === "md" ? item.basename : item.name;
		row.createSpan({ cls: "mc-name", text: displayName });

		if (item instanceof TFolder) {
			row.createSpan({
				cls: "mc-count",
				text: String(this.visibleChildren(item).length),
			});
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
			void this.app.workspace.getLeaf(false).openFile(item);
		} else if (openFile && item instanceof TFolder) {
			void this.openFolderPage(item);
		}
	}

	private deepestSelectedFolder(): TFolder {
		let target: TFolder = this.app.vault.getRoot();
		for (const item of this.selection) {
			if (item instanceof TFolder) target = item;
			else break;
		}
		return target;
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
					void this.app.workspace.getLeaf(false).openFile(sel);
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
		// The grandparent column shows the parent's item-count badge, so refresh it too.
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
			await this.app.workspace.getLeaf(false).openFile(page);
		} catch (e) {
			new Notice("Could not open page: " + errorMessage(e));
		}
	}

	private async ensureFolderPage(folder: TFolder): Promise<TFile | null> {
		const path = this.folderPagePath(folder);
		if (!path) return null;
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) return existing;
		if (existing) {
			new Notice(`Could not create page note because ${path} already exists.`);
			return null;
		}
		return await this.app.vault.create(path, `# ${folder.name}\n\n${this.subpageBlock(folder)}`);
	}

	private async syncFolderPage(folder: TFolder, knownPage?: TFile | null): Promise<void> {
		if (folder.isRoot()) return;
		try {
			const page = knownPage ?? (await this.ensureFolderPage(folder));
			if (!page) return;
			const block = this.subpageBlock(folder);
			const current = await this.app.vault.read(page);
			const next = this.replaceSubpageBlock(current, block);
			if (next !== current) await this.app.vault.modify(page, next);
		} catch (e) {
			new Notice("Could not update subpage embeds: " + errorMessage(e));
		}
	}

	private subpageBlock(folder: TFolder): string {
		const embeds = this.subpageFiles(folder).map((file) => `![[${markdownLinkPath(file)}]]`);
		const body = embeds.length > 0 ? embeds.join("\n\n") : "_No subpages yet._";
		return `${SUBPAGE_BLOCK_START}\n## Subpages\n\n${body}\n${SUBPAGE_BLOCK_END}`;
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

	// ---------------------------------------------------------- file actions

	private makeHeaderButton(
		parent: HTMLElement,
		icon: string,
		label: string,
		onClick: () => void
	): void {
		const btn = parent.createEl("button", { cls: "mc-btn" });
		const iconEl = btn.createSpan({ cls: "mc-btn-icon" });
		setIcon(iconEl, icon);
		btn.createSpan({ text: label });
		btn.addEventListener("click", onClick);
	}

	private showItemMenu(e: MouseEvent, item: TAbstractFile): void {
		const targetFolder =
			item instanceof TFolder ? item : item.parent ?? this.app.vault.getRoot();
		const menu = new Menu();
		menu.addItem((mi) =>
			mi.setTitle("New page").setIcon("file-plus").onClick(() => this.createPage(targetFolder))
		);
		menu.addItem((mi) =>
			mi.setTitle("New note").setIcon("file-plus-2").onClick(() => this.createNote(targetFolder))
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

	private showFolderMenu(e: MouseEvent, folder: TFolder): void {
		const menu = new Menu();
		menu.addItem((mi) =>
			mi.setTitle("New page").setIcon("file-plus").onClick(() => this.createPage(folder))
		);
		menu.addItem((mi) =>
			mi.setTitle("New note").setIcon("file-plus-2").onClick(() => this.createNote(folder))
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

	private async createNote(folder: TFolder): Promise<void> {
		try {
			const path = this.uniquePath(folder, "Untitled", ".md");
			const file = await this.app.vault.create(path, "");
			await this.syncFolderPage(folder);
			this.revealPath(file);
			await this.app.workspace.getLeaf(false).openFile(file);
		} catch (e) {
			new Notice("Could not create note: " + errorMessage(e));
		}
	}

	private async createPage(parent: TFolder): Promise<void> {
		try {
			const path = this.uniquePath(parent, "Untitled", "");
			const folder = await this.app.vault.createFolder(path);
			const page = await this.ensureFolderPage(folder);
			if (page) await this.syncFolderPage(folder, page);
			await this.syncFolderPage(parent);
			this.revealPath(folder);
			if (page) await this.app.workspace.getLeaf(false).openFile(page);
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
		this.titleEl.setText(this.item instanceof TFolder ? "Rename folder" : "Rename file");
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

export default class MillerColumnsPlugin extends Plugin {
	async onload(): Promise<void> {
		addIcon(ICON_ID, ICON_SVG);
		this.registerView(VIEW_TYPE_MILLER, (leaf) => new MillerColumnsView(leaf));
		this.addRibbonIcon(ICON_ID, "Open Miller Columns", () => void this.activateView());
		this.addCommand({
			id: "open",
			name: "Open",
			callback: () => void this.activateView(),
		});
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
