// Vite resolves these imports to the bundled asset URL.
declare module '*.png' {
  const url: string;
  export default url;
}
