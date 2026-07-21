// Compatibility facade: CLI callers keep their local import while deterministic
// search/replace semantics are shared with the web runtime from lib/.
export {
  applySearchReplace,
  type SearchReplaceArgs,
  type SearchReplaceMatch,
  type SearchReplaceResult,
} from '../lib/search-replace.ts';
