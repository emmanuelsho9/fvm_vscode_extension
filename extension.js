// @ts-nocheck
// src/extension.js
const vscode = require("vscode");
const { exec, execSync } = require("child_process");
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

// -------------------------------------------------------------------
// 🔥 NEW: Helper function for parsing FVM list output (used by multiple commands)
// -------------------------------------------------------------------
function parseFvmList() {
  const raw = run('fvm list | sed -E "s/\\x1B\\[[0-9;]*[a-zA-Z]//g"'); // Run fvm list and strip ANSI color codes
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    // Filter out empty lines and headers
    .filter((l) => l && !l.startsWith("⚙️") && !l.startsWith("FVM"));

  const versions = lines
    .map((l) => {
      // Extract only the version name (the text between the first two '│' characters)
      const match = l.match(/│\s*([^│]+)\s*│/);
      const versionName = match
        ? match[1].trim()
        : l.replace(" (global)", "").trim();

      // Determine if it's the current global version (marked by '●' in output)
      const isGlobal = l.includes(" (global)") || l.includes("●");

      return {
        name: versionName,
        channel: null,
        isGlobal: isGlobal,
      };
    })
    .filter((v) => v.name); // Filter out any empty names that might sneak in

  return versions;
}

/** Extension entry point */
function activate(context) {
  // ---------- Status bar ----------
  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  statusBar.text = "$(flutter) FVM";
  statusBar.command = "fvm.useVersion";
  statusBar.show();
  context.subscriptions.push(statusBar);

  // -------------------------------------------------------------------
  // 🔥 FIX: refreshStatus now uses the reliable parseFvmList helper
  // -------------------------------------------------------------------
  function refreshStatus() {
    try {
      const list = parseFvmList();
      // Find the version currently marked as global
      const global = list.find((v) => v.isGlobal);
      statusBar.text = global
        ? `$(flutter) FVM ${global.name}`
        : "$(flutter) FVM";
    } catch {
      statusBar.text = "$(flutter) FVM";
    }
  }
  refreshStatus();

  // ---------- New Project (Your confirmed working version) ----------
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
              // Remove all table-like characters
              let cleaned = l.replace(/[│]/g, "").trim();

              // Split by whitespace and take the last valid version number (common FVM table layout)
              const parts = cleaned.split(/\s+/);
              // Look for something like 3.35.7 (digit.digit.digit)
              const versionMatch = parts.find((p) => /^\d+\.\d+\.\d+$/.test(p));
              if (!versionMatch) return null;

              const isGlobal =
                cleaned.includes("●") || cleaned.includes("(global)");
              return {
                label: versionMatch,
                description: isGlobal ? "global" : "",
                version: versionMatch, // <- this is now correct for fvm use
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

        // Select version
        const pick = await vscode.window.showQuickPick(versions, {
          placeHolder: "Select Flutter version for this project",
        });
        if (!pick) return;

        // Create project
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
        // Ask to open project
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
        console.error(e + "checking...");
        vscode.window.showErrorMessage(`Failed: ${e.message}`);
      }
    }
  );

  // ---------- Use Version ----------
  const cmdUseVersion = vscode.commands.registerCommand(
    "fvm.useVersion",
    async () => {
      const ws = vscode.workspace.workspaceFolders?.[0];
      if (!ws) {
        vscode.window.showErrorMessage("Open a folder first");
        return;
      }

      let versions;
      try {
        versions = parseFvmList(); // 🔥 FIX: Use reliable parsing
      } catch {
        vscode.window.showErrorMessage("FVM not installed");
        return;
      }

      const items = versions.map((v) => ({
        label: v.name,
        description: v.channel,
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

  // ---------- Install Version (Using synchronous run - consider converting to async exec for long tasks) ----------
  const cmdInstall = vscode.commands.registerCommand(
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
          // For installation, use ASYNC exec wrapped in a Promise to prevent UI freezing
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

  // ---------- Remove Version ----------
  const cmdRemove = vscode.commands.registerCommand(
    "fvm.removeVersion",
    async () => {
      let versions;
      try {
        versions = parseFvmList(); // 🔥 FIX: Use reliable parsing
      } catch {
        vscode.window.showErrorMessage("FVM list failed");
        return;
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

  // ---------- List Versions ----------
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

  // ---------- Set Global ----------
  const cmdGlobal = vscode.commands.registerCommand("fvm.global", async () => {
    let versions;
    try {
      versions = parseFvmList(); // 🔥 FIX: Use reliable parsing
    } catch {
      vscode.window.showErrorMessage("FVM list failed");
      return;
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

  // ---------- Rename Package ID (No change needed) ----------
  const cmdRename = vscode.commands.registerCommand(
    "fvm.renamePackage",
    async () => {
      const ws = vscode.workspace.workspaceFolders?.[0];
      if (!ws) {
        vscode.window.showErrorMessage("Open a Flutter project");
        return;
      }

      const root = ws.uri.fsPath;
      const oldId = detectPackageId(root);
      const newId = await vscode.window.showInputBox({
        prompt: "New package ID",
        value: oldId,
      });
      if (!newId || newId === oldId) return;

      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Renaming to ${newId}…`,
          },
          () => {
            // Android
            const gradle = path.join(root, "android", "app", "build.gradle");
            if (fs.existsSync(gradle)) {
              let c = fs.readFileSync(gradle, "utf8");
              c = c.replace(
                /applicationId\s+["'][^"']+["']/,
                `applicationId "${newId}"`
              );
              fs.writeFileSync(gradle, c);
            }

            // iOS
            const pbx = path.join(
              root,
              "ios",
              "Runner.xcodeproj",
              "project.pbxproj"
            );
            if (fs.existsSync(pbx)) {
              let c = fs.readFileSync(pbx, "utf8");
              c = c.replace(
                /PRODUCT_BUNDLE_IDENTIFIER\s*=\s*[^;]+;/g,
                `PRODUCT_BUNDLE_IDENTIFIER = ${newId};`
              );
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
    }
  );

  // Register everything
  context.subscriptions.push(
    cmdNewProject,
    cmdUseVersion,
    cmdInstall,
    cmdRemove,
    cmdList,
    cmdGlobal,
    cmdRename
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
