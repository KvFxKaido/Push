import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');

function read(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

function sorted(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort();
}

function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true);
}

const printer = ts.createPrinter({ removeComments: true });

/**
 * Every interface member in the file as `Interface.member` → its normalized
 * signature text (comments stripped, whitespace collapsed). Signature-level so
 * a param/return-shape divergence between the hand-synced app and plugin
 * copies fails the diff, not just a missing method name (#1358) — and helper
 * types the methods reference (`NativeGitDirArg`, …) are covered by the same
 * map instead of hiding behind a matching type name.
 */
function interfaceSignatures(path: string): Record<string, string> {
  const sourceFile = parse(path);
  const signatures: Record<string, string> = {};
  for (const statement of sourceFile.statements) {
    if (!ts.isInterfaceDeclaration(statement)) continue;
    for (const member of statement.members) {
      if (!member.name || !ts.isIdentifier(member.name)) continue;
      signatures[`${statement.name.text}.${member.name.text}`] = printer
        .printNode(ts.EmitHint.Unspecified, member, sourceFile)
        .replace(/\s+/g, ' ')
        .trim();
    }
  }
  return signatures;
}

function pluginMethodNames(signatures: Record<string, string>): string[] {
  return sorted(
    Object.keys(signatures)
      .filter((key) => key.startsWith('NativeGitPlugin.'))
      .map((key) => key.slice('NativeGitPlugin.'.length)),
  );
}

/** Public method names of a class (the web stub's reject-everything surface). */
function classMethodNames(path: string, className: string): string[] {
  const sourceFile = parse(path);
  const names: string[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isClassDeclaration(statement) || statement.name?.text !== className) continue;
    for (const member of statement.members) {
      if (!ts.isMethodDeclaration(member) || !ts.isIdentifier(member.name)) continue;
      const isPrivate = member.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword,
      );
      if (!isPrivate) names.push(member.name.text);
    }
  }
  return sorted(names);
}

function androidPluginMethods(src: string): string[] {
  return sorted(
    Array.from(src.matchAll(/@PluginMethod\s+fun\s+([A-Za-z]\w*)/g), (match) => match[1]),
  );
}

describe('native git plugin contract drift', () => {
  const appSignatures = interfaceSignatures('app/src/lib/native-git/definitions.ts');

  it('keeps app and plugin interface signatures in sync', () => {
    const pluginSignatures = interfaceSignatures('plugins/capacitor-native-git/src/definitions.ts');
    expect(Object.keys(appSignatures)).not.toHaveLength(0);
    expect(appSignatures).toEqual(pluginSignatures);
  });

  it('keeps web stub and Android method names in sync with the contract', () => {
    const appContract = pluginMethodNames(appSignatures);
    const webStub = classMethodNames('plugins/capacitor-native-git/src/web.ts', 'NativeGitWeb');
    const androidPlugin = androidPluginMethods(
      read(
        'plugins/capacitor-native-git/android/src/main/java/com/push/nativegit/NativeGitPlugin.kt',
      ),
    );

    expect(appContract).toContain('lsRemoteHead');
    expect(webStub).toEqual(appContract);
    expect(androidPlugin).toEqual(appContract);
  });
});
