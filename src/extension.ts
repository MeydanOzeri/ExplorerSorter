import {
	type ExtensionContext,
	type WorkspaceFolder,
	type FileSystemWatcher,
	Uri,
	OutputChannel,
	workspace,
	window,
	commands,
	Disposable,
	ExtensionMode,
	RelativePattern
} from 'vscode';
import WorkspaceSorter from './WorkspaceSorter.ts';
import path from 'path';
import { promises as fs } from 'fs';

const isIgnoredPath = (workspaceFolder: WorkspaceFolder, changedPath: Uri) => {
	if (changedPath.fsPath === workspaceFolder.uri.fsPath) {
		return false;
	}
	const ignoredDirectories = new Set([
		...workspace.getConfiguration('explorerSorter', workspaceFolder).get<string[]>('ignoredDirectories', []),
		...workspace.getConfiguration('explorerSorter', workspaceFolder).get<string[]>('extraIgnoredDirectories', [])
	]);
	if (ignoredDirectories.has(path.basename(changedPath.fsPath))) {
		return true;
	}
	return isIgnoredPath(workspaceFolder, Uri.file(path.dirname(changedPath.fsPath)));
};

const sortWorkspace = async (outputChannel: OutputChannel, workspaceFolder: WorkspaceFolder) => {
	try {
		const workspaceSorter = new WorkspaceSorter(workspaceFolder);
		outputChannel.appendLine(`Sorting workspace ${workspaceFolder.name} on path: ${workspaceFolder.uri.fsPath}`);
		const startTime = Date.now();
		await workspaceSorter.sort();
		const endTime = Date.now();
		outputChannel.appendLine(`Workspace ${workspaceFolder.name} is sorted after ${endTime - startTime}ms.`);
	} catch (error) {
		outputChannel.appendLine(`sortWorkspace failed: ${error instanceof Error ? error.message : String(error)}`);
	}
};

const triggerWorkspaceSort = async (
	runningWorkspaceSorts: Set<string>,
	queuedWorkspaceSorts: Set<string>,
	outputChannel: OutputChannel,
	workspaceFolder: WorkspaceFolder,
	changedPath?: Uri
) => {
	if (changedPath) {
		if (isIgnoredPath(workspaceFolder, changedPath) || WorkspaceSorter.isSelfTriggeredMtimeChange(changedPath)) {
			return;
		}
		WorkspaceSorter.enforcePreviousOrderOnMtimeChange(workspaceFolder, changedPath);
	}
	if (runningWorkspaceSorts.has(workspaceFolder.uri.fsPath)) {
		queuedWorkspaceSorts.add(workspaceFolder.uri.fsPath);
		return;
	}
	try {
		runningWorkspaceSorts.add(workspaceFolder.uri.fsPath);
		await sortWorkspace(outputChannel, workspaceFolder);
	} finally {
		runningWorkspaceSorts.delete(workspaceFolder.uri.fsPath);
		if (queuedWorkspaceSorts.delete(workspaceFolder.uri.fsPath)) {
			await triggerWorkspaceSort(runningWorkspaceSorts, queuedWorkspaceSorts, outputChannel, workspaceFolder);
		}
	}
};

const generateOrderFile = async (folderUri: Uri | undefined, outputChannel: OutputChannel) => {
	if (!folderUri) {
		window.showErrorMessage('Please select a folder to generate the .order file.');
		return;
	}

	try {
		const folderPath = folderUri.fsPath;
		const orderFilePath = path.join(folderPath, '.order');

		// Check if .order file already exists
		try {
			await fs.access(orderFilePath);
			const overwrite = await window.showWarningMessage('.order file already exists. Do you want to overwrite it?', { modal: true }, 'Yes', 'No');
			if (overwrite !== 'Yes') {
				return;
			}
		} catch {
			// File doesn't exist, which is fine
		}

		// Read folder contents
		const entries = await fs.readdir(folderPath, { withFileTypes: true });

		// Separate folders and files, sort each group alphabetically
		const folders = entries
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort((a, b) => a.localeCompare(b));

		const files = entries
			.filter((entry) => !entry.isDirectory())
			.map((entry) => entry.name)
			.sort((a, b) => a.localeCompare(b));

		// Combine: folders first, then files
		const allEntries = [...folders, ...files];

		// Generate .order file content
		const orderContent = allEntries.join('\n') + (allEntries.length > 0 ? '\n' : '');

		// Write .order file
		await fs.writeFile(orderFilePath, orderContent, 'utf8');

		outputChannel.appendLine(`Generated .order file at ${orderFilePath}`);

		// Open the .order file for editing
		const document = await workspace.openTextDocument(orderFilePath);
		await window.showTextDocument(document);

		window.showInformationMessage('.order file generated successfully!');
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		outputChannel.appendLine(`generateOrderFile failed: ${errorMessage}`);
		window.showErrorMessage(`Failed to generate .order file: ${errorMessage}`);
	}
};

const activate = async (context: ExtensionContext) => {
	const runningWorkspaceSorts = new Set<string>();
	const queuedWorkspaceSorts = new Set<string>();
	const workspaceWatchers: FileSystemWatcher[] = [];
	const outputChannel = window.createOutputChannel('ExplorerSorter');
	if (context.extensionMode === ExtensionMode.Development) {
		outputChannel.show();
	}
	outputChannel.appendLine('Extension "ExplorerSorter" is now active!');
	for (const workspaceFolder of workspace.workspaceFolders ?? []) {
		await sortWorkspace(outputChannel, workspaceFolder);
		const workspaceWatcher = workspace.createFileSystemWatcher(new RelativePattern(workspaceFolder, '**'));
		workspaceWatcher.onDidChange((uri) => void triggerWorkspaceSort(runningWorkspaceSorts, queuedWorkspaceSorts, outputChannel, workspaceFolder, uri));
		workspaceWatcher.onDidCreate((uri) => void triggerWorkspaceSort(runningWorkspaceSorts, queuedWorkspaceSorts, outputChannel, workspaceFolder, uri));
		workspaceWatcher.onDidDelete((uri) => void triggerWorkspaceSort(runningWorkspaceSorts, queuedWorkspaceSorts, outputChannel, workspaceFolder, uri));
		workspaceWatchers.push(workspaceWatcher);
	}
	context.subscriptions.push(
		commands.registerCommand('explorerSorter.generateOrderFile', (folderUri: Uri | undefined) => generateOrderFile(folderUri, outputChannel)),
		workspace.onDidChangeConfiguration((configurationChangeEvent) => {
			for (const workspaceFolder of workspace.workspaceFolders ?? []) {
				const isIgnoredDirectoriesAffected = configurationChangeEvent.affectsConfiguration('explorerSorter.ignoredDirectories', workspaceFolder);
				const isExtraIgnoredDirectoriesAffected = configurationChangeEvent.affectsConfiguration('explorerSorter.extraIgnoredDirectories', workspaceFolder);
				if (isIgnoredDirectoriesAffected || isExtraIgnoredDirectoriesAffected) {
					void triggerWorkspaceSort(runningWorkspaceSorts, queuedWorkspaceSorts, outputChannel, workspaceFolder);
				}
			}
		}),
		...workspaceWatchers,
		new Disposable(() => {
			runningWorkspaceSorts.clear();
			queuedWorkspaceSorts.clear();
		})
	);
};

const deactivate = () => {
	// Nothing to deactivate
};

export { activate, deactivate };
