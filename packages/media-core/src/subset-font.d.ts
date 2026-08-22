declare module 'subset-font' {
  export default function subsetFont(
    buffer: Buffer | Uint8Array,
    text: string,
    options?: { targetFormat?: 'woff2' | 'woff' | 'sfnt' | 'truetype' },
  ): Promise<Buffer>
}
