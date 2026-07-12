import React from 'react';
import { Box, Text } from 'silvery';

export function HelloPush() {
  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Box>
        <Text color="$fg-accent" bold>
          Push
        </Text>
        <Text color="$fg-muted"> · silvery preview</Text>
      </Box>
      <Text>Retained-mode terminal surface is ready.</Text>
    </Box>
  );
}
