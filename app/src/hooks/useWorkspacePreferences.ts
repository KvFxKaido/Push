import { useCallback, useEffect, useState } from 'react';
import { useUserProfile } from '@/hooks/useUserProfile';
import { useSetting } from '@/hooks/useSetting';
import { getApprovalMode, setApprovalMode, type ApprovalMode } from '@/lib/approval-mode';
import { safeStorageGet } from '@/lib/safe-storage';
import { SETTINGS_KEYS } from '@/lib/settings-store';

// Pre-unification localStorage key, read once as a fallback.
const TOOL_ACTIVITY_STORAGE_KEY = 'push:workspace:show-tool-activity';
const ALLOWLIST_SECRET_COMMAND = 'npx wrangler secret put GITHUB_ALLOWED_INSTALLATION_IDS';

const coerceBoolean = (raw: unknown): boolean | undefined =>
  typeof raw === 'boolean' ? raw : undefined;

// The token budget is stored as a positive number (cap) or `null` (off). A
// non-positive number normalizes to `null`; anything else is "no opinion"
// (→ fall back to the default off).
const coerceTokenBudget = (raw: unknown): number | null | undefined => {
  if (raw === null) return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw > 0 ? raw : null;
  return undefined;
};

function legacyToolActivity(): boolean | undefined {
  const raw = safeStorageGet(TOOL_ACTIVITY_STORAGE_KEY);
  if (raw === null) return undefined;
  return raw === '1';
}

export function useWorkspacePreferences(validatedGithubLogin: string | null | undefined) {
  const { profile, updateProfile, clearProfile } = useUserProfile();
  const [displayNameDraftState, setDisplayNameDraftState] = useState<string | null>(null);
  const [bioDraftState, setBioDraftState] = useState<string | null>(null);
  const [chatInstructionsDraftState, setChatInstructionsDraftState] = useState<string | null>(null);
  const [installIdInput, setInstallIdInput] = useState('');
  const [showInstallIdInput, setShowInstallIdInput] = useState(false);
  const [showToolActivity, setShowToolActivityValue] = useSetting<boolean>(
    SETTINGS_KEYS.showToolActivity,
    false,
    { coerce: coerceBoolean, legacyFallback: legacyToolActivity },
  );
  const [providerFailover, setProviderFailoverValue] = useSetting<boolean>(
    SETTINGS_KEYS.providerFailover,
    false,
    { coerce: coerceBoolean },
  );
  const [runTokenBudget, setRunTokenBudgetValue] = useSetting<number | null>(
    SETTINGS_KEYS.runTokenBudget,
    null,
    { coerce: coerceTokenBudget },
  );
  const [approvalMode, setApprovalModeState] = useState<ApprovalMode>(() => getApprovalMode());

  useEffect(() => {
    if (!validatedGithubLogin || validatedGithubLogin === profile.githubLogin) return;
    updateProfile({ githubLogin: validatedGithubLogin });
  }, [profile.githubLogin, updateProfile, validatedGithubLogin]);

  const displayNameDraft = displayNameDraftState ?? profile.displayName;
  const bioDraft = bioDraftState ?? profile.bio;
  const chatInstructionsDraft = chatInstructionsDraftState ?? (profile.chatInstructions || '');

  const setDisplayNameDraft = useCallback((value: string) => {
    setDisplayNameDraftState(value);
  }, []);

  const setBioDraft = useCallback((value: string) => {
    setBioDraftState(value);
  }, []);

  const setChatInstructionsDraft = useCallback((value: string) => {
    setChatInstructionsDraftState(value);
  }, []);

  const copyAllowlistCommand = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(ALLOWLIST_SECRET_COMMAND);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = ALLOWLIST_SECRET_COMMAND;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }
  }, []);

  const updateApprovalMode = useCallback((mode: ApprovalMode) => {
    setApprovalMode(mode);
    setApprovalModeState(mode);
  }, []);

  const updateShowToolActivity = useCallback(
    (value: boolean) => {
      setShowToolActivityValue(value);
    },
    [setShowToolActivityValue],
  );

  const updateProviderFailover = useCallback(
    (value: boolean) => {
      setProviderFailoverValue(value);
    },
    [setProviderFailoverValue],
  );

  const updateRunTokenBudget = useCallback(
    (value: number | null) => {
      setRunTokenBudgetValue(value);
    },
    [setRunTokenBudgetValue],
  );

  const handleDisplayNameBlur = useCallback(() => {
    const nextDisplayName = displayNameDraft.trim();
    if (nextDisplayName !== profile.displayName) {
      updateProfile({ displayName: nextDisplayName });
    }
    setDisplayNameDraftState(null);
  }, [displayNameDraft, profile.displayName, updateProfile]);

  const handleBioBlur = useCallback(() => {
    const nextBio = bioDraft.slice(0, 300);
    if (nextBio !== profile.bio) {
      updateProfile({ bio: nextBio });
    }
    setBioDraftState(null);
  }, [bioDraft, profile.bio, updateProfile]);

  const handleChatInstructionsBlur = useCallback(() => {
    const nextInstructions = chatInstructionsDraft.slice(0, 4000);
    if (nextInstructions !== (profile.chatInstructions || '')) {
      updateProfile({ chatInstructions: nextInstructions });
    }
    setChatInstructionsDraftState(null);
  }, [chatInstructionsDraft, profile.chatInstructions, updateProfile]);

  const handleClearProfile = useCallback(() => {
    clearProfile();
    setDisplayNameDraftState(null);
    setBioDraftState(null);
    setChatInstructionsDraftState(null);
  }, [clearProfile]);

  return {
    profile,
    updateProfile,
    clearProfile: handleClearProfile,
    displayNameDraft,
    setDisplayNameDraft,
    handleDisplayNameBlur,
    bioDraft,
    setBioDraft,
    handleBioBlur,
    chatInstructionsDraft,
    setChatInstructionsDraft,
    handleChatInstructionsBlur,
    installIdInput,
    setInstallIdInput,
    showInstallIdInput,
    setShowInstallIdInput,
    showToolActivity,
    updateShowToolActivity,
    providerFailover,
    updateProviderFailover,
    runTokenBudget,
    updateRunTokenBudget,
    approvalMode,
    updateApprovalMode,
    allowlistSecretCmd: ALLOWLIST_SECRET_COMMAND,
    copyAllowlistCommand,
  };
}
