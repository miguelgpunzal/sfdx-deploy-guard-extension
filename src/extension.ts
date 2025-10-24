import * as vscode from 'vscode';
import { SfdxDeployGuard } from './deployGuard';

export function activate(context: vscode.ExtensionContext) {
    console.log('SFDX Deploy Guard extension is now active');

    const deployGuard = new SfdxDeployGuard();

    // Register our custom deploy command with safety checks
    const deployWithCheckDisposable = vscode.commands.registerCommand(
        'sfdxDeployGuard.deployWithCheck',
        async (uri?: vscode.Uri) => {
            await deployGuard.handleDeployCommand(uri);
        }
    );

    context.subscriptions.push(deployWithCheckDisposable);
}

export function deactivate() {
    console.log('SFDX Deploy Guard extension is now deactivated');
}
