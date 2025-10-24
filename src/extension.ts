import * as vscode from 'vscode';
import { SfdxDeployGuard } from './deployGuard';
import { FileMonitor } from './fileMonitor';

export function activate(context: vscode.ExtensionContext) {
    console.log('SFDX Deploy Guard extension is now active');

    const deployGuard = new SfdxDeployGuard();
    const fileMonitor = new FileMonitor();

    // Register our custom deploy command with safety checks
    const deployWithCheckDisposable = vscode.commands.registerCommand(
        'sfdxDeployGuard.deployWithCheck',
        async (uri?: vscode.Uri) => {
            await deployGuard.handleDeployCommand(uri);
        }
    );

    context.subscriptions.push(deployWithCheckDisposable);
    context.subscriptions.push(fileMonitor);
}

export function deactivate() {
    console.log('SFDX Deploy Guard extension is now deactivated');
}
