// view-transition-name must be a valid CSS custom-ident. Memory ids are UUIDs
// (or `mem-…`); the constant prefix guarantees a leading letter, and we scrub
// any stray characters so the morph name never breaks the transition. Shared by
// the gallery card and the editor panel so the tapped card and the editor claim
// the same name and the browser morphs between them.
export function cardViewTransitionName(id: string): string {
  return `scratch-card-${id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}
