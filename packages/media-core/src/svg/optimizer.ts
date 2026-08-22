/**
 * SVG Optimizer — lightweight post-processing for cleaner, smaller SVG output
 *
 * Performs these optimizations without external dependencies:
 *   1. Remove empty <defs> blocks
 *   2. Remove empty <g> elements
 *   3. Remove unnecessary XML declaration for inline use
 *   4. Trim numeric precision (6+ decimals → 3)
 *   5. Remove redundant default attributes
 *   6. Collapse whitespace between tags
 *   7. Remove comments
 *   8. Remove empty text nodes
 *   9. Normalize &nbsp; → &#160; for SVG compatibility
 */

export interface SvgOptimizeOptions {
  /** Max decimal precision for numeric values (default: 3) */
  precision?: number;
  /** Remove XML declaration (default: false — keep for standalone SVG) */
  removeXmlDecl?: boolean;
  /** Remove comments (default: true) */
  removeComments?: boolean;
}

/**
 * Optimize an SVG string for smaller file size and cleaner output.
 */
export function optimizeSvg(svgString: string, options: SvgOptimizeOptions = {}): string {
  const {
    precision = 3,
    removeXmlDecl = false,
    removeComments = true,
  } = options;

  let svg = svgString;

  // 1. Remove XML comments
  if (removeComments) {
    svg = svg.replace(/<!--[\s\S]*?-->/g, '');
  }

  // 2. Remove XML declaration if requested
  if (removeXmlDecl) {
    svg = svg.replace(/<\?xml[^?]*\?>\s*/g, '');
  }

  // 3. Remove empty <defs></defs>
  svg = svg.replace(/<defs\s*\/>/g, '');
  svg = svg.replace(/<defs>\s*<\/defs>/g, '');

  // 4. Remove empty <g></g> elements (iterate for nested empties)
  let prevLen: number;
  do {
    prevLen = svg.length;
    svg = svg.replace(/<g[^>]*>\s*<\/g>/g, '');
  } while (svg.length !== prevLen);

  // 5. Remove empty path elements (d="")
  svg = svg.replace(/<path[^>]*\bd=""\s*[^>]*\/>/g, '');

  // 6. Trim numeric precision in attribute values
  svg = svg.replace(/="-?\d+\.\d{4,}"/g, (match) => {
    const eq = match.indexOf('=');
    const num = parseFloat(match.slice(eq + 2, -1));
    return `=${match[eq + 1]}${roundNum(num, precision)}${match[match.length - 1]}`;
  });

  // 7. Remove redundant default attributes
  svg = svg.replace(/\s+fill-opacity="1"/g, '');
  svg = svg.replace(/\s+stroke-opacity="1"/g, '');
  svg = svg.replace(/\s+opacity="1"/g, '');

  // 8. Collapse multiple spaces/newlines between tags
  svg = svg.replace(/>\s{2,}</g, '>\n<');

  // 9. Normalize &nbsp;
  svg = svg.replace(/&nbsp;/g, '&#160;');

  // 10. Remove trailing whitespace
  svg = svg.replace(/[ \t]+$/gm, '');

  // 11. Remove consecutive blank lines
  svg = svg.replace(/\n{3,}/g, '\n\n');

  return svg.trim();
}

/**
 * Round a number to the given decimal places, removing trailing zeros.
 */
function roundNum(num: number, precision: number): string {
  const rounded = num.toFixed(precision);
  // Remove trailing zeros after decimal point
  if (rounded.includes('.')) {
    return rounded.replace(/\.?0+$/, '') || '0';
  }
  return rounded;
}
