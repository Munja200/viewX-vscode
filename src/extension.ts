"use strict"
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from "vscode"
// import pythonShell module for executing python scripts
import * as pythonShell from "python-shell"
// import modules for web server preview
// import { BrowserContentProvider } from "./browserContentProvider";
import { PreviewServer } from "./preview-server";
import { Utility } from "./utility";
// import viewX configuration module
import { ViewXExtension } from "./viewXExtension"
// import socket.io client (must be imported like this in typescript)
import io from "socket.io-client"
// import socket server (communication proxy)
const socketserver = require('./socket-server');

// expose global variables
let viewXExtension: ViewXExtension;
let socket: any;

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

    // Use the console to output diagnostic information (console.log) and errors (console.error)
    // This line of code will only be executed once when your extension is activated
    console.log("Congratulations, your extension 'viewx-vscode' is now active!");

    let disposables: vscode.Disposable[] = [];
    viewXExtension = new ViewXExtension(context, disposables);

    startSocketServer(disposables);

    let pythonPath : string = vscode.Uri.file(`${viewXExtension.viewXVEnvPath}/Scripts/python`).fsPath;
                    
    if(process.platform ==='linux'){
        pythonPath = vscode.Uri.file(`${viewXExtension.viewXVEnvPath}/bin/python`).fsPath 
    }

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
                    viewXExtension.openModelPreview(() => { PreviewServer.reload(viewXExtension.projectName, viewXExtension.previewFileName); });
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
        if (document !== undefined && document.isClosed && document.uri.path === `/${viewXExtension.previewFileName}`) {
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
        // check if explorerUri is undefined (command palette) or empty object (keyboard shortcut is used)
        if (explorerUri === undefined || Object.keys(explorerUri).length === 0) {
            vscode.window.showInputBox({
                prompt: "Please insert a path where you want to setup a ViewX project",
                placeHolder: "Path to the project",
                ignoreFocusOut: true
            }).then(result => {
                if (result !== undefined) {
                    initProject(result);
                }
            });
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
                        pythonPath: pythonPath,
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
                    PreviewServer.reload(viewXExtension.projectName, viewXExtension.previewFileName);
                });
            });
        }
        else {
            vscode.window.showErrorMessage("There is no found viewX model that matches current file!");
        }
    }));

    disposables.push(vscode.commands.registerCommand("viewx.previewBrowser", () => {
        const uri = Utility.getUriOfPreviewHtml(viewXExtension.viewXProjectConfig);
        return vscode.commands.executeCommand("vscode.open", uri);
    }));

    disposables.push(vscode.commands.registerCommand("viewx.stopPreviewServer", () => {
        PreviewServer.stop(viewXExtension.projectName);
        vscode.window.showInformationMessage("Stop the PreviewServer successfully.");
    }));

    disposables.push(vscode.commands.registerCommand("viewx.resumePreviewServer", () => {
        viewXExtension.resumePreviewServer();
        vscode.window.showInformationMessage("Resume the PreviewServer.");
    }));

    disposables.push(vscode.commands.registerCommand("viewx.showUsedPorts", () => {
        let usedPorts: Array<number> = [];
        usedPorts.push(viewXExtension.viewXProjectConfig.project.previewServerPort);
        usedPorts.push(viewXExtension.viewXProjectConfig.project.previewServerPort + 1);
        usedPorts.push(viewXExtension.viewXProjectConfig.project.socketPort);
        vscode.window.showInformationMessage(`Ports used by this viewX instance: ${usedPorts}`);
    }));

    disposables.push(vscode.commands.registerCommand("viewx.generateSocketDebugger", () => {
        let pyScriptUri: vscode.Uri = vscode.Uri.file(`${viewXExtension.extensionPath}/out/python`);
        let scriptName: string = "socket_debugger_generator.py";
        let options = {
            mode: "text",
            pythonPath: pythonPath,
            // pythonOptions: ["-u"],
            // need to explicitly specify script path to be cross-platform functional
            scriptPath: pyScriptUri.fsPath,
            args: [viewXExtension.workspacePath, viewXExtension.viewXProjectConfig.project.socketPort]
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
                        let socketDebuggerUri = vscode.Uri.file(`${viewXExtension.workspacePath}/vxproj/js/socket-debugger.html`);
                        vscode.window.showInformationMessage(`Socket.IO debugger file successfuly generated at: ${socketDebuggerUri.fsPath}`);
                        let hostedDebuggerUri = vscode.Uri.parse(`http://localhost:${viewXExtension.viewXProjectConfig.project.previewServerPort}/js/socket-debugger.html`);
                        return vscode.commands.executeCommand("vscode.open", hostedDebuggerUri);
                    }
                });
            }

            // results is an array consisting of messages collected during execution
            // "success" is returned by the .py script
            else if (results && results.length > 0 && (results[0] as string).trim() === "success") {
                let socketDebuggerUri = vscode.Uri.file(`${viewXExtension.workspacePath}/vxproj/js/socket-debugger.html`);
                vscode.window.showInformationMessage(`Socket.IO debugger file successfuly generated at: ${socketDebuggerUri.fsPath}`);
                let hostedDebuggerUri = vscode.Uri.parse(`http://localhost:${viewXExtension.viewXProjectConfig.project.previewServerPort}/js/socket-debugger.html`);
                return vscode.commands.executeCommand("vscode.open", hostedDebuggerUri);
            }
        });
    }));

    // subscribe all commands
    disposables.forEach(disposable => {
        context.subscriptions.push(disposable);
    });
}

