import * as vscode from 'vscode';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

interface MetadataInfo {
    type: string;
    apiName: string;
    filePath: string;
}

interface LastModifiedInfo {
    name: string;
    id: string;
    date: string;
}

export class FileMonitor implements vscode.Disposable {
    private statusBarItem: vscode.StatusBarItem;
    private decorationType: vscode.TextEditorDecorationType;
    private pollInterval: NodeJS.Timeout | undefined;
    private currentEditor: vscode.TextEditor | undefined;
    private lastKnownModifier: LastModifiedInfo | null = null;
    private currentUserId: string = '';
    private isUserEditing: boolean = false;
    private editingTimeout: NodeJS.Timeout | undefined;
    private pollCountAfterEdit: number = 0;
    private static instance: FileMonitor | undefined;
    private blinkInterval: NodeJS.Timeout | undefined;
    private isBlinkYellow: boolean = true;

    constructor() {
        FileMonitor.instance = this;
        // Create status bar item
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100
        );
        this.statusBarItem.command = 'sfdxDeployGuard.showLastModifier';

        // Create decoration type for modified files
        this.decorationType = vscode.window.createTextEditorDecorationType({
            gutterIconPath: path.join(__filename, '..', '..', 'resources', 'warning.svg'),
            gutterIconSize: 'contain',
            overviewRulerColor: 'orange',
            overviewRulerLane: vscode.OverviewRulerLane.Right,
            backgroundColor: 'rgba(255, 165, 0, 0.1)'
        });

        // Listen to active editor changes
        vscode.window.onDidChangeActiveTextEditor(editor => {
            this.onEditorChanged(editor);
        });

        // Listen to document changes (typing)
        vscode.workspace.onDidChangeTextDocument(event => {
            if (event.document === vscode.window.activeTextEditor?.document) {
                this.onUserTyping();
            }
        });

        // Initialize with current editor
        this.onEditorChanged(vscode.window.activeTextEditor);

