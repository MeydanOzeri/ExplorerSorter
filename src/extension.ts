import { type ExtensionContext, type WorkspaceFolder, type FileSystemWatcher, Uri, OutputChannel, workspace, window, Disposable, ExtensionMode, RelativePattern } from 'vscode';
import WorkspaceSorter from './WorkspaceSorter.ts';
import path from 'path';

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

const queueChangedPaths = (queuedWorkspaceSorts: Map<string, Map<string, Uri>>, relevantChangedPaths: Uri[], workspaceFolder: WorkspaceFolder) => {
	const queuedChangedPaths = queuedWorkspaceSorts.get(workspaceFolder.uri.fsPath) ?? new Map<string, Uri>();
	for (const changedPath of relevantChangedPaths) {
		queuedChangedPaths.set(changedPath.fsPath, changedPath);
	}
	queuedWorkspaceSorts.set(workspaceFolder.uri.fsPath, queuedChangedPaths);
};

const triggerWorkspaceSort = async (
	runningWorkspaceSorts: Set<string>,
	queuedWorkspaceSorts: Map<string, Map<string, Uri>>,
	outputChannel: OutputChannel,
	workspaceFolder: WorkspaceFolder,
	changedPaths: Uri[] = []
) => {
	const relevantChangedPaths = changedPaths.filter((changedPath) => !isIgnoredPath(workspaceFolder, changedPath) && !WorkspaceSorter.isSelfTriggeredMtimeChange(changedPath));
	if (relevantChangedPaths.length === 0 && changedPaths.length > 0) {
		return;
	}
	if (runningWorkspaceSorts.has(workspaceFolder.uri.fsPath)) {
		return queueChangedPaths(queuedWorkspaceSorts, relevantChangedPaths, workspaceFolder);
	}
	try {
		runningWorkspaceSorts.add(workspaceFolder.uri.fsPath);
		for (const changedPath of relevantChangedPaths) {
			WorkspaceSorter.enforcePreviousOrderOnMtimeChange(workspaceFolder, changedPath);
		}
		await sortWorkspace(outputChannel, workspaceFolder);
	} finally {
		runningWorkspaceSorts.delete(workspaceFolder.uri.fsPath);
		const queuedChangedPaths = queuedWorkspaceSorts.get(workspaceFolder.uri.fsPath) ?? new Map<string, Uri>();
		if (queuedWorkspaceSorts.delete(workspaceFolder.uri.fsPath)) {
			await triggerWorkspaceSort(runningWorkspaceSorts, queuedWorkspaceSorts, outputChannel, workspaceFolder, [...queuedChangedPaths.values()]);
		}
	}
};

const activate = async (context: ExtensionContext) => {
	const runningWorkspaceSorts = new Set<string>();
	const queuedWorkspaceSorts = new Map<string, Map<string, Uri>>();
	const workspaceWatchers: FileSystemWatcher[] = [];
	const outputChannel = window.createOutputChannel('ExplorerSorter');
	if (context.extensionMode === ExtensionMode.Development) {
		outputChannel.show();
	}
	outputChannel.appendLine('Extension "ExplorerSorter" is now active!');
	for (const workspaceFolder of workspace.workspaceFolders ?? []) {
		await sortWorkspace(outputChannel, workspaceFolder);
		const workspaceWatcher = workspace.createFileSystemWatcher(new RelativePattern(workspaceFolder, '**'));
		workspaceWatcher.onDidChange((uri) => void triggerWorkspaceSort(runningWorkspaceSorts, queuedWorkspaceSorts, outputChannel, workspaceFolder, [uri]));
		workspaceWatcher.onDidCreate((uri) => void triggerWorkspaceSort(runningWorkspaceSorts, queuedWorkspaceSorts, outputChannel, workspaceFolder, [uri]));
		workspaceWatcher.onDidDelete((uri) => void triggerWorkspaceSort(runningWorkspaceSorts, queuedWorkspaceSorts, outputChannel, workspaceFolder, [uri]));
		workspaceWatchers.push(workspaceWatcher);
	}
	context.subscriptions.push(
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
