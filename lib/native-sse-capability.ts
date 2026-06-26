export const PUSH_NATIVE_SSE_HEADER = 'X-Push-Native-SSE';
export const PUSH_NATIVE_SSE_HEADER_VALUE = '1';

export function hasPushNativeSseCapability(headers: Headers): boolean {
  return headers.get(PUSH_NATIVE_SSE_HEADER)?.trim() === PUSH_NATIVE_SSE_HEADER_VALUE;
}
