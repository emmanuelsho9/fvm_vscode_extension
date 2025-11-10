// @ts-nocheck
const vscode = require("vscode");
const { exec, execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

/** Run shell command sync */
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

/** Parse FVM list reliably */
function parseFvmList() {
  const raw = run('fvm list | sed -E "s/\\x1B\\[[0-9;]*[a-zA-Z]//g"');
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("FVM") && !l.startsWith("⚙️"))
    .map((l) => {
      const match = l.match(/│\s*([^│]+)\s*│/);
      const name = match ? match[1].trim() : l.replace(" (global)", "").trim();
      const isGlobal = l.includes(" (global)") || l.includes("●");
      return { name, isGlobal };
    })
    .filter((v) => v.name);
}

/** Activate extension */
function activate(context) {
  // ---------- Status Bar ----------
  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  statusBar.text = "$(flutter) FVM";
  statusBar.command = "fvm.useVersion";
  statusBar.show();
  context.subscriptions.push(statusBar);

  function refreshStatus() {
    try {
      const list = parseFvmList();
      const global = list.find((v) => v.isGlobal);
      statusBar.text = global
        ? `$(flutter) FVM ${global.name}`
        : "$(flutter) FVM";
    } catch {
      statusBar.text = "$(flutter) FVM";
    }
  }
  refreshStatus();

// ---------- FVM Sidebar ----------
 const provider = vscode.window.registerWebviewViewProvider("fvm.commands", {
    resolveWebviewView(view) {
      view.webview.options = { enableScripts: true };
      view.webview.html = getHtml();
      view.webview.onDidReceiveMessage((msg) => {
        // 🟢 FIX: Execute the registered command ID instead of calling the function directly.
        switch (msg.command) {
          case "newProject":
            vscode.commands.executeCommand("fvm.newProject");
            break;
          case "useVersion":
            vscode.commands.executeCommand("fvm.useVersion");
            break;
          case "installVersion":
            vscode.commands.executeCommand("fvm.installVersion");
            break;
          case "removeVersion":
            vscode.commands.executeCommand("fvm.removeVersion");
            break;
          case "global":
            vscode.commands.executeCommand("fvm.global");
            break;
          case "list":
            vscode.commands.executeCommand("fvm.list");
            break;
          case "buildApk":
            // Note: 'buildApk' is a local function, not a registered command. 
            // It's safe to call it directly IF it was in scope, but 
            // for consistency and to avoid scope issues, it's better to register it.
            // Since it's a local function defined just above, we'll keep the direct call 
            // but ensure 'buildApk' is defined before this block.
            buildApk(); 
            break;
          case "run":
            // Same as above, 'runFlutter' is a local function.
            runFlutter();
            break;
          default:
            vscode.window.showInformationMessage(`Unknown command: ${msg.command}`);
        }
      });
    },
  });
  // ----------------- Commands -----------------

  const cmdNewProject = vscode.commands.registerCommand(
    "fvm.newProject",
    async () => {
      try {
        const name = await vscode.window.showInputBox({
          prompt: "Project name",
        });
        if (!name) return;

        const folder = await vscode.window.showOpenDialog({
          canSelectFolders: true,
          openLabel: "Select parent folder",
        });
        if (!folder) return;

        const projectPath = path.join(folder[0].fsPath, name);

        // Get FVM versions
        let versions = [];
        try {
          const raw = run("fvm list");
          const clean = raw.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
          const lines = clean
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l && !l.startsWith("FVM") && !l.startsWith("⚙️"));

          versions = lines
            .map((l) => {
              let cleaned = l.replace(/[│]/g, "").trim();
              const parts = cleaned.split(/\s+/);
              const versionMatch = parts.find((p) => /^\d+\.\d+\.\d+$/.test(p));
              if (!versionMatch) return null;
              const isGlobal =
                cleaned.includes("●") || cleaned.includes("(global)");
              return {
                label: versionMatch,
                description: isGlobal ? "global" : "",
                version: versionMatch,
              };
            })
            .filter(Boolean);
        } catch {
          vscode.window.showErrorMessage(
            "FVM not installed or unable to read versions."
          );
          return;
        }

        if (!versions.length) {
          vscode.window.showErrorMessage(
            "No FVM versions found. Install Flutter versions first."
          );
          return;
        }

        const pick = await vscode.window.showQuickPick(versions, {
          placeHolder: "Select Flutter version for this project",
        });
        if (!pick) return;

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Creating ${name} with Flutter ${pick.version}…`,
          },
          () =>
            new Promise((resolve, reject) => {
              exec(
                `fvm flutter create "${projectPath}"`,
                { encoding: "utf8" },
                (err, stdout, stderr) => {
                  if (err) reject(new Error(err.message + "\n" + stderr));
                  else resolve(stdout);
                }
              );
            })
        );

        // Set FVM version
        try {
          await new Promise((resolve, reject) => {
            exec(
              `fvm use ${pick.version}`,
              { cwd: projectPath, encoding: "utf8" },
              (err, stdout, stderr) => {
                if (err) reject(new Error(err.message + "\n" + stderr));
                else resolve(stdout);
              }
            );
          });
        } catch (e) {
          console.error(e);
          vscode.window.showErrorMessage(
            `Failed to set FVM version: ${e.message}`
          );
          return;
        }

        const open = await vscode.window.showInformationMessage(
          `Project "${name}" created with Flutter ${pick.version}! Open folder?`,
          "Yes",
          "No"
        );
        if (open === "Yes") {
          await vscode.commands.executeCommand(
            "vscode.openFolder",
            vscode.Uri.file(projectPath),
            { forceNewWindow: true }
          );
        }
      } catch (e) {
        console.error(e);
        vscode.window.showErrorMessage(`Failed: ${e.message}`);
      }
    }
  );

  const cmdUseVersion = vscode.commands.registerCommand(
    "fvm.useVersion",
    async () => {
      const ws = vscode.workspace.workspaceFolders?.[0];
      if (!ws) return vscode.window.showErrorMessage("Open a folder first");

      let versions;
      try {
        versions = parseFvmList();
      } catch {
        return vscode.window.showErrorMessage("FVM not installed");
      }

      const items = versions.map((v) => ({
        label: v.name,
        detail: v.isGlobal ? "global" : "",
        version: v.name,
      }));
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: "Select FVM version to use for this project",
      });
      if (!pick) return;

      try {
        run(`fvm use ${pick.version}`, ws.uri.fsPath);
        vscode.window.showInformationMessage(`FVM using ${pick.version}`);
        refreshStatus();
      } catch (e) {
        vscode.window.showErrorMessage(`Failed: ${e.message}`);
      }
    }
  );

  const cmdInstallVersion = vscode.commands.registerCommand(
    "fvm.installVersion",
    async () => {
      const ver = await vscode.window.showInputBox({
        prompt: "Flutter version (e.g. 3.35.7, stable)",
      });
      if (!ver) return;

      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Installing ${ver}…`,
          },
          () =>
            new Promise((resolve, reject) => {
              exec(
                `fvm install ${ver}`,
                { encoding: "utf8" },
                (err, stdout, stderr) => {
                  if (err) reject(new Error(err.message + "\n" + stderr));
                  else resolve(stdout);
                }
              );
            })
        );
        vscode.window.showInformationMessage(`${ver} installed`);
        refreshStatus();
      } catch (e) {
        vscode.window.showErrorMessage(`Failed: ${e.message}`);
      }
    }
  );

  const cmdRemoveVersion = vscode.commands.registerCommand(
    "fvm.removeVersion",
    async () => {
      let versions;
      try {
        versions = parseFvmList();
      } catch {
        return vscode.window.showErrorMessage("FVM list failed");
      }

      const items = versions.map((v) => ({ label: v.name, version: v.name }));
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: "Select version to remove",
      });
      if (!pick) return;

      try {
        run(`fvm remove ${pick.version}`);
        vscode.window.showInformationMessage(`${pick.version} removed`);
        refreshStatus();
      } catch (e) {
        vscode.window.showErrorMessage(`Failed: ${e.message}`);
      }
    }
  );

  const cmdList = vscode.commands.registerCommand("fvm.list", () => {
    try {
      const out = run("fvm list");
      const panel = vscode.window.createOutputChannel("FVM List");
      panel.clear();
      panel.append(out);
      panel.show();
    } catch {
      vscode.window.showErrorMessage("FVM not installed");
    }
  });

  const cmdGlobal = vscode.commands.registerCommand("fvm.global", async () => {
    let versions;
    try {
      versions = parseFvmList();
    } catch {
      return vscode.window.showErrorMessage("FVM list failed");
    }

    const items = versions.map((v) => ({ label: v.name, version: v.name }));
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: "Select global version",
    });
    if (!pick) return;

    try {
      run(`fvm global ${pick.version}`);
      vscode.window.showInformationMessage(`Global → ${pick.version}`);
      refreshStatus();
    } catch (e) {
      vscode.window.showErrorMessage(`Failed: ${e.message}`);
    }
  });

  // ---------- Build APK ----------
  async function buildApk() {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) return vscode.window.showErrorMessage("Open a Flutter project");

    vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Building APK...",
      },
      () =>
        new Promise((resolve, reject) => {
          exec(
            "fvm flutter build apk --release",
            { cwd: ws.uri.fsPath, encoding: "utf8" },
            (err, stdout, stderr) => {
              if (err) reject(stderr || err.message);
              else {
                vscode.window.showInformationMessage("APK build complete!");
                resolve(stdout);
              }
            }
          );
        })
    );
  }

  // ---------- Run Flutter ----------
  async function runFlutter() {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) return vscode.window.showErrorMessage("Open a Flutter project");

    const term = vscode.window.createTerminal({
      name: "Flutter Run",
      cwd: ws.uri.fsPath,
    });
    term.show();
    term.sendText("fvm flutter run");
  }

  // ---------- Sidebar HTML ----------
  function getHtml() {
    return `
      <html>
        <body style="font-family: sans-serif;">
          <h3>FVM Tools</h3>
          <button onclick="send('newProject')">New Project</button><br/>
          <button onclick="send('useVersion')">Use Version</button><br/>
          <button onclick="send('installVersion')">Install Version</button><br/>
          <button onclick="send('removeVersion')">Remove Version</button><br/>
          <button onclick="send('global')">Set Global</button><br/>
          <button onclick="send('list')">List Versions</button>
          <hr>
          <button onclick="send('buildApk')">Build APK (Release)</button><br/>
          <button onclick="send('run')">Run Flutter</button>
          <script>
            const vscode = acquireVsCodeApi();
            function send(command) { vscode.postMessage({ command }); }
          </script>
        </body>
      </html>
    `;
  }

  // ---------- Register all commands ----------
  context.subscriptions.push(
    cmdNewProject,
    cmdUseVersion,
    cmdInstallVersion,
    cmdRemoveVersion,
    cmdList,
    cmdGlobal,
    provider
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
