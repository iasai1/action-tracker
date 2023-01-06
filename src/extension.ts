import * as vscode from 'vscode';
import * as tail from 'tail';
import * as fs from 'fs';
import * as path from 'path';

/**
 * telemetry.log file listener
 * Listens for appends to the file and handles them
 */
let telemetryTail: tail.Tail | undefined;

/**
 * Global extension configuration object
 * This is asynchronously updated by a vscode.workspace.onDidConfigurationChange()
 */
let configuration: vscode.WorkspaceConfiguration;

/**
 * constant for empty results
 */
const NONE = "_NONE";

/**
 * This function parses a telemetry.log line and, if it is an action log, picks out executed action's id
 * Upon finding an action, function will display that actions's id by calling vscode.window.showInformationMessage
 * 
 * An example of a target telemetry log:
 * <li>
 * 2023-01-01 00:00:00.000 [trace] telemetry/editorActionInvoked {
	"properties": {
		"id":"editor.action.wordHighlight.trigger",
		...
	},
	"measurements":{
		...
	}
 * }
 * </li>
 * 
 * NOTE: not all actions are logged with an action suffix
 * For example: if you close an editor by clicking X, it would log "telemtry/editorClosed".
 * However, closing an editor using Ctrl-F4, it would log "telemetry/editorActionExecuted"
 * 
 * It is possible to construct a list of such occurences, but it is not implemented right now
 */
function parseTelemetry(telemetryLine: String, ignoredActions: string[]) {
	// skip first 25 characters, accounting for timestamp, a white and a square bracket
	const stripped25 = telemetryLine.substring(25);

	// check if log is set to trace
	if (stripped25.substring(0, 5).toLocaleLowerCase() !== "trace") {
		return;
	}

	// check if this is an action entry
	// it is always between the log level and start of telemetry JSON
	let actionType = NONE;
	let lineType = stripped25.substring(7, stripped25.indexOf("{"));

	console.log(lineType);
	if (lineType.search("activityBarAction") !== -1) {
		actionType = "activityBarAction";
	} else if (lineType.search("editorAction") !== -1) {
		actionType = "editorAction";
	} else if (lineType.search("workbenchAction") !== -1) {
		actionType = "workbenchAction";
	} else if (lineType.search("Extension:Action") !== -1) {
		actionType = "extensionAction";
	} else {
		return;
	}

	// parse telemetry line
	let actionId = "";
	if (actionType === "extensionAction" ||
		actionType === "editorAction" ||
		actionType === "workbenchAction"
	) {
		const idValueIndex = stripped25.indexOf("\"id\":\"") + 6;
		actionId = stripped25.substring(idValueIndex, stripped25.indexOf("\"", idValueIndex));
	} else if (actionType === "activityBarAction") {
		const idValueIndex = stripped25.indexOf("\"viewletId\":\"") + 13;
		actionId = stripped25.substring(idValueIndex, stripped25.indexOf("\"", idValueIndex));
	} else {
		return;
	}

	// check if action is in ignore list
	if (ignoredActions.some((v: string, _) => actionId.toLocaleLowerCase().search(v.toLocaleLowerCase()) !== -1)) {
		return;
	}

	// passed all checks - display executed actions
	vscode.window.showInformationMessage(`Executed ${actionId}`);
}

/**
 * This function configures tail.Tail to read telemetry logs
 * 
 * @param config extension configuration snapshot
 * @returns true if tail.Tail was succefully initialized; false otherwise
 */
function init(config: vscode.WorkspaceConfiguration): boolean {

	const vscodeLogsFolderPath: string = config.get("logFolderPath", NONE);

	// validate configuration
	if (vscodeLogsFolderPath === NONE) {
		vscode.window.showErrorMessage("Log Folder Path setting is not set. \nPlease, update configuration and reload the extension");
		return false;
	}

	// open the most recent log folder and configure extension to read logs from there
	let files: fs.Dirent[];
	try {	
		files = fs.readdirSync(vscodeLogsFolderPath, { withFileTypes: true, });
	} catch (e) {
		console.log("Error opening log folder: " + e);
		vscode.window.showErrorMessage("Log Folder Path is not correctly set: error opening folder. \nPlease, update configuration and reload the extension");
		return false;
	}

	// find most recent folder
	let mostRecentLogFolder = NONE;
	let fileStat;
	let latestCreationTime = -1;
	files.forEach((file, _) => {
		if (file.isDirectory()) {
			fileStat = fs.statSync(path.join(vscodeLogsFolderPath, file.name));
			if (fileStat.ctimeMs > latestCreationTime) {
				mostRecentLogFolder = file.name;
				latestCreationTime = fileStat.ctimeMs;
			}
		}
	});
	
	// in case no folders were found
	if (mostRecentLogFolder === NONE) {
		vscode.window.showErrorMessage("Log Folder Path is not correctly set: no folders present inside. \nPlease, update configuration and reload the extension");
		return false;
	}

	// init log listener 
	const telemetryLogPath = vscodeLogsFolderPath + "/" + mostRecentLogFolder + "/telemetry.log";
	try {
		const options = { separator: /[\r]{0,1}\n/, fromBeginning: false, fsWatchOptions: {}, follow: true, logger: console };
		telemetryTail = new tail.Tail(telemetryLogPath, options);
	} catch (e) {
		console.log(e);
		vscode.window.showErrorMessage("Error opening telemetry.log. \nPlease make sure the log folder path configuration is correct");
		return false;
	}
	telemetryTail?.on("error", (e) => console.log('ERROR: ', e));
	telemetryTail?.on('line', (line: String) => parseTelemetry(line, configuration.get("ignoredActions", ["vim", "wordHighlight"])));

	return true;
}

export function activate(context: vscode.ExtensionContext) {

	configuration = vscode.workspace.getConfiguration("action-tracker");
	const showInitMessage: boolean = configuration.get("showInitMessage", true);

	// register commands
	let startTracking = vscode.commands.registerCommand('action-tracker.startTracking', () => {
		let isTelemetryTailInit = true;
		if (!telemetryTail) {
			isTelemetryTailInit = init(configuration);
		} 

		if (isTelemetryTailInit) {
			telemetryTail?.watch();
			vscode.window.showInformationMessage("Started tracking VSCode actions! \nYou can configure actions to ignore in the extension configuration");
		}
	});

	let stopTracking = vscode.commands.registerCommand('action-tracker.stopTracking', () => {
		telemetryTail?.unwatch();
		vscode.window.showInformationMessage("Stopped tracking VSCode actions");
	});

	context.subscriptions.push(startTracking);
	context.subscriptions.push(stopTracking);

	// register configuration updates listener
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((_) => configuration = vscode.workspace.getConfiguration("action-tracker")));

	// show init message 
	if (showInitMessage) {
		vscode.window.showWarningMessage("Action Tracker extension relies on VSCode's Telemetry logs.\nPlease make sure Telemetry logs are at \*trace\* level");
		vscode.window.showWarningMessage("VSCode creates a log folder per day. \nIf Action Tracker stopped showing messages - reboot VSCode or restart the extension");
	}
}

// This method is called when your extension is deactivated
export function deactivate() {
	telemetryTail?.unwatch();
}
