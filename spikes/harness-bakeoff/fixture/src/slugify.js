// Turn arbitrary titles into URL slugs: lowercase ASCII words joined by
// single dashes, no leading or trailing dash.
export function slugify(input) {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/, '-')
    .replace(/^-/, '');
}
