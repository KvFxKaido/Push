const VALID_GIT_REF = /^[A-Za-z0-9._/-]+$/;

export const GIT_REF_VALIDATION_DETAIL =
  'Branch refs may contain letters, digits, ".", "_", "/", "-" and may not start with "-", may not start or end with "/", and may not contain "..".';

export function isInvalidGitRef(ref: string): boolean {
  return (
    !VALID_GIT_REF.test(ref) ||
    ref.startsWith('-') ||
    ref.startsWith('/') ||
    ref.endsWith('/') ||
    ref.includes('..')
  );
}
