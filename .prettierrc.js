// Mirrors the Ambire app's config. ubrn runs prettier over the TypeScript it
// generates, so this is what the committed bindings were formatted with and
// what CI needs to reproduce them byte for byte.
module.exports = {
  printWidth: 100,
  singleQuote: true,
  semi: false,
  useTabs: false,
  tabWidth: 2,
  bracketSpacing: true,
  trailingComma: 'none'
}
