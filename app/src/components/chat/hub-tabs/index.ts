export { HubChatsTab } from './HubChatsTab';
export { HubNotesTab } from './HubNotesTab';
export { HubScratchpadTab } from './HubScratchpadTab';
export { HubKeptTab } from './HubKeptTab';
export { HubConsoleTab } from './HubConsoleTab';
export { HubFilesTab } from './HubFilesTab';
export { HubDiffTab } from './HubDiffTab';
export { PrBrowser } from './PrBrowser';
// HubReviewTab and HubSettingsTab are intentionally NOT re-exported here.
// WorkspaceHubSheet lazy()-loads them for code-splitting; re-exporting them
// from this barrel pulls them statically into the main bundle and silently
// defeats the split (Rolldown INEFFECTIVE_DYNAMIC_IMPORT). Import them directly
// from './hub-tabs/HubReviewTab' / './hub-tabs/HubSettingsTab' if you need them.
