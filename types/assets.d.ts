/**
 * Static image assets imported from source.
 *
 * Metro turns `import x from './y.png'` into a registered asset and hands back its number; Jest's
 * transformer hands back a number too. Without this declaration the import is an error, and the
 * alternative -- `require` with a lint suppression on top -- is noisier for no gain.
 */
declare module '*.png' {
  const asset: number;
  export default asset;
}
