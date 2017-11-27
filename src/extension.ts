"use strict"
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from "vscode"
// import pythonShell module for executing python scripts
import * as pythonShell from "python-shell"
// import modules for web server preview
import { BrowserContentProvider } from "./browserContentProvider";
import { PreviewServer } from "./preview-server";
import { Utility } from "./utility";
// import viewX configuration module
import { ViewXExtension } from "./viewXExtension"
// import socket.io client (must be imported like this in typescript)
import * as io from "socket.io-client"
// import socket server (communication proxy)
import * as socketserver from "./socket-server"

// expose global variables
let viewXExtension: ViewXExtension;
let socket: any;
let econtext: vscode.ExtensionContext;

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

    // Use the console to output diagnostic information (console.log) and errors (console.error)
    // This line of code will only be executed once when your extension is activated
    console.log("Congratulations, your extension 'viewx-vscode' is now active!");
    console.log(context);

    let disposables: vscode.Disposable[] = [];
    viewXExtension = new ViewXExtension(context);
    econtext = context;

    console.log("context");
    console.log(context.globalState.get("usedPorts"));

    startSocketServer(disposables);
    registerBrowserProvider(disposables);

    // When configuration is changed, resume web server.
    vscode.workspace.onDidChangeConfiguration(() => {
        const settings = viewXExtension.previewServerConfig.get("isWatchConfiguration") as boolean;
        if (settings) {
            viewXExtension.resumePreviewServer();
        }
    });

    vscode.workspace.onDidSaveTextDocument((e) => {
        if (viewXExtension.activeViewXModel !== undefined) {
            let activeModelUri: vscode.Uri = vscode.window.activeTextEditor.document.uri;
            if (viewXExtension.isPreviewActive && activeModelUri.path === viewXExtension.lastPreviewedFileUri.path) {
                // re-generate preview html file when model file is saved (apply changes)
                viewXExtension.generatePreviewHtmlForModelAsync(activeModelUri, () => {
                    // when file is saved, reload browser.
                    viewXExtension.openModelPreview(() => { PreviewServer.reload("preview.html"); });
                });
            }
        }
    });

    vscode.workspace.onDidCloseTextDocument(document => {
        // https://github.com/Microsoft/vscode/issues/33728
        // there is no way to find out if file has been closed
        // it is good that close event is not fired while preview is visible (switched from another view column)
        // so when it is not visible we can set the flag and trigger preview showing again
        // since it will not create another tab if it is not actually closed, it will create new if it is
        if (document !== undefined && document.isClosed && document.uri.path === "/preview.html") {
            viewXExtension.isPreviewActive = false;
        }
    });

    // check whether newly active document can be previewed
    vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor !== undefined) {
            let activeModelUri: vscode.Uri = editor.document.uri;
            let fileName: string = Utility.getFileNameFromFileUriPath(activeModelUri.path);
            let viewXModel: string = viewXExtension.findMatchingViewXModel(fileName);
            viewXExtension.extensionConfig.update("canPreviewActiveDocument", (viewXModel !== undefined));
        }
    });

    disposables.push(vscode.commands.registerCommand("viewx.initProject", (explorerUri: vscode.Uri) => {
        // check if explorerUri is empty object (keyboard shortcut is used)
        if (Object.keys(explorerUri).length === 0) {
            vscode.window.showInputBox({
                prompt: "Please insert a path where you want to setup a ViewX project",
                placeHolder: "Path to the project",
                ignoreFocusOut: true
            }).then(result => initProject(result));
        }
        else {
            initProject(explorerUri.fsPath);
        }

        function initProject(path: string) {
            let projectPath = path;
            vscode.window.showInputBox({
                prompt: "Please insert a name of the ViewX project",
                placeHolder: "Name of the project",
                ignoreFocusOut: true
            }).then(result => {
                if (result !== undefined) {
                    let projectName: string = result;
                    let projectFolder: vscode.Uri = vscode.Uri.file(`${projectPath}/${projectName}`);

                    let pyScriptUri: vscode.Uri = vscode.Uri.file(`${viewXExtension.extensionPath}/out/python`);
                    let scriptName: string = "viewx_init_project.py";
                    let options = {
                        mode: "text",
                        pythonPath: vscode.Uri.file(`${viewXExtension.viewXVEnvPath}/python`).fsPath,
                        // pythonOptions: ["-u"],
                        // need to explicitly specify script path to be cross-platform functional
                        scriptPath: pyScriptUri.fsPath,
                        args: [projectPath, projectName]
                    };

                    pythonShell.run(scriptName, options, function (err, results) {
                        // if (err) throw err;
                        // on some Linux distributions python fails if no __main__.py module exists
                        // this is solved by specyfing the scriptPath to the python script directly, instead to it's directory
                        if(err && err.exitCode === 1 && err.toString().indexOf("find '__main__' module") !== -1) {
                            let fileUri = vscode.Uri.file(`${pyScriptUri.path}/${scriptName}`);
                            options.scriptPath = fileUri.fsPath;
                            // run the script again after fixing the script path
                            pythonShell.run(scriptName, options, function (err, results) {
                                if (results && results.length > 0 && (results[0] as string).trim() === "success") {
                                    vscode.commands.executeCommand("vscode.openFolder", projectFolder, true);
                                }
                            });
                        }

                        // results is an array consisting of messages collected during execution
                        // "success" is returned by the .py script
                        else if (results && results.length > 0 && (results[0] as string).trim() === "success") {
                            vscode.commands.executeCommand("vscode.openFolder", projectFolder, true);
                        }
                    });
                }
            });
        };
    }));

    disposables.push(vscode.commands.registerCommand("viewx.previewModel", () => {
        let activeModelUri: vscode.Uri = vscode.window.activeTextEditor.document.uri;
        let fileName: string = Utility.getFileNameFromFileUriPath(activeModelUri.path);
        let viewXModel: string = viewXExtension.findMatchingViewXModel(fileName);
        if (viewXModel !== undefined) {
            viewXExtension.generatePreviewHtmlForModelAsync(activeModelUri, () => {
                viewXExtension.openModelPreview(() => {
                    PreviewServer.reload("preview.html");
                });
            });
        }
        else {
            vscode.window.showErrorMessage("There is no found viewX model that matches current file!");
        }
    }));

    disposables.push(vscode.commands.registerCommand("viewx.launchBrowser", () => {
        const uri = Utility.getUriOfPreviewHtml();
        return vscode.commands.executeCommand("vscode.open", uri);
    }));

    disposables.push(vscode.commands.registerCommand("viewx.stopPreviewServer", () => {
        PreviewServer.stop();
        vscode.window.showInformationMessage("Stop the PreviewServer successfully.");
    }));

    disposables.push(vscode.commands.registerCommand("viewx.resumePreviewServer", () => {
        viewXExtension.resumePreviewServer();
        vscode.window.showInformationMessage("Resume the PreviewServer.");
    }));

    disposables.push(vscode.commands.registerCommand("viewx.showUsedPorts", () => {
        let usedPorts: Array<number> = viewXExtension.socketServerConfig.get("usedPorts") as Array<number>;
        vscode.window.showInformationMessage(`Port used by this instance: ${viewXExtension.activeSocketPort}. Other ports taken by socket.io server are: ${usedPorts}`);
    }));

    // subscribe all commands
    disposables.forEach(disposable => {
        context.subscriptions.push(disposable);
    });
}

