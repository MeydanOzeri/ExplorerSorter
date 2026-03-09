import type { OrderRule } from './types/OrderRule.ts';

import { minimatch } from 'minimatch';
import { FileType, type WorkspaceFolder, Uri, workspace } from 'vscode';
import { utimesSync } from 'fs';
import OrderRulesParser from './OrderRulesParser.ts';

class WorkspaceSorter {
	static #cachedMtime = new Map<string, Date>();
	static #orderedEntries = { directories: new Map<string, string[]>(), files: new Map<string, string[]>() };

	#mtimeStep = 1100; // Use >1s steps for reliable directory mtime ordering on coarse filesystems
	#workspaceFolder: WorkspaceFolder;
	#ignoredDirectories = new Set(workspace.getConfiguration('explorerSorter').get<string[]>('ignoredDirectories', []));
	#extraIgnoredDirectories = new Set(workspace.getConfiguration('explorerSorter').get<string[]>('extraIgnoredDirectories', []));

	static updateSavedFileMtime = (savedFile: Uri) => {
		const cachedMtime = WorkspaceSorter.#cachedMtime.get(savedFile.fsPath);
		if (cachedMtime) {
			utimesSync(savedFile.fsPath, cachedMtime, cachedMtime);
		}
	};

	constructor(workspaceFolder: WorkspaceFolder) {
		this.#workspaceFolder = workspaceFolder;
	}

	#isExactEntryMatch = (directory: Uri, entry: string, orderLine: string) => {
		const currentEntryPath = Uri.joinPath(directory, entry).fsPath;
		const orderLinePath = Uri.joinPath(this.#workspaceFolder.uri, ...orderLine.split('/')).fsPath;
		return currentEntryPath === orderLinePath;
	};

	#isGlobEntryMatch = (directory: Uri, entry: string, orderLine: string) => {
		const currentEntryPath = Uri.joinPath(directory, entry).fsPath;
		const workspaceRelativePath = currentEntryPath.slice(this.#workspaceFolder.uri.fsPath.length + 1).replaceAll('\\', '/');
		return minimatch(workspaceRelativePath, orderLine, { dot: true });
	};

	#getOrderedEntries = (directory: Uri, entries: string[], orderRules: OrderRule[]) => {
		if (entries.length <= 1) {
			return entries;
		}
		const entriesWithAppliedRules = new Set<string>();
		const lexicographicallyOrderedEntries = entries.toSorted((entryA, entryB) => entryA.localeCompare(entryB));
		for (const orderRule of orderRules) {
			for (const entry of lexicographicallyOrderedEntries) {
				const isExactEntryMatch = orderRule.lineType === 'exact' && this.#isExactEntryMatch(directory, entry, orderRule.line);
				const isGlobEntryMatch = orderRule.lineType === 'glob' && this.#isGlobEntryMatch(directory, entry, orderRule.line);
				if (isExactEntryMatch || isGlobEntryMatch) {
					entriesWithAppliedRules.add(entry);
				}
			}
		}
		return [...entriesWithAppliedRules, ...lexicographicallyOrderedEntries.filter((entry) => !entriesWithAppliedRules.has(entry))];
	};

	#areSameOrder = (orderA: string[], orderB: string[]) => orderA.length === orderB.length && orderA.every((entry, index) => entry === orderB[index]);

	#applyOrderRules = (entriesType: 'directories' | 'files', directory: Uri, orderedEntries: string[], baseTime: number) => {
		const previousOrderedEntries = WorkspaceSorter.#orderedEntries[entriesType].get(directory.fsPath);
		if (previousOrderedEntries && this.#areSameOrder(previousOrderedEntries, orderedEntries)) {
			return;
		}
		for (let index = 0; index < orderedEntries.length; index++) {
			const filePath = Uri.joinPath(directory, orderedEntries[index]).fsPath;
			const mtime = new Date(baseTime - index * this.#mtimeStep);
			utimesSync(filePath, mtime, mtime);
			WorkspaceSorter.#cachedMtime.set(filePath, mtime);
		}
		WorkspaceSorter.#orderedEntries[entriesType].set(directory.fsPath, orderedEntries);
	};

	#sortDirectory = (directory: Uri, directoryEntries: { directories: string[]; files: string[] }, orderRules: OrderRule[]) => {
		const orderedDirectories = this.#getOrderedEntries(directory, directoryEntries.directories, orderRules);
		const directoriesBaseTime = Date.now();
		this.#applyOrderRules('directories', directory, orderedDirectories, directoriesBaseTime);

		const orderedFiles = this.#getOrderedEntries(directory, directoryEntries.files, orderRules);
		const filesBaseTime = directoriesBaseTime - (directoryEntries.directories.length + 1) * this.#mtimeStep;
		this.#applyOrderRules('files', directory, orderedFiles, filesBaseTime);
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
		for (const directoryEntry of directories) {
			if (!this.#ignoredDirectories.has(directoryEntry) && !this.#extraIgnoredDirectories.has(directoryEntry)) {
				await this.sort(Uri.joinPath(currentDirectory, directoryEntry), orderRules);
			}
		}
	};
}

export default WorkspaceSorter;
