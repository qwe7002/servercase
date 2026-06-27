// HTML files are bundled as text modules (see the [[rules]] block in
// wrangler.toml) and imported as their string contents.
declare module '*.html' {
  const content: string;
  export default content;
}
