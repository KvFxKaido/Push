/**
 * File utilities for the file browser and editor.
 */

// Extensions that are safe and reasonable to edit on mobile
export const EDITABLE_EXTENSIONS = new Set([
  // Web
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  // Styles
  'css', 'scss', 'sass', 'less', 'postcss',
  // Markup
  'html', 'htm', 'xml', 'svg',
  // Data
  'json', 'jsonc', 'json5', 'yaml', 'yml', 'toml',
  // Docs
  'md', 'mdx', 'txt', 'rst',
  // Config
  'env', 'ini', 'conf', 'config',
  // Python
  'py', 'pyi', 'pyw',
  // Shell/scripts
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  // Other code
  'rs', 'go', 'rb', 'php', 'c', 'cpp', 'cc', 'h', 'hpp', 'java', 'kt', 'swift',
  // Git
  'gitignore', 'gitattributes', 'gitmodules',
]);

// Extensions we should never attempt to edit (binary or too large)
export const BLOCKED_EXTENSIONS = new Set([
  // Images
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'svgz',
  // Video
  'mp4', 'mov', 'avi', 'mkv', 'webm',
  // Audio
  'mp3', 'wav', 'ogg', 'flac', 'aac',
  // Archives
  'zip', 'tar', 'gz', 'bz2', '7z', 'rar', 'xz',
  // Binaries
  'exe', 'dll', 'so', 'dylib', 'bin', 'wasm', 'o', 'a', 'lib',
  // Fonts
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  // Documents (binary)
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  // Others
  'lock', 'snap', 'pack', 'idx',
]);

// Rough language mapping for display
export const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  css: 'css',
  scss: 'scss',
  sass: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  svg: 'svg',
  json: 'json',
  jsonc: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  md: 'markdown',
  mdx: 'markdown',
  txt: 'text',
  py: 'python',
  pyi: 'python',
  rs: 'rust',
  go: 'go',
  rb: 'ruby',
  php: 'php',
  c: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  h: 'c',
  hpp: 'cpp',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  sh: 'bash',
  bash: 'bash',
  zsh: 'zsh',
  env: 'dotenv',
  ini: 'ini',
  gitignore: 'gitignore',
};

const MAX_EDITABLE_SIZE_BYTES = 1024 * 1024; // 1MB
const WARNING_SIZE_BYTES = 50 * 1024; // 50KB

export interface Editability {
  editable: boolean;
  reason?: 'blocked_extension' | 'too_large' | 'binary_encoding';
  language: string;
  warning?: 'large_file';
}

/**
 * Determine if a file can be edited based on extension and size.
 */
export function getFileEditability(path: string, size: number): Editability {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  const language = EXTENSION_TO_LANGUAGE[ext] || ext || 'text';

  // Check blocked extensions first
  if (BLOCKED_EXTENSIONS.has(ext)) {
    return { editable: false, reason: 'blocked_extension', language: ext };
  }

  // Check size limit
  if (size > MAX_EDITABLE_SIZE_BYTES) {
    return { editable: false, reason: 'too_large', language };
  }

  // Check if it's a known editable extension
  if (!EDITABLE_EXTENSIONS.has(ext)) {
    // Unknown extension - allow but warn (user can try)
    return {
      editable: true,
      language,
      warning: size > WARNING_SIZE_BYTES ? 'large_file' : undefined,
    };
  }

  return {
    editable: true,
    language,
    warning: size > WARNING_SIZE_BYTES ? 'large_file' : undefined,
  };
}

/**
 * Check if content appears to be binary (contains null bytes or high ratio of non-printable chars).
 * This is a basic check - for mobile editing we err on the side of caution.
 */
export function isBinaryContent(content: string): boolean {
  // Check for null bytes
  if (content.includes('\x00')) return true;

  // Sample first 1KB
  const sample = content.slice(0, 1024);
  let nonPrintable = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    // Control characters other than common whitespace
    if (code < 32 && ![9, 10, 13].includes(code)) {
      nonPrintable++;
    }
  }

  // If >10% non-printable, likely binary
  return (nonPrintable / sample.length) > 0.1;
}

/**
 * Format file size for display.
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Get a human-readable reason why a file can't be edited.
 */
export function getEditabilityReason(reason: 'blocked_extension' | 'too_large' | 'binary_encoding'): string {
  switch (reason) {
    case 'blocked_extension':
      return 'This file type cannot be edited (binary or unsupported format)';
    case 'too_large':
      return 'File is too large to edit on mobile (>1MB)';
    case 'binary_encoding':
      return 'File appears to be binary or has invalid encoding';
    default:
      return 'Cannot edit this file';
  }
}
