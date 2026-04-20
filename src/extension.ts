import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as readline from 'readline';

interface Kind {
    re: RegExp;
    map: Map<string, Map<number, string>>; // file path -> line -> message
    colorKey: string;
    enableKey: string;
    defaultColor: string;
    decoration?: vscode.TextEditorDecorationType;
}

const kinds: Kind[] = [
    {
        re: /^(.+?):(\d+):\d+: (.+ escapes to heap)/,
        map: new Map(),
        colorKey: 'goEscape.escapeColor',
        enableKey: 'goEscape.enableEscapeHighlight',
        defaultColor: 'rgba(255, 160, 0, 0.04)',
    },
    {
        re: /^(.+?):(\d+):\d+: (inlining call to .+)/,
        map: new Map(),
        colorKey: 'goEscape.inlineColor',
        enableKey: 'goEscape.enableInlineHighlight',
        defaultColor: 'rgba(100, 180, 255, 0.04)',
    },
    {
        re: /^(.+?):(\d+):\d+: (devirtualizing .+)/,
        map: new Map(),
        colorKey: 'goEscape.devirtColor',
        enableKey: 'goEscape.enableDevirtHighlight',
        defaultColor: 'rgba(100, 220, 120, 0.04)',
    },
];

function createDecorations() {
    const cfg = vscode.workspace.getConfiguration();
    for (const k of kinds) {
        k.decoration?.dispose();
        k.decoration = vscode.window.createTextEditorDecorationType({
            backgroundColor: cfg.get<string>(k.colorKey, k.defaultColor),
            isWholeLine: true,
        });
    }
}

function runAnalysis(workspaceRoot: string): Promise<void> {
    return new Promise((resolve) => {
        const proc = cp.spawn('go', ['build', '-gcflags=-m', '-o', '/dev/null', './...'], { cwd: workspaceRoot });
        const rl = readline.createInterface({ input: proc.stderr });
        let lastRel = '';
        let lastAbs = '';
        rl.on('line', (line: string) => {
            for (const k of kinds) {
                const m = k.re.exec(line);
                if (!m) {
                    continue;
                }
                if (m[1] !== lastRel) {
                    lastRel = m[1];
                    lastAbs = path.resolve(workspaceRoot, m[1]);
                }
                const lineNum = parseInt(m[2]) - 1; // 0-based
                let fileMap = k.map.get(lastAbs);
                if (!fileMap) {
                    fileMap = new Map();
                    k.map.set(lastAbs, fileMap);
                }
                fileMap.set(lineNum, m[3]);
                return;
            }
        });
        proc.on('error', (err: Error) => {
            vscode.window.showErrorMessage(`go-escape: ${err.message}`);
            resolve();
        });
        proc.on('close', () => resolve());
    });
}

function buildDecorationOptions(editor: vscode.TextEditor, lineMap: Map<number, string>): vscode.DecorationOptions[] {
    const doc = editor.document;
    const options: vscode.DecorationOptions[] = [];
    for (const [lineNum, msg] of lineMap) {
        if (lineNum >= doc.lineCount) {
            continue;
        }
        const line = doc.lineAt(lineNum);
        options.push({
            range: line.range,
            hoverMessage: msg,
        });
    }
    return options;
}

function onConfigChanged(e: vscode.ConfigurationChangeEvent) {
    const configChanged = kinds.some(k =>
        e.affectsConfiguration(k.colorKey) ||
        e.affectsConfiguration(k.enableKey)
    );
    if (!configChanged) {
        return;
    }
    createDecorations();
    for (const editor of vscode.window.visibleTextEditors) {
        if (editor.document.languageId === 'go') {
            applyDecorations(editor);
        }
    }
}

function onActiveEditorChanged(editor: vscode.TextEditor | undefined) {
    if (!editor) {
        return;
    }
    const filePath = editor.document.uri.fsPath;
    const hasData = kinds.some(k => k.map.has(filePath));
    if (hasData) {
        applyDecorations(editor);
        return;
    }
    analyze(editor.document);
}

function onDocumentChanged(e: vscode.TextDocumentChangeEvent) {
    if (!e.document.isDirty) {
        analyze(e.document);
    }
}

function onAnalyzeCommand() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return;
    }
    analyze(editor.document);
}

function applyDecorations(editor: vscode.TextEditor) {
    const filePath = editor.document.uri.fsPath;
    const cfg = vscode.workspace.getConfiguration();
    for (const k of kinds) {
        if (!cfg.get<boolean>(k.enableKey, true)) {
            continue;
        }
        const lineMap = k.map.get(filePath);
        if (!lineMap) {
            continue;
        }
        const options = buildDecorationOptions(editor, lineMap);
        editor.setDecorations(k.decoration!, options);
    }
}

async function analyze(document: vscode.TextDocument) {
    const isGo = document.languageId === 'go';
    const isGoMod = document.fileName.endsWith('go.mod');
    if (!isGo && !isGoMod) {
        return;
    }
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!workspaceFolder) {
        return;
    }
    for (const k of kinds) {
        k.map.clear();
    }
    await runAnalysis(workspaceFolder.uri.fsPath);
    for (const editor of vscode.window.visibleTextEditors) {
        if (editor.document.languageId === 'go') {
            applyDecorations(editor);
        }
    }
}

export function activate(context: vscode.ExtensionContext) {
    createDecorations();
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(onConfigChanged),
        vscode.workspace.onDidSaveTextDocument(analyze),
        vscode.workspace.onDidChangeTextDocument(onDocumentChanged),
        vscode.window.onDidChangeActiveTextEditor(onActiveEditorChanged),
        vscode.commands.registerCommand('goEscape.analyze', onAnalyzeCommand),
    );
    const goDoc = vscode.workspace.textDocuments.find(d => d.languageId === 'go');
    if (goDoc) {
        analyze(goDoc);
    }
}

export function deactivate() {
    for (const k of kinds) {
        k.decoration?.dispose();
    }
}
