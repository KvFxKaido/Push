import { useCallback } from 'react';
import type { UserProfile } from '../types';
import { USER_PROFILE_DEFAULTS } from '../types';
import { safeStorageGet } from '@/lib/safe-storage';
import { getSetting, SETTINGS_KEYS, setSetting } from '@/lib/settings-store';
import { useSetting } from './useSetting';

const LEGACY_KEY = 'push_user_profile';
const MAX_BIO_LENGTH = 300;
const MAX_CHAT_INSTRUCTIONS_LENGTH = 4000;

function coerce(raw: unknown): UserProfile | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  return { ...USER_PROFILE_DEFAULTS, ...(raw as Partial<UserProfile>) };
}

function legacyProfile(): UserProfile | undefined {
  const stored = safeStorageGet(LEGACY_KEY);
  if (!stored) return undefined;
  try {
    return coerce(JSON.parse(stored));
  } catch {
    return undefined;
  }
}

/**
 * Standalone getter — callable from orchestrator.ts without React. Reads the
 * unified settings cache (hydrated synchronously from the localStorage mirror at
 * import, reconciled with the server at boot), falling back to the pre-migration
 * localStorage value, then defaults.
 */
export function getUserProfile(): UserProfile {
  const stored = getSetting<unknown>(SETTINGS_KEYS.userProfile);
  return coerce(stored) ?? legacyProfile() ?? { ...USER_PROFILE_DEFAULTS };
}

function clampProfile(profile: UserProfile): UserProfile {
  const merged = { ...profile };
  if (merged.bio.length > MAX_BIO_LENGTH) {
    merged.bio = merged.bio.slice(0, MAX_BIO_LENGTH);
  }
  if (merged.chatInstructions && merged.chatInstructions.length > MAX_CHAT_INSTRUCTIONS_LENGTH) {
    merged.chatInstructions = merged.chatInstructions.slice(0, MAX_CHAT_INSTRUCTIONS_LENGTH);
  }
  return merged;
}

/**
 * React hook for Settings UI — manage user profile (name, bio, GitHub login).
 */
export function useUserProfile() {
  const [profile, setProfileValue] = useSetting<UserProfile>(
    SETTINGS_KEYS.userProfile,
    { ...USER_PROFILE_DEFAULTS },
    { coerce, legacyFallback: legacyProfile },
  );

  const updateProfile = useCallback(
    (partial: Partial<UserProfile>) => {
      setProfileValue(clampProfile({ ...profile, ...partial }));
    },
    [profile, setProfileValue],
  );

  const clearProfile = useCallback(() => {
    setSetting(SETTINGS_KEYS.userProfile, { ...USER_PROFILE_DEFAULTS });
  }, []);

  return { profile, updateProfile, clearProfile };
}
