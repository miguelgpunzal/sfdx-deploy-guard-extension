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

export class SfdxDeployGuard {
    /**
     * Handle the deploy command with pre-deployment checks
     */
    async handleDeployCommand(uri?: vscode.Uri): Promise<void> {
        const shouldProceed = await this.checkBeforeDeploy(uri);
        if (shouldProceed) {
            await this.executeDeploy(uri);
        }
    }

    /**
     * Check if deployment should proceed
     * Returns true if deployment should continue, false otherwise
     */
    async checkBeforeDeploy(uri?: vscode.Uri): Promise<boolean> {
        try {
            const config = vscode.workspace.getConfiguration('sfdxDeployGuard');
            const enabled = config.get<boolean>('enabled', true);
            const checkLastModified = config.get<boolean>('checkLastModified', true);

            if (!enabled || !checkLastModified) {
                // If checks are disabled, proceed
                return true;
            }

            // Get the file to deploy
            const fileUri = uri || vscode.window.activeTextEditor?.document.uri;
            if (!fileUri) {
                vscode.window.showErrorMessage('No file selected for deployment');
                return false;
            }

            // Show progress while checking
            return await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Checking metadata in target org...',
                cancellable: false
            }, async () => {
                try {
                    // Get metadata info from file
                    const metadataInfo = await this.getMetadataInfo(fileUri);
                    if (!metadataInfo) {
                        vscode.window.showWarningMessage('Unable to determine metadata type. Proceeding with deployment...');
                        return true;
                    }

                    // Get default org username
                    const username = await this.getDefaultUsername();
                    if (!username) {
                        vscode.window.showWarningMessage('No default org found. Proceeding with deployment...');
                        return true;
                    }

                    // Query last modified info
                    const lastModifiedInfo = await this.getLastModifiedInfo(metadataInfo, username);
                    if (!lastModifiedInfo) {
                        // Metadata doesn't exist in org yet, proceed with deployment
                        return true;
                    }

                    // Get current user info
                    const currentUserId = await this.getCurrentUserId(username);
                    
                    // Check if last modifier is different from current user (compare by ID)
                    if (lastModifiedInfo.id && currentUserId && lastModifiedInfo.id !== currentUserId) {
                        // Different user modified the file - show warning
                        const choice = await vscode.window.showWarningMessage(
                            `⚠️ Warning: This file was recently changed by ${lastModifiedInfo.name} on ${lastModifiedInfo.date}.\n\nWhat would you like to do?`,
                            { modal: true },
                            'Deploy Anyway',
                            'Compare First'
                        );

                        if (!choice) {
                            vscode.window.showInformationMessage('Deployment cancelled');
                            return false;
                        } else if (choice === 'Compare First') {
                            // Execute the comparison and exit - don't proceed with deployment
                            await this.executeCompare(fileUri);
                            vscode.window.showInformationMessage('Comparison opened. Run deploy command again when ready.');
                            return false;
                        } else if (choice === 'Deploy Anyway') {
                            // Proceed with deployment
                            // Continue to deployment
                        }
                    } else {
                        // Same user (you) made the last change - proceed silently
                        vscode.window.showInformationMessage(`✅ You were the last to modify this file. Proceeding with deployment...`);
                    }

                    // Proceed with deployment
                    return true;

                } catch (error) {
                    vscode.window.showErrorMessage(`Error checking metadata: ${error}`);
                    // Proceed with deployment anyway on error
                    return true;
                }
            });

        } catch (error) {
            vscode.window.showErrorMessage(`Deploy guard error: ${error}`);
            // Fallback - allow deployment
            return true;
        }
    }

    /**
     * Get metadata information from the file path
     */
    private async getMetadataInfo(fileUri: vscode.Uri): Promise<MetadataInfo | null> {
        const filePath = fileUri.fsPath;
        const fileName = path.basename(filePath);
        
        // Determine metadata type from path
        let metadataType = '';
        let apiName = '';

        // Common metadata types with standard paths
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
        } else if (filePath.includes('/objects/') || filePath.includes('\\objects\\')) {
            metadataType = 'CustomObject';
            apiName = fileName.replace('.object-meta.xml', '');
        } else if (filePath.includes('/flows/') || filePath.includes('\\flows\\')) {
            metadataType = 'Flow';
            apiName = fileName.replace('.flow-meta.xml', '');
        } else if (filePath.includes('/profiles/') || filePath.includes('\\profiles\\')) {
            metadataType = 'Profile';
            apiName = fileName.replace('.profile-meta.xml', '');
        } else if (filePath.includes('/permissionsets/') || filePath.includes('\\permissionsets\\')) {
            metadataType = 'PermissionSet';
            apiName = fileName.replace('.permissionset-meta.xml', '');
        } else if (filePath.includes('/staticresources/') || filePath.includes('\\staticresources\\')) {
            metadataType = 'StaticResource';
            apiName = fileName.split('.')[0];
        } else if (filePath.includes('/labels/') || filePath.includes('\\labels\\')) {
            metadataType = 'CustomLabels';
            apiName = 'CustomLabels';
        } else if (filePath.includes('/layouts/') || filePath.includes('\\layouts\\')) {
            metadataType = 'Layout';
            apiName = fileName.replace('.layout-meta.xml', '');
        } else if (filePath.includes('/quickActions/') || filePath.includes('\\quickActions\\')) {
            metadataType = 'QuickAction';
            apiName = fileName.replace('.quickAction-meta.xml', '');
        } else if (filePath.includes('/tabs/') || filePath.includes('\\tabs\\')) {
            metadataType = 'CustomTab';
            apiName = fileName.replace('.tab-meta.xml', '');
        } else if (filePath.includes('/flexipages/') || filePath.includes('\\flexipages\\')) {
            metadataType = 'FlexiPage';
            apiName = fileName.replace('.flexipage-meta.xml', '');
        } else if (filePath.includes('/email/') || filePath.includes('\\email\\')) {
            metadataType = 'EmailTemplate';
            const parts = filePath.split(/\/email\/|\\email\\/);
            if (parts.length > 1) {
                apiName = parts[1].replace('.email-meta.xml', '').replace('.email', '');
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

    /**
     * Get last modified information from the org
     */
    private async getLastModifiedInfo(metadata: MetadataInfo, username: string): Promise<LastModifiedInfo | null> {
        try {
            // Try using Tooling API for standard queryable types first
            const toolingResult = await this.getLastModifiedViaTooling(metadata, username);
            if (toolingResult) {
                return toolingResult;
            }

            // Fallback: Use sf org list metadata command (works for ALL metadata types)
            return await this.getLastModifiedViaListMetadata(metadata, username);
        } catch (error) {
            console.error('Error querying last modified info:', error);
            return null;
        }
    }

    /**
     * Get last modified info via Tooling API (for standard queryable types)
     */
    private async getLastModifiedViaTooling(metadata: MetadataInfo, username: string): Promise<LastModifiedInfo | null> {
        try {
            let query = '';
            let useToolingApi = false;
            
            // Build SOQL query based on metadata type
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
            console.error('Error in tooling API query:', error);
            return null;
        }
    }

    /**
     * Get last modified info using sf org list metadata (works for ALL metadata types)
     */
    private async getLastModifiedViaListMetadata(metadata: MetadataInfo, username: string): Promise<LastModifiedInfo | null> {
        try {
            const command = `sf org list metadata --metadata-type ${metadata.type} --target-org ${username} --json`;
            const { stdout } = await execAsync(command, { maxBuffer: 1024 * 1024 * 10 });
            const result = JSON.parse(stdout);

            if (result.status === 0 && result.result) {
                let metadataItems = result.result;
                
                // Handle single result (not an array)
                if (!Array.isArray(metadataItems)) {
                    metadataItems = [metadataItems];
                }

                // Find the matching metadata item
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
            console.error('Error in list metadata command:', error);
            return null;
        }
    }

    /**
     * Get the default org username
     */
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
            console.error('Error getting default username:', error);
            return null;
        }
    }

    /**
     * Get current user ID from the org
     */
    private async getCurrentUserId(username: string): Promise<string> {
        try {
            // Get the current user's ID directly from org info
            const orgCommand = `sf org display --target-org ${username} --json`;
            const { stdout: orgStdout } = await execAsync(orgCommand);
            const orgResult = JSON.parse(orgStdout);
            
            if (orgResult.status === 0 && orgResult.result && orgResult.result.id) {
                return orgResult.result.id;
            }

            return '';
        } catch (error) {
            console.error('Error getting current user ID:', error);
            return '';
        }
    }

    /**
     * Execute the deployment
     */
    async executeDeploy(uri?: vscode.Uri): Promise<void> {
        try {
            const fileUri = uri || vscode.window.activeTextEditor?.document.uri;
            if (!fileUri) {
                vscode.window.showErrorMessage('No file selected for deployment');
                return;
            }

            // Use SFDX CLI directly to deploy
            const filePath = fileUri.fsPath;
            
            // Determine if it's a file or directory
            const stats = await vscode.workspace.fs.stat(fileUri);
            let command: string;
            
            if (stats.type === vscode.FileType.Directory) {
                // Deploy entire directory
                command = `sf project deploy start --source-dir "${filePath}"`;
            } else {
                // Deploy only the specific file using --metadata flag
                const metadata = await this.getMetadataInfo(fileUri);
                if (metadata) {
                    // Use metadata type and name for precise deployment
                    const metadataArg = this.getMetadataTypeArg(metadata.type);
                    command = `sf project deploy start --metadata "${metadataArg}:${metadata.apiName}"`;
                } else {
                    // Fallback: use source-path for the specific file
                    command = `sf project deploy start --source-path "${filePath}"`;
                }
            }
            
            // Execute in terminal so user can see the output
            const terminal = vscode.window.createTerminal('SFDX Deploy');
            terminal.show();
            terminal.sendText(command);
            
            vscode.window.showInformationMessage('✅ Deployment started. Check terminal for progress.');
            
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to execute deploy command: ${error}`);
        }
    }

    /**
     * Get the metadata type argument for SF CLI
     */
    private getMetadataTypeArg(metadataType: string): string {
        switch (metadataType) {
            case 'ApexClass':
                return 'ApexClass';
            case 'ApexTrigger':
                return 'ApexTrigger';
            case 'ApexPage':
                return 'ApexPage';
            case 'ApexComponent':
                return 'ApexComponent';
            case 'LightningComponentBundle':
                return 'LightningComponentBundle';
            case 'AuraDefinitionBundle':
                return 'AuraDefinitionBundle';
            default:
                return metadataType;
        }
    }

    /**
     * Execute the compare/diff command
     */
    async executeCompare(fileUri: vscode.Uri): Promise<void> {
        try {
            // Get metadata info to know what to query
            const metadataInfo = await this.getMetadataInfo(fileUri);
            if (!metadataInfo) {
                vscode.window.showErrorMessage('Unable to determine metadata type for comparison');
                return;
            }

            // Get default org username
            const username = await this.getDefaultUsername();
            if (!username) {
                vscode.window.showErrorMessage('No default org found');
                return;
            }

            // Show progress while fetching org content
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Fetching content from org for comparison...',
                cancellable: false
            }, async () => {
                try {
                    // Get the content from org
                    const orgContent = await this.getOrgContent(metadataInfo, username);
                    if (!orgContent) {
                        vscode.window.showWarningMessage('Could not retrieve content from org');
                        return;
                    }

                    // Create a side-by-side diff
                    await this.showSideBySideDiff(fileUri, orgContent, metadataInfo.apiName);

                } catch (error) {
                    vscode.window.showErrorMessage(`Error fetching org content: ${error}`);
                }
            });
            
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to execute compare command: ${error}`);
        }
    }

    /**
     * Get content from the org for comparison
     */
    private async getOrgContent(metadata: MetadataInfo, username: string): Promise<string | null> {
        try {
            let query = '';
            
            // Build SOQL query to get the body/content
            switch (metadata.type) {
                case 'ApexClass':
                    query = `SELECT Body FROM ApexClass WHERE Name='${metadata.apiName}'`;
                    break;
                case 'ApexTrigger':
                    query = `SELECT Body FROM ApexTrigger WHERE Name='${metadata.apiName}'`;
                    break;
                case 'ApexPage':
                    query = `SELECT Markup FROM ApexPage WHERE Name='${metadata.apiName}'`;
                    break;
                case 'ApexComponent':
                    query = `SELECT Markup FROM ApexComponent WHERE Name='${metadata.apiName}'`;
                    break;
                case 'LightningComponentBundle':
                    // For LWC, get the specific resource content
                    return await this.getLWCContent(metadata, username);
                case 'AuraDefinitionBundle':
                    // For Aura, get the specific definition content
                    return await this.getAuraContent(metadata, username);
                default:
                    return null;
            }

            const command = `sf data query --query "${query}" --target-org ${username} --json`;
            const { stdout } = await execAsync(command);
            const result = JSON.parse(stdout);

            if (result.status === 0 && result.result.records && result.result.records.length > 0) {
                const record = result.result.records[0];
                return record.Body || record.Markup || '';
            }

            return null;
        } catch (error) {
            console.error('Error querying org content:', error);
            return null;
        }
    }

    /**
     * Get LWC content from org
     */
    private async getLWCContent(metadata: MetadataInfo, username: string): Promise<string | null> {
        try {
            // Determine the file type from the path
            const fileName = path.basename(metadata.filePath);
            const ext = path.extname(fileName);
            
            let fileType = '';
            if (ext === '.js') {
                fileType = 'LightningComponentResource';
            } else if (ext === '.html') {
                fileType = 'LightningComponentResource';
            } else if (ext === '.css') {
                fileType = 'LightningComponentResource';
            }

            // Query for the specific resource
            const query = `SELECT Id, Source FROM LightningComponentResource WHERE LightningComponentBundle.DeveloperName='${metadata.apiName}' AND FilePath LIKE '%${fileName}'`;
            const command = `sf data query --query "${query}" --target-org ${username} --use-tooling-api --json`;
            const { stdout } = await execAsync(command);
            const result = JSON.parse(stdout);

            if (result.status === 0 && result.result.records && result.result.records.length > 0) {
                return result.result.records[0].Source || '';
            }

            return null;
        } catch (error) {
            console.error('Error querying LWC content:', error);
            return null;
        }
    }

    /**
     * Get Aura content from org
     */
    private async getAuraContent(metadata: MetadataInfo, username: string): Promise<string | null> {
        try {
            // Determine the definition type from the file extension
            const fileName = path.basename(metadata.filePath);
            const ext = path.extname(fileName);
            
            let defType = '';
            if (ext === '.cmp') {
                defType = 'COMPONENT';
            } else if (ext === '.app') {
                defType = 'APPLICATION';
            } else if (fileName.endsWith('Controller.js')) {
                defType = 'CONTROLLER';
            } else if (fileName.endsWith('Helper.js')) {
                defType = 'HELPER';
            } else if (fileName.endsWith('Renderer.js')) {
                defType = 'RENDERER';
            } else if (ext === '.css') {
                defType = 'STYLE';
            }

            if (!defType) {
                return null;
            }

            // Query for the specific definition
            const query = `SELECT Source FROM AuraDefinition WHERE AuraDefinitionBundle.DeveloperName='${metadata.apiName}' AND DefType='${defType}'`;
            const command = `sf data query --query "${query}" --target-org ${username} --use-tooling-api --json`;
            const { stdout } = await execAsync(command);
            const result = JSON.parse(stdout);

            if (result.status === 0 && result.result.records && result.result.records.length > 0) {
                return result.result.records[0].Source || '';
            }

            return null;
        } catch (error) {
            console.error('Error querying Aura content:', error);
            return null;
        }
    }

    /**
     * Show side-by-side diff in VS Code
     */
    private async showSideBySideDiff(localFileUri: vscode.Uri, orgContent: string, fileName: string): Promise<void> {
        try {
            // Create a temporary file for the org content
            const tempFileName = `${fileName} (Org Version)`;
            const tempUri = vscode.Uri.parse(`untitled:${tempFileName}`);
            
            // Open the org content in a new document
            const orgDocument = await vscode.workspace.openTextDocument({
                content: orgContent,
                language: this.getLanguageFromFileExtension(localFileUri.fsPath)
            });

            // Open both documents
            const localDocument = await vscode.workspace.openTextDocument(localFileUri);
            
            // Show the diff
            await vscode.commands.executeCommand('vscode.diff', 
                orgDocument.uri, 
                localDocument.uri, 
                `${fileName}: Org ↔ Local`
            );

            vscode.window.showInformationMessage('📋 Comparison opened. Review the changes, then run deploy again when ready.');

        } catch (error) {
            vscode.window.showErrorMessage(`Failed to show diff: ${error}`);
        }
    }

    /**
     * Get appropriate language ID for syntax highlighting
     */
    private getLanguageFromFileExtension(filePath: string): string {
        const ext = path.extname(filePath).toLowerCase();
        switch (ext) {
            case '.cls':
            case '.trigger':
                return 'apex';
            case '.page':
            case '.component':
                return 'html';
            case '.js':
                return 'javascript';
            case '.css':
                return 'css';
            case '.xml':
                return 'xml';
            default:
                return 'plaintext';
        }
    }
}
