export default {
  plugins: {
    // Tailwind v4 ships its PostCSS plugin as a separate package and bundles
    // vendor-prefixing (Lightning CSS) in-engine, so autoprefixer is dropped.
    '@tailwindcss/postcss': {},
  },
};
