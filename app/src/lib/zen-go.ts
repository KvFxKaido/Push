// Compatibility shim for existing app imports. The catalog and transport
// predicate live in shared lib because capability resolution also consumes them.
export {
  getZenGoTransport,
  ZEN_GO_DEFAULT_MODEL,
  ZEN_GO_MODELS,
  type ZenGoTransport,
} from '@push/lib/zen-go';
