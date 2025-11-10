// @ts-nocheck
// src/extension.js
const vscode = require("vscode");
const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

/** Run a shell command (utf-8) */
function run(cmd, cwd) {
  return execSync(cmd, { encoding: "utf8", cwd });
}

/** Detect current Android package id */
function detectPackageId(root) {
  const gradle = path.join(root, "android", "app", "build.gradle");
  if (fs.existsSync(gradle)) {
    const content = fs.readFileSync(gradle, "utf8");
    const m = content.match(/applicationId\s+["']([^"']+)["']/);
    if (m) return m[1];
  }
  return "com.example.myapp";
}

/** Extension entry point */
function activate(context) {
  // ---------- Status bar ----------
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.text = "$(flutter) FVM";
  statusBar.command = "fvm.useVersion";
  statusBar.show();
  context.subscriptions.push(statusBar);

  function refreshStatus() {
    try {
      const list = JSON.parse(run("fvm list --machine"));
      const global = list.find(v => v.isGlobal);
      statusBar.text = global ? `$(flutter) FVM ${global.name}` : "$(flutter) FVM";
    } catch {
      statusBar.text = "$(flutter) FVM";
    }
  }
  refreshStatus();

  // ---------- New Project ----------
  const cmdNewProject = vscode.commands.registerCommand("fvm.newProject", async () => {
    const name = await vscode.window.showInputBox({ prompt: "Project name" });
    if (!name) return;

    const folder = await vscode.window.showOpenDialog({ canSelectFolders: true, openLabel: "Select parent folder" });
    if (!folder) return;

    const projectPath = path.join(folder[0].fsPath, name);

    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Creating ${name}…` },
        () => run(`fvm flutter create "${projectPath}"`)
      );

      const open = await vscode.window.showInformationMessage("Project created! Open folder?", "Yes", "No");
      if (open === "Yes") {
        vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(projectPath));
      }
    } catch (e) {
      vscode.window.showErrorMessage(`Failed: ${e.message}`);
    }
  });

  // ---------- Use Version ----------
  const cmdUseVersion = vscode.commands.registerCommand("fvm.useVersion", async () => {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) { vscode.window.showErrorMessage("Open a folder first"); return; }

    let versions;
    try { versions = JSON.parse(run("fvm list --machine")); }
    catch { vscode.window.showErrorMessage("FVM not installed"); return; }

    const items = versions.map(v => ({
      label: v.name,
      description: v.channel,
      detail: v.isGlobal ? "global" : "",
      version: v.name
    }));

    const pick = await vscode.window.showQuickPick(items, { placeHolder: "Select FVM version" });
    if (!pick) return;

    try {
      run(`fvm use ${pick.version}`, ws.uri.fsPath);
      vscode.window.showInformationMessage(`FVM using ${pick.version}`);
      refreshStatus();
    } catch (e) {
      vscode.window.showErrorMessage(`Failed: ${e.message}`);
    }
  });

  // ---------- Install Version ----------
  const cmdInstall = vscode.commands.registerCommand("fvm.installVersion", async () => {
    const ver = await vscode.window.showInputBox({ prompt: "Flutter version (e.g. 3.35.7, stable)" });
    if (!ver) return;

    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Installing ${ver}…` },
        () => run(`fvm install ${ver}`)
      );
      vscode.window.showInformationMessage(`${ver} installed`);
      refreshStatus();
    } catch (e) {
      vscode.window.showErrorMessage(`Failed: ${e.message}`);
    }
  });

  // ---------- Remove Version ----------
  const cmdRemove = vscode.commands.registerCommand("fvm.removeVersion", async () => {
    let versions;
    try { versions = JSON.parse(run("fvm list --machine")); }
    catch { vscode.window.showErrorMessage("FVM list failed"); return; }

    const items = versions.map(v => ({ label: v.name, version: v.name }));
    const pick = await vscode.window.showQuickPick(items, { placeHolder: "Select version to remove" });
    if (!pick) return;

    try {
      run(`fvm remove ${pick.version}`);
      vscode.window.showInformationMessage(`${pick.version} removed`);
      refreshStatus();
    } catch (e) {
      vscode.window.showErrorMessage(`Failed: ${e.message}`);
    }
  });

  // ---------- List Versions ----------
  const cmdList = vscode.commands.registerCommand("fvm.list", () => {
    try {
      const out = run("fvm list");
      const panel = vscode.window.createOutputChannel("FVM List");
      panel.clear(); panel.append(out); panel.show();
    } catch {
      vscode.window.showErrorMessage("FVM not installed");
    }
  });

  // ---------- Set Global ----------
  const cmdGlobal = vscode.commands.registerCommand("fvm.global", async () => {
    let versions;
    try { versions = JSON.parse(run("fvm list --machine")); }
    catch { vscode.window.showErrorMessage("FVM list failed"); return; }

    const items = versions.map(v => ({ label: v.name, version: v.name }));
    const pick = await vscode.window.showQuickPick(items, { placeHolder: "Select global version" });
    if (!pick) return;

    try {
      run(`fvm global ${pick.version}`);
      vscode.window.showInformationMessage(`Global → ${pick.version}`);
      refreshStatus();
    } catch (e) {
      vscode.window.showErrorMessage(`Failed: ${e.message}`);
    }
  });

  // ---------- Rename Package ID ----------
  const cmdRename = vscode.commands.registerCommand("fvm.renamePackage", async () => {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) { vscode.window.showErrorMessage("Open a Flutter project"); return; }

    const root = ws.uri.fsPath;
    const oldId = detectPackageId(root);
    const newId = await vscode.window.showInputBox({ prompt: "New package ID", value: oldId });
    if (!newId || newId === oldId) return;

    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Renaming to ${newId}…` },
        () => {
          // Android
          const gradle = path.join(root, "android", "app", "build.gradle");
          if (fs.existsSync(gradle)) {
            let c = fs.readFileSync(gradle, "utf8");
            c = c.replace(/applicationId\s+["'][^"']+["']/, `applicationId "${newId}"`);
            fs.writeFileSync(gradle, c);
          }

          // iOS
          const pbx = path.join(root, "ios", "Runner.xcodeproj", "project.pbxproj");
          if (fs.existsSync(pbx)) {
            let c = fs.readFileSync(pbx, "utf8");
            c = c.replace(/PRODUCT_BUNDLE_IDENTIFIER\s*=\s*[^;]+;/g, `PRODUCT_BUNDLE_IDENTIFIER = ${newId};`);
            fs.writeFileSync(pbx, c);
          }

          // pubspec.yaml
          const pub = path.join(root, "pubspec.yaml");
          if (fs.existsSync(pub)) {
            let c = fs.readFileSync(pub, "utf8");
            const name = newId.split(".").pop();
            c = c.replace(/^name:\s*.+$/m, `name: ${name}`);
            fs.writeFileSync(pub, c);
          }
        }
      );
      vscode.window.showInformationMessage(`Package ID → ${newId}`);
    } catch (e) {
      vscode.window.showErrorMessage(`Failed: ${e.message}`);
    }
  });

  // Register everything
  context.subscriptions.push(
    cmdNewProject, cmdUseVersion, cmdInstall,
    cmdRemove, cmdList, cmdGlobal, cmdRename
  );
}

function deactivate() {}

module.exports = { activate, deactivate };