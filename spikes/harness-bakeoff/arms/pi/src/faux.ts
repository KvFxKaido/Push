// Plumbing check only (FAUX=1): a scripted stand-in for the model, so the Pi loop, the
// container tools, and recovery can be exercised without credentials. Never used by a real run.
// Each step is chosen from the transcript the request carries, not from memory, so the script
// survives a wrangler dev restart and can be used for the interruption test.
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';

export function scriptedProvider(provider: string, model: string) {
  const faux = fauxProvider({ provider, models: [{ id: model }] });
  const step = (n: number) => {
    switch (n) {
      case 0:
        return fauxAssistantMessage(
          [
            fauxToolCall('read_file', { path: 'src/slugify.js' }),
            fauxToolCall('run_command', { command: 'ls -a && npm test 2>&1 | tail -5' }),
          ],
          { stopReason: 'toolUse' },
        );
      case 1:
        // Long enough to kill wrangler dev while it runs.
        return fauxAssistantMessage(
          [fauxToolCall('run_command', { command: 'sleep 20; echo slept' })],
          { stopReason: 'toolUse' },
        );
      case 2:
        return fauxAssistantMessage(
          [fauxToolCall('write_file', { path: 'scratch/probe.txt', content: 'probe\n' })],
          { stopReason: 'toolUse' },
        );
      case 3:
        return fauxAssistantMessage(
          [fauxToolCall('run_command', { command: 'git status --short' })],
          { stopReason: 'toolUse' },
        );
      default:
        return fauxAssistantMessage(fauxText('faux run done'));
    }
  };
  const responder = (context: { messages: readonly { role: string }[] }) =>
    step(context.messages.filter((m) => m.role === 'assistant').length);
  faux.setResponses(Array.from({ length: 50 }, () => responder));
  return faux.provider;
}
