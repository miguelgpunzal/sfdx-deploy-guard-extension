import * as vscode from 'vscode';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { FileMonitor } from './fileMonitor';

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
        console.log('DEBUG: handleDeployCommand called');
        const shouldProceed = await this.checkBeforeDeploy(uri);
        console.log('DEBUG: shouldProceed:', shouldProceed);
        if (shouldProceed) {
            await this.executeDeploy(uri);
        } else {
            console.log('DEBUG: Deployment cancelled by user or checks');
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
                    
                    // Get ignored user IDs from config
                    const ignoredUserIds = this.getIgnoredUserIds();
                    const isIgnoredUser = lastModifiedInfo.id && ignoredUserIds.includes(lastModifiedInfo.id);
                    
                    // Check if last modifier is different from current user and not in ignored list
                    if (lastModifiedInfo.id && currentUserId && lastModifiedInfo.id !== currentUserId && !isIgnoredUser) {
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
                            vscode.window.showInformationMessage('⏳ Proceeding with deployment...');
                        }
                    } else {
                        // Same user (you) made the last change, or user is in ignored list - proceed silently
                        if (isIgnoredUser) {
                            vscode.window.showInformationMessage(`✅ File modified by ${lastModifiedInfo.name} (ignored user). Proceeding with deployment...`);
                        } else {
                            vscode.window.showInformationMessage(`✅ You were the last to modify this file. Proceeding with deployment...`);
                        }
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
     * Get current user ID from the org
     */
    private async getCurrentUserId(username: string): Promise<string> {
        try {
            // First get the org info to find the username
            const orgCommand = `sf org display --target-org ${username} --json`;
            const { stdout: orgStdout } = await execAsync(orgCommand);
            const orgResult = JSON.parse(orgStdout);
            
            if (orgResult.status !== 0 || !orgResult.result) {
                return '';
            }

            // Get the actual username from org display
            const actualUsername = orgResult.result.username;

            // Query the User table to get the user ID by username
            const query = `SELECT Id FROM User WHERE Username='${actualUsername}'`;
            const queryCommand = `sf data query --query "${query}" --target-org ${username} --json`;
            
            const { stdout } = await execAsync(queryCommand);
            const result = JSON.parse(stdout);
            
            if (result.status === 0 && result.result?.records && result.result.records.length > 0) {
                return result.result.records[0].Id;
            }

            return '';
        } catch (error) {
            console.error('Error getting current user ID:', error);
            return '';
        }
    }

    /**
     * Execute the deployment using library-based approach (same as Salesforce extension)
     */
    async executeDeploy(uri?: vscode.Uri): Promise<void> {
        try {
            console.log('DEBUG: executeDeploy called');
            const fileUri = uri || vscode.window.activeTextEditor?.document.uri;
            if (!fileUri) {
                vscode.window.showErrorMessage('No file selected for deployment');
                return;
            }

            console.log('DEBUG: File URI:', fileUri.fsPath);

            // Import required libraries
            const { ComponentSet } = await import('@salesforce/source-deploy-retrieve');
            const { Connection, Org, AuthInfo } = await import('@salesforce/core');
            
            // Get the target org alias/username
            const targetOrg = await this.getDefaultUsername();
            if (!targetOrg) {
                vscode.window.showErrorMessage('No default org found');
                return;
            }

            // Get org details first to show to user
            let orgAlias = targetOrg;
            let orgUsername = '';
            let orgType = '';
            
            try {
                const orgDisplayCommand = `sf org display --target-org ${targetOrg} --json`;
                const { stdout: orgStdout } = await execAsync(orgDisplayCommand);
                const orgInfo = JSON.parse(orgStdout);
                
                if (orgInfo.status === 0 && orgInfo.result) {
                    orgUsername = orgInfo.result.username;
                    orgAlias = orgInfo.result.alias || targetOrg;
                    orgType = orgInfo.result.instanceUrl ? 
                        (orgInfo.result.instanceUrl.includes('sandbox') ? ' (Sandbox)' : ' (Production)') : '';
                }
            } catch (error) {
                console.error('Error getting org details:', error);
            }

            // Show deployment target info
            const targetInfo = orgAlias !== orgUsername && orgUsername ?
                `${orgAlias}${orgType} (${orgUsername})` :
                `${orgAlias}${orgType}`;
            
            console.log(`Deploying to: ${targetInfo}`);

            // Show progress notification
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Deploying to ${orgAlias}...`,
                cancellable: false
            }, async (progress) => {
                try {
                    progress.report({ message: 'Connecting to org...' });
                    
                    // Create a proper connection using Org.create which handles both aliases and usernames
                    const org = await Org.create({ aliasOrUsername: targetOrg });
                    const connection = org.getConnection();
                    
                    console.log('DEBUG: Connected to org:', connection.getUsername());
                    
                    progress.report({ message: 'Preparing deployment...' });
                    
                    // Create ComponentSet from the file path
                    const filePath = fileUri.fsPath;
                    const componentSet = ComponentSet.fromSource(filePath);
                    
                    progress.report({ message: 'Deploying components...' });
                    
                    // Deploy using the connection object
                    const deployOperation = await componentSet.deploy({
                        usernameOrConnection: connection as any
                    });
                    
                    progress.report({ message: 'Waiting for deployment to complete...' });
                    
                    // Poll for status
                    const deployResult = await deployOperation.pollStatus();
                    
                    // Check result
                    if (deployResult.response.status === 'Succeeded') {
                        vscode.window.showInformationMessage(`✅ Deployment succeeded to ${orgAlias}!`);
                    } else {
                        const failures = deployResult.response.details?.componentFailures;
                        const errors = Array.isArray(failures) ? failures : (failures ? [failures] : []);
                        const errorMsg = errors.length > 0 
                            ? errors.map((e: any) => `${e.fullName}: ${e.problem}`).join('\n')
                            : 'Unknown error';
                        vscode.window.showErrorMessage(`❌ Deployment failed:\n${errorMsg}`);
                    }
                    
                    // Refresh the file monitor status after deployment
                    const fileMonitor = FileMonitor.getInstance();
                    if (fileMonitor) {
                        setTimeout(async () => {
                            await fileMonitor.refreshCurrentFile();
                        }, 2000);
                    }
                    
                } catch (error) {
                    console.error('Deployment error:', error);
                    vscode.window.showErrorMessage(`Failed to deploy: ${error}`);
                }
            });
            
        } catch (error) {
            console.error('DEBUG: Error in executeDeploy:', error);
            vscode.window.showErrorMessage(`Failed to execute deploy: ${error}`);
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
