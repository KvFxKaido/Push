export function cleanWorkspacePublishMessage(message: string): string {
  return message
    .replace(/^\[Tool Error\]\s*/i, '')
    .replace(/^\[Tool Result.*?\]\s*/i, '')
    .trim();
}
