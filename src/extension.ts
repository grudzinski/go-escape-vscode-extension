import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';

// file path -> line -> message
const escapeMap = new Map<string, Map<number, string>>();
const inlineMap = new Map<string, Map<number, string>>();
const devirtMap = new Map<string, Map<number, string>>();

let escapeDecoration: vscode.TextEditorDecorationType;
let inlineDecoration: vscode.TextEditorDecorationType;
let devirtDecoration: vscode.TextEditorDecorationType;

function createDecorations() {
    const cfg = vscode.workspace.getConfiguration('goEscape');
    escapeDecoration?.dispose();
    inlineDecoration?.dispose();
    devirtDecoration?.dispose();
    escapeDecoration = vscode.window.createTextEditorDecorationType({
        backgroundColor: cfg.get<string>('escapeColor', 'rgba(255, 160, 0, 0.07)'),
        isWholeLine: true,
    });
    inlineDecoration = vscode.window.createTextEditorDecorationType({
        backgroundColor: cfg.get<string>('inlineColor', 'rgba(100, 180, 255, 0.07)'),
        isWholeLine: true,
    });
    devirtDecoration = vscode.window.createTextEditorDecorationType({
        backgroundColor: cfg.get<string>('devirtColor', 'rgba(100, 220, 120, 0.07)'),
        isWholeLine: true,
    });
}

function runAnalysis(fileDir: string, workspaceRoot: string): Promise<void> {
    return new Promise((resolve) => {
        cp.exec('go build -gcflags="-m" -o /dev/null ./...', { cwd: workspaceRoot }, (_err: Error | null, _stdout: string, stderr: string) => {
            // Format: ./path/file.go:LINE:COL: VAR escapes to heap
            const reEscape = /^(.+?):(\d+):\d+: (.+ escapes to heap)/gm;
            let m: RegExpExecArray | null;
            while ((m = reEscape.exec(stderr)) !== null) {
                const absPath = path.resolve(workspaceRoot, m[1]);
                const lineNum = parseInt(m[2]) - 1; // 0-based
                if (!escapeMap.has(absPath)) { escapeMap.set(absPath, new Map()); }
                escapeMap.get(absPath)!.set(lineNum, m[3]);
            }

            // Format: ./path/file.go:LINE:COL: inlining call to Func
            const reInline = /^(.+?):(\d+):\d+: (inlining call to .+)/gm;
            while ((m = reInline.exec(stderr)) !== null) {
                const absPath = path.resolve(workspaceRoot, m[1]);
                const lineNum = parseInt(m[2]) - 1;
                if (!inlineMap.has(absPath)) { inlineMap.set(absPath, new Map()); }
                inlineMap.get(absPath)!.set(lineNum, m[3]);
            }

            // Format: ./path/file.go:LINE:COL: devirtualizing x.Method to *ConcreteType
            const reDevirt = /^(.+?):(\d+):\d+: (devirtualizing .+)/gm;
            while ((m = reDevirt.exec(stderr)) !== null) {
                const absPath = path.resolve(workspaceRoot, m[1]);
                const lineNum = parseInt(m[2]) - 1;
                if (!devirtMap.has(absPath)) { devirtMap.set(absPath, new Map()); }
                devirtMap.get(absPath)!.set(lineNum, m[3]);
            }

            resolve();
        });
    });
}

function applyDecorations(editor: vscode.TextEditor) {
    const filePath = editor.document.uri.fsPath;
    const cfg = vscode.workspace.getConfiguration('goEscape');

    const escapeLineMap = escapeMap.get(filePath);
    const escapeDecos: vscode.DecorationOptions[] = [];
    if (cfg.get<boolean>('enableEscapeHighlight', true) && escapeLineMap) {
        for (const [lineNum, msg] of escapeLineMap) {
            if (lineNum >= editor.document.lineCount) continue;
            escapeDecos.push({ range: editor.document.lineAt(lineNum).range, hoverMessage: msg });
        }
    }
    editor.setDecorations(escapeDecoration, escapeDecos);

    const inlineLineMap = inlineMap.get(filePath);
    const inlineDecos: vscode.DecorationOptions[] = [];
    if (cfg.get<boolean>('enableInlineHighlight', true) && inlineLineMap) {
        for (const [lineNum, msg] of inlineLineMap) {
            if (lineNum >= editor.document.lineCount) continue;
            inlineDecos.push({ range: editor.document.lineAt(lineNum).range, hoverMessage: msg });
        }
    }
    editor.setDecorations(inlineDecoration, inlineDecos);

    const devirtLineMap = devirtMap.get(filePath);
    const devirtDecos: vscode.DecorationOptions[] = [];
    if (cfg.get<boolean>('enableDevirtHighlight', true) && devirtLineMap) {
        for (const [lineNum, msg] of devirtLineMap) {
            if (lineNum >= editor.document.lineCount) continue;
            devirtDecos.push({ range: editor.document.lineAt(lineNum).range, hoverMessage: msg });
        }
    }
    editor.setDecorations(devirtDecoration, devirtDecos);
}

async function analyze(document: vscode.TextDocument) {
    if (document.languageId !== 'go') return;

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!workspaceFolder) return;

    const workspaceRoot = workspaceFolder.uri.fsPath;
    const fileDir = path.dirname(document.uri.fsPath);

    escapeMap.clear();
    inlineMap.clear();
    devirtMap.clear();

    await runAnalysis(fileDir, workspaceRoot);

    for (const editor of vscode.window.visibleTextEditors) {
        if (editor.document.languageId === 'go') {
            applyDecorations(editor);
        }
    }
}

export function activate(context: vscode.ExtensionContext) {
    createDecorations();

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('goEscape.escapeColor') || e.affectsConfiguration('goEscape.inlineColor') ||
                e.affectsConfiguration('goEscape.devirtColor') || e.affectsConfiguration('goEscape.enableEscapeHighlight') ||
                e.affectsConfiguration('goEscape.enableInlineHighlight') || e.affectsConfiguration('goEscape.enableDevirtHighlight')) {
                createDecorations();
                for (const editor of vscode.window.visibleTextEditors) {
                    if (editor.document.languageId === 'go') {
                        applyDecorations(editor);
                    }
                }
            }
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument((doc) => analyze(doc))
    );

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor) applyDecorations(editor);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('goEscape.analyze', () => {
            const editor = vscode.window.activeTextEditor;
            if (editor) analyze(editor.document);
        })
    );

    if (vscode.window.activeTextEditor?.document.languageId === 'go') {
        analyze(vscode.window.activeTextEditor.document);
    }
}

export function deactivate() {
    escapeDecoration?.dispose();
    inlineDecoration?.dispose();
    devirtDecoration?.dispose();
}
