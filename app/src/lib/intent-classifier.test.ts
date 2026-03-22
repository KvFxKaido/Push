import { describe, it, expect } from 'vitest';
import { classifyIntent } from './intent-classifier';

describe('classifyIntent', () => {
  it('classifies discovery requests correctly', () => {
    expect(classifyIntent('how does the auth flow work?')).toBe('discovery');
    expect(classifyIntent('trace the logic of the login function')).toBe('discovery');
    expect(classifyIntent('where is the user profile page?')).toBe('discovery');
    expect(classifyIntent('what depends on the auth module?')).toBe('discovery');
    expect(classifyIntent('why does the build fail for the app?')).toBe('discovery');
    expect(classifyIntent('investigate the cause of the race condition')).toBe('discovery');
    expect(classifyIntent('find all usages of the logger function')).toBe('discovery');
    expect(classifyIntent('understand the role-based access control')).toBe('discovery');
    expect(classifyIntent('explore the codebase for the new feature')).toBe('discovery');
  });

  it('classifies implementation requests correctly', () => {
    expect(classifyIntent('add a dark mode toggle to the settings page')).toBe('implementation');
    expect(classifyIntent('fix the bug in the login function')).toBe('implementation');
    expect(classifyIntent('refactor the auth module for better readability')).toBe('implementation');
    expect(classifyIntent('implement a new API endpoint for user data')).toBe('implementation');
    expect(classifyIntent('create a new component for the navigation bar')).toBe('implementation');
    expect(classifyIntent('update the user profile page with new fields')).toBe('implementation');
    expect(classifyIntent('remove the deprecated logger function')).toBe('implementation');
    expect(classifyIntent('change the color theme for the app')).toBe('implementation');
    expect(classifyIntent('ship the feature for the user profile')).toBe('implementation');
    expect(classifyIntent('improve the performance of the auth module')).toBe('implementation');
  });

  it('classifies other requests correctly', () => {
    expect(classifyIntent('hello there!')).toBe('other');
    expect(classifyIntent('what time is it?')).toBe('other');
    expect(classifyIntent('tell me a joke')).toBe('other');
    expect(classifyIntent('short')).toBe('other');
  });
});
