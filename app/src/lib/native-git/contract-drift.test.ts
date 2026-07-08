import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');

function read(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

function sorted(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort();
}

function tsInterfaceMethods(src: string): string[] {
  return sorted(Array.from(src.matchAll(/^\s{2}([A-Za-z]\w*)\(options:/gm), (match) => match[1]));
}

function webStubMethods(src: string): string[] {
  return sorted(
    Array.from(src.matchAll(/^\s{2}([A-Za-z]\w*)\(\): Promise<never>/gm), (match) => match[1]),
  );
}

function androidPluginMethods(src: string): string[] {
  return sorted(
    Array.from(src.matchAll(/@PluginMethod\s+fun\s+([A-Za-z]\w*)/g), (match) => match[1]),
  );
}

describe('native git plugin contract drift', () => {
  it('keeps app, plugin, web stub, and Android method names in sync', () => {
    const appContract = tsInterfaceMethods(read('app/src/lib/native-git/definitions.ts'));
    const pluginContract = tsInterfaceMethods(
      read('plugins/capacitor-native-git/src/definitions.ts'),
    );
    const webStub = webStubMethods(read('plugins/capacitor-native-git/src/web.ts'));
    const androidPlugin = androidPluginMethods(
      read(
        'plugins/capacitor-native-git/android/src/main/java/com/push/nativegit/NativeGitPlugin.kt',
      ),
    );

    expect(appContract).toEqual(pluginContract);
    expect(webStub).toEqual(appContract);
    expect(androidPlugin).toEqual(appContract);
    expect(appContract).toContain('lsRemoteHead');
  });
});