// this method is called when your extension is deactivated
export function deactivate() {
    console.log("deactivate|start");
    // let usedPorts: Array<number> = viewXExtension.socketServerConfig.get("usedPorts") as Array<number>;
    let usedPorts: Array<number> = this.econtext.globalState.get("usedPorts");
    console.log(usedPorts);
    PreviewServer.stop();
    // socket.emit("ext-send-command", "deactivate|end");
    console.log("deactivate|end");
}

function startSocketServer(disposables: vscode.Disposable[]) {
    let usedPorts: Array<number> = viewXExtension.socketServerConfig.get("usedPorts") as Array<number>;
    console.log("used ports: " + usedPorts);

    // using socket port defined in viewX project config file
    let socketPort: number = undefined;
    if (viewXExtension.viewXProjectConfig !== undefined) {
        socketPort = viewXExtension.viewXProjectConfig.project.socketPort;
        console.log("Defined socket port: " + socketPort);
    }
    if (socketPort === undefined) {
        socketPort = viewXExtension.socketServerConfig.get("port") as number;
        console.log("Overriding socket port: " + socketPort);
    }

    // start socket server asynchronously, promise is returned
    socketserver.startSocketServer(socketPort).then(function(usedPort) {
        viewXExtension.activeSocketPort = usedPort;
        console.log("Using socket port: " + usedPort);
        if (viewXExtension.activeSocketPort > -1 && !(usedPorts.indexOf(viewXExtension.activeSocketPort) > -1)) {
            usedPorts.push(viewXExtension.activeSocketPort);
            viewXExtension.socketServerConfig.update("usedPorts", usedPorts, true).then(() => {
                console.log("Updating ports with: " + usedPorts);
            });
        }

        // when port is determined for the socket server, we can connect to it and bind to an event
        socket = io(`http://localhost:${viewXExtension.activeSocketPort}`);
        socket.emit("ext-room", viewXExtension.socketServerConfig.get("debugMode") as boolean);
        socket.on("ext-receive-command", function(command) {
            console.log("extension received command: " + command);
            viewXExtension.interpretCommand(command);
        });

        // register command to push message to the socket server
        disposables.push(vscode.commands.registerCommand("viewx.fitDefinition", () => {
            let cursorPosition = vscode.window.activeTextEditor.selection.start;
            let lineBeginning = new vscode.Position(cursorPosition.line, 0);
            let offset = vscode.window.activeTextEditor.document.offsetAt(lineBeginning);
            socket.emit("ext-send-command", `fit|offset=${offset}`);
            console.log("extension sending command: " + `fit|offset=${offset}`);
        }));

    }).catch(function(error) {
        console.log("Failed to start socket server: " + error);
    });
}

// provider settings
function registerBrowserProvider(disposables: vscode.Disposable[]) {
    const provider = new BrowserContentProvider();
    const registration = vscode.workspace.registerTextDocumentContentProvider("http", provider);
    disposables.push(registration);
}