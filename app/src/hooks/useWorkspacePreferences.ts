import { useCallback, useEffect, useState } from 'react';
import { useUserProfile } from '@/hooks/useUserProfile';
import { getApprovalMode, setApprovalMode, type ApprovalMode } from '@/lib/approval-mode';
import { getContextMode, setContextMode, type ContextMode } from '@/lib/orchestrator';
import {
  getSandboxStartMode,
  setSandboxStartMode,
  type SandboxStartMode,
} from '@/lib/sandbox-start-mode';

const TOOL_ACTIVITY_STORAGE_KEY = 'push:workspace:show-tool-activity';
const ALLOWLIST_SECRET_COMMAND = 'npx wrangler secret put GITHUB_ALLOWED_INSTALLATION_IDS';

export function useWorkspacePreferences(validatedGithubLogin: string | null | undefined) {
  const { profile, updateProfile, clearProfile } = useUserProfile();
  const [displayNameDraftState, setDisplayNameDraftState] = useState<string | null>(null);
  const [bioDraftState, setBioDraftState] = useState<string | null>(null);
  const [chatInstructionsDraftState, setChatInstructionsDraftState] = useState<string | null>(null);
  const [installIdInput, setInstallIdInput] = useState('');
  const [showInstallIdInput, setShowInstallIdInput] = useState(false);
  const [showToolActivity, setShowToolActivityState] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(TOOL_ACTIVITY_STORAGE_KEY) === '1';
  });
  const [sandboxStartMode, setSandboxStartModeState] = useState<SandboxStartMode>(() =>
    getSandboxStartMode(),
  );
  const [contextMode, setContextModeState] = useState<ContextMode>(() => getContextMode());
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

  const updateContextMode = useCallback((mode: ContextMode) => {
    setContextMode(mode);
    setContextModeState(mode);
  }, []);

  const updateApprovalMode = useCallback((mode: ApprovalMode) => {
    setApprovalMode(mode);
    setApprovalModeState(mode);
  }, []);

  const updateSandboxStartMode = useCallback((mode: SandboxStartMode) => {
    setSandboxStartMode(mode);
    setSandboxStartModeState(mode);
  }, []);

  const updateShowToolActivity = useCallback((value: boolean) => {
    setShowToolActivityState(value);
    if (typeof window === 'undefined') return;
    if (value) {
      window.localStorage.setItem(TOOL_ACTIVITY_STORAGE_KEY, '1');
    } else {
      window.localStorage.removeItem(TOOL_ACTIVITY_STORAGE_KEY);
    }
  }, []);

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
    sandboxStartMode,
    updateSandboxStartMode,
    contextMode,
    updateContextMode,
    approvalMode,
    updateApprovalMode,
    allowlistSecretCmd: ALLOWLIST_SECRET_COMMAND,
    copyAllowlistCommand,
  };
}
