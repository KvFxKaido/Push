/**
 * UploadButton — floating action button that opens the native file picker.
 *
 * Uses a hidden <input type="file"> triggered by a styled button.
 * Supports multi-file selection. Positioned bottom-right with safe-area.
 */

import { useRef } from 'react';
import { Upload } from 'lucide-react';

interface UploadButtonProps {
  onUpload: (files: FileList) => void;
  disabled?: boolean;
}

export function UploadButton({ onUpload, disabled }: UploadButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleClick = () => {
    inputRef.current?.click();
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      onUpload(files);
    }
    // Reset so the same file can be re-selected
    if (inputRef.current) {
      inputRef.current.value = '';
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        onChange={handleChange}
        className="hidden"
        aria-hidden="true"
      />
      <button
        onClick={handleClick}
        disabled={disabled}
        className="fixed bottom-6 right-6 z-30 flex h-12 w-12 items-center justify-center rounded-full bg-push-accent text-white shadow-lg shadow-push-accent/25 transition-all duration-200 hover:bg-[#0060d3] active:scale-95 disabled:opacity-40 disabled:pointer-events-none"
        title="Upload files"
        aria-label="Upload files"
      >
        <Upload className="h-5 w-5" />
      </button>
    </>
  );
}
