import type { OrderRule } from './types/OrderRule.ts';

import { minimatch } from 'minimatch';
import { FileType, type WorkspaceFolder, Uri, workspace } from 'vscode';
import { existsSync, utimesSync, statSync } from 'fs';
import OrderRulesParser from './OrderRulesParser.ts';

const MTIME_STEP = 1100; // Use >1s steps for reliable directory mtime ordering on coarse filesystems

class WorkspaceSorter {
	static #cachedMtime = new Map<string, Date>();
	static #orderedEntries = new Map<string, Array<{ name: string; isDirectory: boolean }>>();

	#workspaceFolder: WorkspaceFolder;
	#ignoredDirectories = new Set([
		...workspace.getConfiguration('explorerSorter').get<string[]>('ignoredDirectories', []),
		...workspace.getConfiguration('explorerSorter').get<string[]>('extraIgnoredDirectories', [])
	]);

	static isSelfTriggeredMtimeChange = (uri: Uri) => {
		const cachedMtime = WorkspaceSorter.#cachedMtime.get(uri.fsPath);
		if (!cachedMtime || !existsSync(uri.fsPath)) {
			return false;
		}
		return statSync(uri.fsPath).mtime.getTime() === cachedMtime.getTime();
	};

	static enforcePreviousOrderOnMtimeChange = (workspaceFolder: WorkspaceFolder, changedPath: Uri) => {
		const cachedMtime = WorkspaceSorter.#cachedMtime.get(changedPath.fsPath);
		if (cachedMtime && existsSync(changedPath.fsPath)) {
			utimesSync(changedPath.fsPath, cachedMtime, cachedMtime);
		}
		if (changedPath.fsPath === workspaceFolder.uri.fsPath) {
			return;
		}
		const parentPath = changedPath.fsPath.slice(0, Math.max(changedPath.fsPath.lastIndexOf('/'), changedPath.fsPath.lastIndexOf('\\')));
		WorkspaceSorter.enforcePreviousOrderOnMtimeChange(workspaceFolder, Uri.file(parentPath));
	};

	constructor(workspaceFolder: WorkspaceFolder) {
		this.#workspaceFolder = workspaceFolder;
	}

	#isExactEntryMatch = (currentDirectory: Uri, entry: string, orderLine: string) => {
		const currentEntryPath = Uri.joinPath(currentDirectory, entry).fsPath;
		const orderLinePath = Uri.joinPath(this.#workspaceFolder.uri, ...orderLine.split('/')).fsPath;
		return currentEntryPath === orderLinePath;
	};

	#isSimpleEntryMatch = (entry: string, orderLine: string) => {
		return minimatch(entry, orderLine, { dot: true });
	};

	#isGlobEntryMatch = (currentDirectory: Uri, entry: string, orderLine: string) => {
		const currentEntryPath = Uri.joinPath(currentDirectory, entry).fsPath;
		const workspaceRelativePath = currentEntryPath.slice(this.#workspaceFolder.uri.fsPath.length + 1).replaceAll('\\', '/');
		return minimatch(workspaceRelativePath, orderLine, { dot: true });
	};

	#getOrderedEntries = (currentDirectory: Uri, entries: Array<{ name: string; isDirectory: boolean }>, orderRules: OrderRule[]) => {
		if (entries.length <= 1) {
			return entries;
		}
		const entriesWithAppliedRules = new Set<string>();
		const lexicographicallyOrderedEntries = entries.toSorted((entryA, entryB) => entryA.name.localeCompare(entryB.name));
		for (const orderRule of orderRules) {
			for (const entry of lexicographicallyOrderedEntries) {
				const isExactEntryMatch = orderRule.lineType === 'exact' && this.#isExactEntryMatch(currentDirectory, entry.name, orderRule.line);
				const isGlobEntryMatch = orderRule.lineType === 'glob' && this.#isGlobEntryMatch(currentDirectory, entry.name, orderRule.line);
				const isSimpleEntryMatch = orderRule.lineType === 'simple' && this.#isSimpleEntryMatch(entry.name, orderRule.line);
				if (isExactEntryMatch || isGlobEntryMatch || isSimpleEntryMatch) {
					entriesWithAppliedRules.add(entry.name);
				}
			}
		}
		const sortedEntries = lexicographicallyOrderedEntries.filter((entry) => entriesWithAppliedRules.has(entry.name));
		const unorderedEntries = lexicographicallyOrderedEntries.filter((entry) => !entriesWithAppliedRules.has(entry.name));
		return [...sortedEntries, ...unorderedEntries];
	};

	#areSameOrder = (orderA: Array<{ name: string; isDirectory: boolean }>, orderB: Array<{ name: string; isDirectory: boolean }>) =>
		orderA.length === orderB.length && orderA.every((entry, index) => entry.name === orderB[index].name && entry.isDirectory === orderB[index].isDirectory);

	#applyOrderRules = (currentDirectory: Uri, orderedEntries: Array<{ name: string; isDirectory: boolean }>, baseTime: number) => {
		const previousOrderedEntries = WorkspaceSorter.#orderedEntries.get(currentDirectory.fsPath);
		if (previousOrderedEntries && this.#areSameOrder(previousOrderedEntries, orderedEntries)) {
			return;
		}
		for (let index = 0; index < orderedEntries.length; index++) {
			const filePath = Uri.joinPath(currentDirectory, orderedEntries[index].name).fsPath;
			const mtime = new Date(baseTime - index * MTIME_STEP);
			utimesSync(filePath, mtime, mtime);
			WorkspaceSorter.#cachedMtime.set(filePath, mtime);
		}
		WorkspaceSorter.#orderedEntries.set(currentDirectory.fsPath, orderedEntries);
	};

	#sortDirectory = (currentDirectory: Uri, directoryEntries: { directories: string[]; files: string[] }, orderRules: OrderRule[]) => {
		// Create combined list of all entries with their type information
		const allEntries: Array<{ name: string; isDirectory: boolean }> = [
			...directoryEntries.directories.map((name) => ({ name, isDirectory: true })),
			...directoryEntries.files.map((name) => ({ name, isDirectory: false }))
		];

		// Apply ordering rules across all entries (respecting .order file priorities)
		const orderedEntries = this.#getOrderedEntries(currentDirectory, allEntries, orderRules);

		// Assign mtimes based on combined order
		const baseTime = Date.now();
		this.#applyOrderRules(currentDirectory, orderedEntries, baseTime);
	};

	#getDirectoryEntries = async (currentDirectory: Uri) => {
		const directoryEntries: { directories: string[]; files: string[] } = { directories: [], files: [] };
		for (const directoryEntry of await workspace.fs.readDirectory(currentDirectory)) {
			if (directoryEntry[1] === FileType.Directory) {
				directoryEntries.directories.push(directoryEntry[0]);
			} else {
				directoryEntries.files.push(directoryEntry[0]);
			}
		}
		return directoryEntries;
	};

	sort = async (currentDirectory: Uri = this.#workspaceFolder.uri, parentOrderRules: OrderRule[] = []) => {
		const { directories, files } = await this.#getDirectoryEntries(currentDirectory);
		const orderRules = await OrderRulesParser.getOrderRules(parentOrderRules, currentDirectory, files);
		this.#sortDirectory(currentDirectory, { directories, files }, orderRules);
		for (const directoryEntry of directories.filter((directoryEntry) => !this.#ignoredDirectories.has(directoryEntry))) {
			await this.sort(Uri.joinPath(currentDirectory, directoryEntry), orderRules);
		}
	};
}

export default WorkspaceSorter;
