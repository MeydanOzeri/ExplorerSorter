import { type ExtensionContext, type Uri, type WorkspaceFolder, OutputChannel, workspace, window, Disposable, ExtensionMode } from 'vscode';
import WorkspaceSorter from './WorkspaceSorter.ts';

const EVENT_DEBOUNCE_MS = 250;

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

const getUniqueWorkspaceFolders = (files: readonly Uri[]) =>
	files.map((file) => workspace.getWorkspaceFolder(file)).filter((workspaceFolder, index, self) => index === self.indexOf(workspaceFolder));

const debounceSortWorkspace = (debounceTimers: Map<string, NodeJS.Timeout>, outputChannel: OutputChannel, workspaceFolder: WorkspaceFolder) => {
	const workspaceKey = workspaceFolder.uri.toString();
	clearTimeout(debounceTimers.get(workspaceKey));
	debounceTimers.set(
		workspaceKey,
		setTimeout(() => void sortWorkspace(outputChannel, workspaceFolder), EVENT_DEBOUNCE_MS) // DevSkim: ignore DS172411
	);
};

const activate = async (context: ExtensionContext) => {
	const debounceTimers = new Map<string, NodeJS.Timeout>();
	const outputChannel = window.createOutputChannel('ExplorerSorter');
	if (context.extensionMode === ExtensionMode.Development) {
		outputChannel.show();
	}
	outputChannel.appendLine('Extension "ExplorerSorter" is now active!');
	for (const workspaceFolder of workspace.workspaceFolders ?? []) {
		await sortWorkspace(outputChannel, workspaceFolder);
	}
	context.subscriptions.push(
		workspace.onDidSaveTextDocument((textDocument) => {
			const workspaceFolder = workspace.getWorkspaceFolder(textDocument.uri);
			if (workspaceFolder) {
				WorkspaceSorter.enforcePreviousOrderOnMtimeChange(workspaceFolder, textDocument.uri);
				debounceSortWorkspace(debounceTimers, outputChannel, workspaceFolder);
			}
		}),
		workspace.onDidRenameFiles((fileRenameEvent) => {
			const workspaceFolders = getUniqueWorkspaceFolders(fileRenameEvent.files.map((file) => file.newUri));
			for (const workspaceFolder of workspaceFolders) {
				if (workspaceFolder) {
					for (const file of fileRenameEvent.files.filter((file) => workspace.getWorkspaceFolder(file.newUri) === workspaceFolder)) {
						WorkspaceSorter.enforcePreviousOrderOnMtimeChange(workspaceFolder, file.oldUri);
					}
					debounceSortWorkspace(debounceTimers, outputChannel, workspaceFolder);
				}
			}
		}),
		workspace.onDidCreateFiles((fileCreateEvent) => {
			const workspaceFolders = getUniqueWorkspaceFolders(fileCreateEvent.files);
			for (const workspaceFolder of workspaceFolders) {
				if (workspaceFolder) {
					for (const file of fileCreateEvent.files.filter((file) => workspace.getWorkspaceFolder(file) === workspaceFolder)) {
						WorkspaceSorter.enforcePreviousOrderOnMtimeChange(workspaceFolder, file);
					}
					debounceSortWorkspace(debounceTimers, outputChannel, workspaceFolder);
				}
			}
		}),
		workspace.onDidDeleteFiles((fileDeleteEvent) => {
			const workspaceFolders = getUniqueWorkspaceFolders(fileDeleteEvent.files);
			for (const workspaceFolder of workspaceFolders) {
				if (workspaceFolder) {
					for (const file of fileDeleteEvent.files.filter((file) => workspace.getWorkspaceFolder(file) === workspaceFolder)) {
						WorkspaceSorter.enforcePreviousOrderOnMtimeChange(workspaceFolder, file);
					}
					debounceSortWorkspace(debounceTimers, outputChannel, workspaceFolder);
				}
			}
		}),
		workspace.onDidChangeConfiguration((configurationChangeEvent) => {
			for (const workspaceFolder of workspace.workspaceFolders ?? []) {
				const isIgnoredDirectoriesAffected = configurationChangeEvent.affectsConfiguration('explorerSorter.ignoredDirectories', workspaceFolder);
				const isExtraIgnoredDirectoriesAffected = configurationChangeEvent.affectsConfiguration('explorerSorter.extraIgnoredDirectories', workspaceFolder);
				if (isIgnoredDirectoriesAffected || isExtraIgnoredDirectoriesAffected) {
					debounceSortWorkspace(debounceTimers, outputChannel, workspaceFolder);
				}
			}
		}),
		new Disposable(() => {
			for (const timer of debounceTimers.values()) {
				clearTimeout(timer);
			}
			debounceTimers.clear();
		})
	);
};

const deactivate = () => {
	// Nothing to deactivate
};

export { activate, deactivate };