// this method is called when your extension is deactivated
export function deactivate() {
    PreviewServer.stop(viewXExtension.projectName);
}

function startSocketServer(disposables: vscode.Disposable[]) {
    // using socket port defined in viewX project config file
    let socketPort: number = undefined;
    if (viewXExtension.viewXProjectConfig !== undefined) {
        socketPort = viewXExtension.viewXProjectConfig.project.socketPort;
    }
    if (socketPort === undefined) {
        socketPort = viewXExtension.socketServerConfig.get("port") as number;
    }

    // start socket server asynchronously, promise is returned
    socketserver.startSocketServer(viewXExtension.workspacePath, socketPort).then(function(activeSocketPort) {
        viewXExtension.viewXProjectConfig.project.socketPort = activeSocketPort;
        console.log("connecting to socket server: " + `http://localhost:${activeSocketPort}`);

        // when port is determined for the socket server, we can connect to it and bind to an event
        socket = io(`http://localhost:${viewXExtension.viewXProjectConfig.project.socketPort}`);
        console.log("Ovo je than funkcija i socket1223 je :",socket, socket.connected)
        socket.on('connect_error', (error) => {
            console.error("Socket113 connection error:", error);
        });
        const debugMode = viewXExtension.socketServerConfig.get("debugMode");
        socket.emit("ext-room", debugMode);

        
        socket.on("ext-receive-command", function (command) {
            viewXExtension.interpretCommand(command);
        });
        socket.on('select-element-delete', function (data) {
        
            deleteTextFromOffsets(data.offset,data.offset_end);
            console.log("Primljeni su podaci is delete ja ovde sad primam i sve", data)
    
        });

        socket.on('select-element1', function (data) {

            selectTextAtOffset(data.offset,data.offset_end);
            console.log("Primljeni su podaci is extension1 ja ovde sad primam i sve", data)
    
        });
      
        // register command to push message to the socket server
       
    }).catch(function (error) {
        console.log("Failed to start socket server: " + error);
    });
}

function selectTextAtOffset(startOffset, endOffset) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage("Nema otvorenog editora.");
        return;
    }

    const document = editor.document;
    
    // Pretvori offset u poziciju (linija, kolona)
    const startPos = document.positionAt(startOffset);
    const endPos = document.positionAt(endOffset);

    // Napravi selekciju i postavi je
    const selection = new vscode.Selection(startPos, endPos);
    editor.selection = selection;

    // Fokusiraj editor (scroll do selekcije)
    editor.revealRange(new vscode.Range(startPos, endPos));
}


async function deleteTextFromOffsets(offsetStart, offsetEnd) {
    // Iterate over all open text editors
    const smEditor1 = vscode.window.visibleTextEditors.find(editor => {
        return editor.document.fileName.endsWith('.sm'); // Check if file ends with .sm
    });
    const smEditor = vscode.window.activeTextEditor;


    const document = smEditor.document;
    console.log("Ovde se sad brise ovaj ofset", offsetStart, "  ", offsetEnd)
    // Pretvori offset u poziciju (linija, kolona)
    const startPos = document.positionAt(offsetStart);
    const endPos = document.positionAt(offsetEnd);
    const selection = new vscode.Selection(startPos, endPos);
    smEditor.selection = selection;
    const editor = smEditor;


    if (editor) {
        // Proveri da li postoji selekcija
        const selection = editor.selection;

        if (!selection.isEmpty) {
            // Izvrši brisanje
            Promise.resolve(
                editor.edit(editBuilder => {
                    editBuilder.delete(selection);
                })
            ).then(success => {
                if (success) {
                    console.log('Text deleted successfully.');
                } else {
                    console.log('Failed to delete text.');
                }
            }).catch(error => {
                console.error('Error during edit:', error);
            });
        } else {
            console.log('No text selected to delete.');
        }
    } else {
        console.log('No active text editor found.');
    }
    
}