        // Register command to show last modifier info
        vscode.commands.registerCommand('sfdxDeployGuard.showLastModifier', () => {
            this.showLastModifierInfo();
        });
    }

    private async onEditorChanged(editor: vscode.TextEditor | undefined): Promise<void> {
        this.currentEditor = editor;
        this.isUserEditing = false;
        this.pollCountAfterEdit = 0; // Reset counter

        // Stop polling
        this.stopPolling();

        if (editor && this.isSalesforceFile(editor.document)) {
            // Check immediately when file is loaded
            await this.checkFileStatus();
            // Don't start polling yet - wait for user to start typing
        } else {
            // Hide status bar for non-Salesforce files
            this.statusBarItem.hide();
            this.clearDecorations();
        }
    }

    private onUserTyping(): void {
        // User is typing, mark as editing
        this.isUserEditing = true;
        this.pollCountAfterEdit = 0; // Reset counter when user is typing

        // Start polling if not already started
        if (!this.pollInterval) {
            this.startPolling();
        }

        // Reset the editing timeout (stop polling 10 seconds after last keystroke)
        if (this.editingTimeout) {
            clearTimeout(this.editingTimeout);
        }
        this.editingTimeout = setTimeout(() => {
            this.isUserEditing = false;
            // Will poll 2 more times before stopping
        }, 10000); // Mark as not editing 10 seconds after user stops typing
    }

    private startPolling(): void {
        // Poll every 10 seconds
        this.pollInterval = setInterval(async () => {
            if (this.isUserEditing && this.currentEditor) {
                // User is actively editing, poll normally
                await this.checkFileStatus();
            } else if (!this.isUserEditing && this.pollCountAfterEdit < 2) {
                // User stopped editing, but still poll 2 more times
                this.pollCountAfterEdit++;
                await this.checkFileStatus();
            } else {
                // User stopped editing and already polled 2 times, stop polling
                this.stopPolling();
            }
        }, 10000);
    }

    private stopPolling(): void {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = undefined;
        }
        if (this.editingTimeout) {
            clearTimeout(this.editingTimeout);
            this.editingTimeout = undefined;
        }
    }

    private isSalesforceFile(document: vscode.TextDocument): boolean {
        const filePath = document.uri.fsPath;
        return filePath.includes('/force-app/') || 
               filePath.includes('\\force-app\\') ||
               filePath.includes('/classes/') || 
               filePath.includes('\\classes\\') ||
               filePath.includes('/triggers/') || 
               filePath.includes('\\triggers\\') ||
               filePath.includes('/lwc/') || 
               filePath.includes('\\lwc\\') ||
               filePath.includes('/aura/') || 
               filePath.includes('\\aura\\');
    }

    private async checkFileStatus(): Promise<void> {
        if (!this.currentEditor) {
            return;
        }

        try {
            const config = vscode.workspace.getConfiguration('sfdxDeployGuard');
            const monitoringEnabled = config.get<boolean>('enableRealTimeMonitoring', true);

            if (!monitoringEnabled) {
                this.statusBarItem.hide();
                return;
            }

            const metadataInfo = await this.getMetadataInfo(this.currentEditor.document.uri);
            if (!metadataInfo) {
                this.statusBarItem.hide();
                return;
            }

            const username = await this.getDefaultUsername();
            if (!username) {
                this.statusBarItem.hide();
                return;
            }

            // Get current user ID if we don't have it yet
            if (!this.currentUserId) {
                this.currentUserId = await this.getCurrentUserId(username);
            }

            // Get last modified info
            const lastModifiedInfo = await this.getLastModifiedInfo(metadataInfo, username);
            if (!lastModifiedInfo) {
                this.statusBarItem.hide();
                return;
            }

            // Store the last known modifier
            this.lastKnownModifier = lastModifiedInfo;

            // Update status bar
            this.updateStatusBar(lastModifiedInfo);

            // Check if someone else modified the file
            const ignoredUserIds = this.getIgnoredUserIds();
            const isIgnoredUser = lastModifiedInfo.id && ignoredUserIds.includes(lastModifiedInfo.id);
            
            if (lastModifiedInfo.id !== this.currentUserId && !isIgnoredUser) {
                // Someone else (not ignored) modified it - show warning decoration
                this.showWarningDecoration();
            } else {
                // You modified it or ignored user - clear decorations
                this.clearDecorations();
            }

        } catch (error) {
            console.error('Error checking file status:', error);
        }
    }

    private updateStatusBar(lastModifiedInfo: LastModifiedInfo): void {
        const isCurrentUser = lastModifiedInfo.id === this.currentUserId;
        const ignoredUserIds = this.getIgnoredUserIds();
        const isIgnoredUser = lastModifiedInfo.id && ignoredUserIds.includes(lastModifiedInfo.id);
        
        // Stop any existing blink interval
        this.stopBlinking();
        
        if (isCurrentUser) {
            this.statusBarItem.text = `LastModifiedBy: You (${lastModifiedInfo.date})`;
            this.statusBarItem.backgroundColor = undefined;
            this.statusBarItem.color = undefined;
        } else if (isIgnoredUser) {
            // Ignored user - show without blinking
            this.statusBarItem.text = `LastModifiedBy: ${lastModifiedInfo.name} (${lastModifiedInfo.date})`;
            this.statusBarItem.backgroundColor = undefined;
            this.statusBarItem.color = undefined;
        } else {
            // Different user (not ignored) - show with blinking
            this.statusBarItem.text = `LastModifiedBy: ${lastModifiedInfo.name} (${lastModifiedInfo.date})`;
            this.startBlinking();
        }

        this.statusBarItem.tooltip = `Last modified by: ${isCurrentUser ? 'You' : lastModifiedInfo.name}\nDate: ${lastModifiedInfo.date}\n\nClick for more info`;
        this.statusBarItem.show();
    }

    private startBlinking(): void {
        // Set initial color
        this.isBlinkYellow = true;
        this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        this.statusBarItem.color = new vscode.ThemeColor('statusBarItem.warningForeground');
        
        // Alternate between yellow (warning) and red (error) every 1 second
        this.blinkInterval = setInterval(() => {
            if (this.isBlinkYellow) {
                // Switch to red (error)
                this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
                this.statusBarItem.color = new vscode.ThemeColor('statusBarItem.errorForeground');
            } else {
                // Switch to yellow (warning)
                this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
                this.statusBarItem.color = new vscode.ThemeColor('statusBarItem.warningForeground');
            }
            this.isBlinkYellow = !this.isBlinkYellow;
        }, 1000);
    }

    private stopBlinking(): void {
        if (this.blinkInterval) {
            clearInterval(this.blinkInterval);
            this.blinkInterval = undefined;
        }
    }

    private showWarningDecoration(): void {
        if (!this.currentEditor) {
            return;
        }

        // Add decoration to the first line
        const range = new vscode.Range(0, 0, 0, 0);
        this.currentEditor.setDecorations(this.decorationType, [range]);
    }

    private clearDecorations(): void {
        if (!this.currentEditor) {
            return;
        }

        this.currentEditor.setDecorations(this.decorationType, []);
    }

    private showLastModifierInfo(): void {
        if (this.lastKnownModifier) {
            const isCurrentUser = this.lastKnownModifier.id === this.currentUserId;
            const message = isCurrentUser 
                ? `✅ You were the last to modify this file.\n\nDate: ${this.lastKnownModifier.date}`
                : `⚠️ Warning: This file was last modified by someone else!\n\nUser: ${this.lastKnownModifier.name}\nDate: ${this.lastKnownModifier.date}\n\nBe careful when deploying to avoid conflicts.`;
            
            vscode.window.showInformationMessage(message);
        } else {
            vscode.window.showInformationMessage('No modification info available for this file.');
        }
    }

    // Helper methods (reusing logic from deployGuard.ts)
    
    private async getMetadataInfo(fileUri: vscode.Uri): Promise<MetadataInfo | null> {
        const filePath = fileUri.fsPath;
        const fileName = path.basename(filePath);
        
        let metadataType = '';
        let apiName = '';

        if (filePath.includes('/classes/') || filePath.includes('\\classes\\')) {
            metadataType = 'ApexClass';
            apiName = fileName.replace('.cls', '').replace('.cls-meta.xml', '');
        } else if (filePath.includes('/triggers/') || filePath.includes('\\triggers\\')) {
            metadataType = 'ApexTrigger';
            apiName = fileName.replace('.trigger', '').replace('.trigger-meta.xml', '');
        } else if (filePath.includes('/pages/') || filePath.includes('\\pages\\')) {
            metadataType = 'ApexPage';
            apiName = fileName.replace('.page', '').replace('.page-meta.xml', '');
        } else if (filePath.includes('/components/') || filePath.includes('\\components\\')) {
            metadataType = 'ApexComponent';
            apiName = fileName.replace('.component', '').replace('.component-meta.xml', '');
        } else if (filePath.includes('/lwc/')) {
            metadataType = 'LightningComponentBundle';
            const parts = filePath.split('/lwc/');
            if (parts.length > 1) {
                apiName = parts[1].split('/')[0];
            }
        } else if (filePath.includes('\\lwc\\')) {
            metadataType = 'LightningComponentBundle';
            const parts = filePath.split('\\lwc\\');
            if (parts.length > 1) {
                apiName = parts[1].split('\\')[0];
            }
        } else if (filePath.includes('/aura/')) {
            metadataType = 'AuraDefinitionBundle';
            const parts = filePath.split('/aura/');
            if (parts.length > 1) {
                apiName = parts[1].split('/')[0];
            }
        } else if (filePath.includes('\\aura\\')) {
            metadataType = 'AuraDefinitionBundle';
            const parts = filePath.split('\\aura\\');
            if (parts.length > 1) {
                apiName = parts[1].split('\\')[0];
            }
        }

        if (!metadataType || !apiName) {
            return null;
        }

        return {
            type: metadataType,
            apiName: apiName,
            filePath: filePath
        };
    }

    private async getLastModifiedInfo(metadata: MetadataInfo, username: string): Promise<LastModifiedInfo | null> {
        try {
            // Try Tooling API first
            const toolingResult = await this.getLastModifiedViaTooling(metadata, username);
            if (toolingResult) {
                return toolingResult;
            }

            // Fallback to list metadata
            return await this.getLastModifiedViaListMetadata(metadata, username);
        } catch (error) {
            console.error('Error querying last modified info:', error);
            return null;
        }
    }

    private async getLastModifiedViaTooling(metadata: MetadataInfo, username: string): Promise<LastModifiedInfo | null> {
        try {
            let query = '';
            let useToolingApi = false;
            
            switch (metadata.type) {
                case 'ApexClass':
                    query = `SELECT LastModifiedBy.Name, LastModifiedById, LastModifiedDate FROM ApexClass WHERE Name='${metadata.apiName}'`;
                    break;
                case 'ApexTrigger':
                    query = `SELECT LastModifiedBy.Name, LastModifiedById, LastModifiedDate FROM ApexTrigger WHERE Name='${metadata.apiName}'`;
                    break;
                case 'ApexPage':
                    query = `SELECT LastModifiedBy.Name, LastModifiedById, LastModifiedDate FROM ApexPage WHERE Name='${metadata.apiName}'`;
                    break;
                case 'ApexComponent':
                    query = `SELECT LastModifiedBy.Name, LastModifiedById, LastModifiedDate FROM ApexComponent WHERE Name='${metadata.apiName}'`;
                    break;
                case 'LightningComponentBundle':
                    query = `SELECT LastModifiedBy.Name, LastModifiedById, LastModifiedDate FROM LightningComponentBundle WHERE DeveloperName='${metadata.apiName}'`;
                    useToolingApi = true;
                    break;
                case 'AuraDefinitionBundle':
                    query = `SELECT LastModifiedBy.Name, LastModifiedById, LastModifiedDate FROM AuraDefinitionBundle WHERE DeveloperName='${metadata.apiName}'`;
                    useToolingApi = true;
                    break;
                default:
                    return null;
            }

            const toolingFlag = useToolingApi ? '--use-tooling-api' : '';
            const command = `sf data query --query "${query}" --target-org ${username} ${toolingFlag} --json`;
            const { stdout } = await execAsync(command);
            const result = JSON.parse(stdout);

            if (result.status === 0 && result.result.records && result.result.records.length > 0) {
                const record = result.result.records[0];
                return {
                    name: record.LastModifiedBy?.Name || 'Unknown',
                    id: record.LastModifiedById || '',
                    date: new Date(record.LastModifiedDate).toLocaleString()
                };
            }

            return null;
        } catch (error) {
            return null;
        }
    }

    private async getLastModifiedViaListMetadata(metadata: MetadataInfo, username: string): Promise<LastModifiedInfo | null> {
        try {
            const command = `sf org list metadata --metadata-type ${metadata.type} --target-org ${username} --json`;
            const { stdout } = await execAsync(command, { maxBuffer: 1024 * 1024 * 10 });
            const result = JSON.parse(stdout);

            if (result.status === 0 && result.result) {
                let metadataItems = result.result;
                
                if (!Array.isArray(metadataItems)) {
                    metadataItems = [metadataItems];
                }

                const matchingItem = metadataItems.find((item: any) => 
                    item.fullName === metadata.apiName || 
                    item.fileName?.includes(metadata.apiName)
                );

                if (matchingItem) {
                    return {
                        name: matchingItem.lastModifiedByName || 'Unknown',
                        id: matchingItem.lastModifiedById || '',
                        date: matchingItem.lastModifiedDate ? new Date(matchingItem.lastModifiedDate).toLocaleString() : 'Unknown'
                    };
                }
            }

            return null;
        } catch (error) {
            return null;
        }
    }

    private async getDefaultUsername(): Promise<string | null> {
        try {
            const command = 'sf config get target-org --json';
            const { stdout } = await execAsync(command);
            const result = JSON.parse(stdout);
            
            if (result.status === 0 && result.result && result.result.length > 0) {
                return result.result[0].value;
            }
            
            return null;
        } catch (error) {
            return null;
        }
    }

    private async getCurrentUserId(username: string): Promise<string> {
        try {
            const orgCommand = `sf org display --target-org ${username} --json`;
            const { stdout: orgStdout } = await execAsync(orgCommand);
            const orgResult = JSON.parse(orgStdout);
            
            if (orgResult.status !== 0 || !orgResult.result) {
                return '';
            }

            const actualUsername = orgResult.result.username;
            const query = `SELECT Id FROM User WHERE Username='${actualUsername}'`;
            const queryCommand = `sf data query --query "${query}" --target-org ${username} --json`;
            
            const { stdout } = await execAsync(queryCommand);
            const result = JSON.parse(stdout);
            
            if (result.status === 0 && result.result?.records && result.result.records.length > 0) {
                return result.result.records[0].Id;
            }

            return '';
        } catch (error) {
            return '';
        }
    }

    /**
     * Get list of ignored user IDs from configuration
     */
    private getIgnoredUserIds(): string[] {
        const config = vscode.workspace.getConfiguration('sfdxDeployGuard');
        const ignoreUserIds = config.get<string>('ignoreUserIds', '');
        
        if (!ignoreUserIds) {
            return [];
        }
        
        // Split by comma and trim whitespace
        return ignoreUserIds.split(',').map(id => id.trim()).filter(id => id.length > 0);
    }

    /**
     * Public method to refresh the file status (called after deployment)
     */
    public async refreshCurrentFile(): Promise<void> {
        if (this.currentEditor && this.isSalesforceFile(this.currentEditor.document)) {
            await this.checkFileStatus();
        }
    }

    /**
     * Get the singleton instance
     */
    public static getInstance(): FileMonitor | undefined {
        return FileMonitor.instance;
    }

    dispose(): void {
        this.stopPolling();
        this.stopBlinking();
        this.statusBarItem.dispose();
        this.decorationType.dispose();
        FileMonitor.instance = undefined;
    }
}
