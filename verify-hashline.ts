import { calculateLineHash, applyHashlineEdits } from './app/src/lib/hashline';

async function test() {
  const line = "  console.log('hello');";
  const hash = await calculateLineHash(line);
  console.log(`Computed hash for [${line}]: ${hash}`);

  const content = "export function hello() {\n  console.log('hello');\n}\n";
  const edits = [
    { op: 'replace_line', ref: hash, content: "  console.log('Hashline lives!');" }
  ];

  const result = await applyHashlineEdits(content, edits);
  console.log('Result Content:\n' + result.content);
  console.log('Applied:', result.applied);
}

test();