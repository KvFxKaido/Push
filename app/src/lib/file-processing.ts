/**
 * File processing utilities for chat attachments.
 * Handles images, code files, and documents with size limits.
 */

import type { AttachmentData } from '@/types';

export { formatSize as formatFileSize } from './diff-utils';

// Size limits
const MAX_IMAGE_SIZE = 400 * 1024;    // 400KB per image (base64 grows ~33%)
const MAX_TEXT_SIZE = 50 * 1024;       // 50KB per text file

// Supported types
const SUPPORTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const SUPPORTED_CODE_EXTENSIONS = [
  '.js', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h',
  '.md', '.txt', '.json', '.yaml', '.yml', '.html', '.css', '.sql', '.sh', '.rb',
  '.php', '.swift', '.kt', '.scala', '.vue', '.svelte', '.astro',
];

export interface StagedAttachment extends AttachmentData {
  status: 'processing' | 'ready' | 'error';
  error?: string;
}

/**
 * Process any file into an attachment.
 */
export async function processFile(file: File): Promise<StagedAttachment> {
  const id = crypto.randomUUID();
  const base: Partial<StagedAttachment> = {
    id,
    filename: file.name,
    mimeType: file.type || 'application/octet-stream',
    sizeBytes: file.size,
  };

  try {
    if (SUPPORTED_IMAGE_TYPES.includes(file.type)) {
      return await processImage(file, base);
    }

    if (isCodeFile(file.name)) {
      return await processTextFile(file, base, 'code');
    }

    // Default: treat as document
    return await processTextFile(file, base, 'document');
  } catch (err) {
    return {
      ...base,
      type: 'document',
      content: '',
      status: 'error',
      error: err instanceof Error ? err.message : 'Failed to process file',
    } as StagedAttachment;
  }
}

/**
 * Process image file - resize if too large, create thumbnail.
 */
async function processImage(
  file: File,
  base: Partial<StagedAttachment>,
): Promise<StagedAttachment> {
  let processedFile: Blob = file;

  // Resize if too large
  if (file.size > MAX_IMAGE_SIZE) {
    processedFile = await resizeImage(file, 1200, 1200, 0.8);
  }

  const dataUrl = await blobToDataUrl(processedFile);
  const thumbnail = await createThumbnail(processedFile, 100, 100);

  return {
    ...base,
    type: 'image',
    content: dataUrl,
    thumbnail,
    sizeBytes: processedFile.size,
    status: 'ready',
  } as StagedAttachment;
}

/**
 * Process text file (code or document).
 */
async function processTextFile(
  file: File,
  base: Partial<StagedAttachment>,
  type: 'code' | 'document',
): Promise<StagedAttachment> {
  let text = await file.text();

  // Truncate if too large
  if (text.length > MAX_TEXT_SIZE) {
    text = text.slice(0, MAX_TEXT_SIZE) + '\n\n[Content truncated at 50KB]';
  }

  return {
    ...base,
    type,
    content: text,
    sizeBytes: new Blob([text]).size,
    status: 'ready',
  } as StagedAttachment;
}

/**
 * Resize image using canvas.
 */
async function resizeImage(
  file: File,
  maxW: number,
  maxH: number,
  quality: number,
): Promise<Blob> {
  const img = await createImageBitmap(file);
  const scale = Math.min(maxW / img.width, maxH / img.height, 1);
  const width = Math.round(img.width * scale);
  const height = Math.round(img.height * scale);

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0, width, height);

  return canvas.convertToBlob({ type: 'image/jpeg', quality });
}

/**
 * Create small thumbnail for preview.
 */
async function createThumbnail(
  blob: Blob,
  maxW: number,
  maxH: number,
): Promise<string> {
  const img = await createImageBitmap(blob);
  const scale = Math.min(maxW / img.width, maxH / img.height, 1);
  const width = Math.round(img.width * scale);
  const height = Math.round(img.height * scale);

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0, width, height);

  const thumbBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.6 });
  return blobToDataUrl(thumbBlob);
}

/**
 * Convert blob to base64 data URL.
 */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Check if filename is a code file.
 */
function isCodeFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  return SUPPORTED_CODE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Get total size of attachments in bytes.
 */
export function getTotalAttachmentSize(attachments: AttachmentData[]): number {
  return attachments.reduce((sum, attachment) => {
    const contentLength = attachment.content.length;
    const fallbackBytes = attachment.sizeBytes ?? 0;
    const size = contentLength > 0 ? contentLength : fallbackBytes;
    return sum + size;
  }, 0);
}

