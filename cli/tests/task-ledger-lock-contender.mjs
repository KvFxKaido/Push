// Child process for the task-ledger lock contention test
// (task-ledger.test.mjs). Not a test file itself: it waits for a shared
// start signal, attempts one optimistic save, and reports the outcome on
// stdout so the parent can count how many writers got through the lock.
import { existsSync } from 'node:fs';

import { saveTaskLedger, TaskLedgerRevisionConflictError } from '../task-ledger-store.ts';

const { CONTENDER_ID, CONTENDER_GO_FILE, CONTENDER_EXPECTED_REVISION, CONTENDER_SCOPE } =
  process.env;
const scope = JSON.parse(CONTENDER_SCOPE);

process.stdout.write('ready\n');
while (!existsSync(CONTENDER_GO_FILE)) {
  await new Promise((resolve) => setTimeout(resolve, 1));
}

try {
  await saveTaskLedger(
    scope,
    [
      {
        id: `writer-${CONTENDER_ID}`,
        content: `Writer ${CONTENDER_ID}`,
        activeForm: `Running ${CONTENDER_ID}`,
        status: 'in_progress',
      },
    ],
    { expectedRevision: Number(CONTENDER_EXPECTED_REVISION) },
  );
  process.stdout.write('result:ok\n');
} catch (error) {
  if (error instanceof TaskLedgerRevisionConflictError) {
    process.stdout.write('result:conflict\n');
  } else {
    process.stdout.write(`result:error:${error?.message ?? error}\n`);
  }
}
