/**
 * Font Registry — curated font catalog with CDN URL resolution
 *
 * Shared between design-engine (canvas + export) and tabvideo-engine (video export).
 * Agents reference fonts by family name; the registry resolves them to download URLs.
 *
 * Supports:
 *   - Google Fonts CDN (stable versioned URLs)
 *   - CJK fonts (Noto Sans SC/TC/JP/KR, Noto Serif SC/TC/JP/KR)
 *   - Category-based lookup (sans-serif, serif, monospace, display, handwriting)
 *   - Case-insensitive family name matching
 *   - Closest-weight resolution for variable fonts
 *   - Dynamic runtime registration / unregistration
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FontRegistryEntry {
  family: string;
  category: 'sans-serif' | 'serif' | 'monospace' | 'display' | 'handwriting';
  weights: number[];
  /** Static URL for the font file (Google Fonts CDN). */
  urlPattern: string;
  /** Whether the font supports CJK characters. */
  cjk?: boolean;
}

export interface ResolvedFont {
  url: string;
  resolvedFamily: string;
  weights: number[];
  cjk: boolean;
}

// ---------------------------------------------------------------------------
// Built-in registry data — Google Fonts CDN (stable versioned URLs)
// Synced with backend font_service.py catalog (67+ fonts) plus extra CJK.
// ---------------------------------------------------------------------------

const BUILTIN_ENTRIES: FontRegistryEntry[] = [
  // =========================================================================
  // CJK — Simplified Chinese
  // =========================================================================
  {
    family: 'Noto Sans SC',
    category: 'sans-serif',
    weights: [100, 300, 400, 500, 700, 900],
    urlPattern:
      'https://fonts.gstatic.com/s/notosanssc/v37/k3kCo84MPvpLmixcA63oeAL7Iqp5IZJF9bmaG9_FnYxNbPzS5HE.ttf',
    cjk: true,
  },
  {
    family: 'Noto Serif SC',
    category: 'serif',
    weights: [200, 300, 400, 500, 600, 700, 900],
    urlPattern:
      'https://fonts.gstatic.com/s/notoserifsc/v30/H4c8BXePl9DZ0Xe7gG9cyOj7oqPccAhSpM4Awr0.otf',
    cjk: true,
  },
  // =========================================================================
  // CJK — Traditional Chinese
  // =========================================================================
  {
    family: 'Noto Sans TC',
    category: 'sans-serif',
    weights: [100, 300, 400, 500, 700, 900],
    urlPattern:
      'https://fonts.gstatic.com/s/notosanstc/v36/nKKQ-GM_FYFRJvXzVXaAPe97P1KHynJFP716qKQ.otf',
    cjk: true,
  },
  {
    family: 'Noto Serif TC',
    category: 'serif',
    weights: [200, 300, 400, 500, 600, 700, 900],
    urlPattern:
      'https://fonts.gstatic.com/s/notoseriftc/v30/XLYgIZb5bJNDGYxLBiLscCTyI-tPLU80fkzEEQ.otf',
    cjk: true,
  },
  // =========================================================================
  // CJK — Japanese
  // =========================================================================
  {
    family: 'Noto Sans JP',
    category: 'sans-serif',
    weights: [100, 300, 400, 500, 700, 900],
    urlPattern:
      'https://fonts.gstatic.com/s/notosansjp/v53/nKKF-GM_FYFRJvXzVXaAPe97P1KHynJFP716qKQ.otf',
    cjk: true,
  },
  {
    family: 'Noto Serif JP',
    category: 'serif',
    weights: [200, 300, 400, 500, 600, 700, 900],
    urlPattern:
      'https://fonts.gstatic.com/s/notoserifjp/v28/xn7mYHs73mPB9R6FSnxvhRRukvqvTUc.otf',
    cjk: true,
  },
  // =========================================================================
  // CJK — Korean
  // =========================================================================
  {
    family: 'Noto Sans KR',
    category: 'sans-serif',
    weights: [100, 300, 400, 500, 700, 900],
    urlPattern:
      'https://fonts.gstatic.com/s/notosanskr/v36/PbykFmXiEBPT4ITbgNA5Cgm203Tq4JJWq200.otf',
    cjk: true,
  },
  {
    family: 'Noto Serif KR',
    category: 'serif',
    weights: [200, 300, 400, 500, 600, 700, 900],
    urlPattern:
      'https://fonts.gstatic.com/s/notoserifkr/v27/3JnmSDn90Gmq2mr3blnHaTZXduZp1ONy.otf',
    cjk: true,
  },
  // =========================================================================
  // Sans-Serif (synced with backend font_service.py)
  // =========================================================================
  {
    family: 'Inter',
    category: 'sans-serif',
    weights: [100, 200, 300, 400, 500, 600, 700, 800, 900],
    urlPattern:
      'https://fonts.gstatic.com/s/inter/v18/UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIw2boKoduKmMEVuLyfAZ9hiA.woff2',
  },
  {
    family: 'Roboto',
    category: 'sans-serif',
    weights: [100, 300, 400, 500, 700, 900],
    urlPattern:
      'https://fonts.gstatic.com/s/roboto/v47/KFOMCnqEu92Fr1ME7kSn66aGLdTylUAMQXC89YmC2DPNWubEbGmT.ttf',
  },
  {
    family: 'Open Sans',
    category: 'sans-serif',
    weights: [300, 400, 500, 600, 700, 800],
    urlPattern:
      'https://fonts.gstatic.com/s/opensans/v40/memSYaGs126MiZpBA-UvWbX2vVnXBbObj2OVZyOOSr4dVJWUgsjZ0B4gaVc.ttf',
  },
  {
    family: 'Montserrat',
    category: 'sans-serif',
    weights: [100, 200, 300, 400, 500, 600, 700, 800, 900],
    urlPattern:
      'https://fonts.gstatic.com/s/montserrat/v29/JTUHjIg1_i6t8kCHKm4532VJOt5-QNFgpCtr6Ew-Y3tcoqK5.ttf',
  },
  {
    family: 'Lato',
    category: 'sans-serif',
    weights: [100, 300, 400, 700, 900],
    urlPattern:
      'https://fonts.gstatic.com/s/lato/v24/S6uyw4BMUTPHjx4wXg.ttf',
  },
  {
    family: 'Poppins',
    category: 'sans-serif',
    weights: [100, 200, 300, 400, 500, 600, 700, 800, 900],
    urlPattern:
      'https://fonts.gstatic.com/s/poppins/v22/pxiEyp8kv8JHgFVrJJfecg.ttf',
  },
  {
    family: 'Nunito',
    category: 'sans-serif',
    weights: [200, 300, 400, 600, 700, 800, 900],
    urlPattern:
      'https://fonts.gstatic.com/s/nunito/v26/XRXI3I6Li01BKofiOc5wtlZ2di8HDLshRTY9jo7eTWk.ttf',
  },
  {
    family: 'Raleway',
    category: 'sans-serif',
    weights: [100, 200, 300, 400, 500, 600, 700, 800, 900],
    urlPattern:
      'https://fonts.gstatic.com/s/raleway/v34/1Ptxg8zYS_SKggPN4iEgvnHyvveLxVvaorCIPrE.ttf',
  },
  {
    family: 'Work Sans',
    category: 'sans-serif',
    weights: [100, 300, 400, 500, 600, 700, 800],
    urlPattern:
      'https://fonts.gstatic.com/s/worksans/v19/QGY_z_wNahGAdqQ43RhVcIgYT2Xz5u32K0nXNigDp6_cOg.ttf',
  },
  {
    family: 'DM Sans',
    category: 'sans-serif',
    weights: [400, 500, 700],
    urlPattern:
      'https://fonts.gstatic.com/s/dmsans/v15/rP2tp2ywxg089UriI5-g4vlH9VoD8CmcqZG40F9JadbnoEwAkJxh.ttf',
  },
  {
    family: 'Manrope',
    category: 'sans-serif',
    weights: [200, 300, 400, 500, 600, 700, 800],
    urlPattern:
      'https://fonts.gstatic.com/s/manrope/v15/xn7_YHE41ni1AdIRqAuZuw1Bx9mbZk59FO_F87jxeN7B.ttf',
  },
  {
    family: 'Plus Jakarta Sans',
    category: 'sans-serif',
    weights: [200, 300, 400, 500, 600, 700, 800],
    urlPattern:
      'https://fonts.gstatic.com/s/plusjakartasans/v8/LDIbaomQNQcsA88c7O9yZ4KMCoOg4IA6-91aHEjcWuA_KU7NShXUEKi4Rw.ttf',
  },
  {
    family: 'Source Sans 3',
    category: 'sans-serif',
    weights: [200, 300, 400, 600, 700, 900],
    urlPattern:
      'https://fonts.gstatic.com/s/sourcesans3/v15/nwpBtKy2OAdR1K-IwhWudF-R9QMylBJAV3Bo8Ky462EM.ttf',
  },
  {
    family: 'Figtree',
    category: 'sans-serif',
    weights: [300, 400, 500, 600, 700, 800],
    urlPattern:
      'https://fonts.gstatic.com/s/figtree/v6/_Xmz-HUzqDCFdgfMsYiV_F7wfS-Bs_d_QF5ewkEU4HTy0.ttf',
  },
  {
    family: 'Rubik',
    category: 'sans-serif',
    weights: [300, 400, 500, 600, 700, 800, 900],
    urlPattern:
      'https://fonts.gstatic.com/s/rubik/v28/iJWZBXyIfDnIV5PNhY1KTN7Z-Yh-B4i1UE80V4bVkA.ttf',
  },
  {
    family: 'Mulish',
    category: 'sans-serif',
    weights: [200, 300, 400, 500, 600, 700, 800, 900],
    urlPattern:
      'https://fonts.gstatic.com/s/mulish/v13/1Ptyg83HX_SGhgqO0yLcmjzUAuWexRNRwaClGrw-PTY.ttf',
  },
  {
    family: 'Cabin',
    category: 'sans-serif',
    weights: [400, 500, 600, 700],
    urlPattern:
      'https://fonts.gstatic.com/s/cabin/v27/u-4X0qWljRw-PfU81xCKCpdpbgZJl6XFpfEd7eA9BIxxkV2EH7alx0E.ttf',
  },
  {
    family: 'Quicksand',
    category: 'sans-serif',
    weights: [300, 400, 500, 600, 700],
    urlPattern:
      'https://fonts.gstatic.com/s/quicksand/v31/6xK-dSZaM9iE8KbpRA_LJ3z8mH9BOJvgkP8o58i-7A.ttf',
  },
  {
    family: 'Karla',
    category: 'sans-serif',
    weights: [200, 300, 400, 500, 600, 700, 800],
    urlPattern:
      'https://fonts.gstatic.com/s/karla/v31/qkBIXvYC6trAT55ZBi1ueQVIjQTD-JqqFENLR7fHGw.ttf',
  },
  {
    family: 'Ubuntu',
    category: 'sans-serif',
    weights: [300, 400, 500, 700],
    urlPattern:
      'https://fonts.gstatic.com/s/ubuntu/v20/4iCs6KVjbNBYlgoKfw72.ttf',
  },
  {
    family: 'Noto Sans',
    category: 'sans-serif',
    weights: [100, 200, 300, 400, 500, 600, 700, 800, 900],
    urlPattern:
      'https://fonts.gstatic.com/s/notosans/v36/o-0bIpQlx3QUlC5A4PNB6Ryti20_6n1iPHjc5a7du3mhPy0.ttf',
  },
  // System sans-serif (no CDN — use as reference placeholders)
  {
    family: 'Arial',
    category: 'sans-serif',
    weights: [400, 700],
    urlPattern:
      'https://fonts.gstatic.com/s/arial/v1/arial.ttf',
  },
  {
    family: 'Helvetica',
    category: 'sans-serif',
    weights: [300, 400, 700],
    urlPattern:
      'https://fonts.gstatic.com/s/helvetica/v1/helvetica.ttf',
  },
  // =========================================================================
  // Serif (synced with backend font_service.py)
  // =========================================================================
  {
    family: 'Playfair Display',
    category: 'serif',
    weights: [400, 500, 600, 700, 800, 900],
    urlPattern:
      'https://fonts.gstatic.com/s/playfairdisplay/v37/nuFvD-vYSZviVYUb_rj3ij__anPXJzDwcbmjWBN2PKdFvUDQZNLo_U2r.ttf',
  },
  {
    family: 'Merriweather',
    category: 'serif',
    weights: [300, 400, 700, 900],
    urlPattern:
      'https://fonts.gstatic.com/s/merriweather/v30/u-440qyriQwlOrhSvowK_l5-fCZM.ttf',
  },
  {
    family: 'Lora',
    category: 'serif',
    weights: [400, 500, 600, 700],
    urlPattern:
      'https://fonts.gstatic.com/s/lora/v35/0QI6MX1D_JOuGQbT0gvTJPa787weuyJGmKxemMeZ.ttf',
  },
  {
    family: 'PT Serif',
    category: 'serif',
    weights: [400, 700],
    urlPattern:
      'https://fonts.gstatic.com/s/ptserif/v18/EJRVQgYoZZY2vCFuvDFRxL6ddjb-.ttf',
  },
  {
    family: 'Libre Baskerville',
    category: 'serif',
    weights: [400, 700],
    urlPattern:
      'https://fonts.gstatic.com/s/librebaskerville/v16/kmKnZrc3Hgbbcjq75U4uslyuy4kqN1Y0aIQCeQ.ttf',
  },
  {
    family: 'EB Garamond',
    category: 'serif',
    weights: [400, 500, 600, 700, 800],
    urlPattern:
      'https://fonts.gstatic.com/s/ebgaramond/v27/SlGDmQSNjdsmc35JDF1K5E55YMjF_7DPuGi-6_RUAVhiXkA.ttf',
  },
  {
    family: 'Cormorant Garamond',
    category: 'serif',
    weights: [300, 400, 500, 600, 700],
    urlPattern:
      'https://fonts.gstatic.com/s/cormorantgaramond/v16/co3YmX5slCNuHLi8bLeY9MK7whWMhyjQAllvsA.ttf',
  },
  {
    family: 'Crimson Text',
    category: 'serif',
    weights: [400, 600, 700],
    urlPattern:
      'https://fonts.gstatic.com/s/crimsontext/v19/wlp2gwHKFkZgtmSR3NB0oRJfbwhT.ttf',
  },
  {
    family: 'DM Serif Display',
    category: 'serif',
    weights: [400],
    urlPattern:
      'https://fonts.gstatic.com/s/dmserifdisplay/v15/-nFnOHM81r4j6k0gjAW3mujVU2B2K_d09PvM.ttf',
  },
  {
    family: 'Bitter',
    category: 'serif',
    weights: [100, 400, 500, 700, 900],
    urlPattern:
      'https://fonts.gstatic.com/s/bitter/v36/raxhHiqOu8IVPmnRc6SY1KXhnF_Y8fbeCL_EXFh2reU.ttf',
  },
  {
    family: 'Noto Serif',
    category: 'serif',
    weights: [100, 200, 300, 400, 500, 600, 700, 800, 900],
    urlPattern:
      'https://fonts.gstatic.com/s/notoserif/v23/ga6iaw1J5X9T9RW6j9bNVls-hfgIq6a08g.ttf',
  },
  // System serif
  {
    family: 'Georgia',
    category: 'serif',
    weights: [400, 700],
    urlPattern:
      'https://fonts.gstatic.com/s/georgia/v1/georgia.ttf',
  },
  {
    family: 'Times New Roman',
    category: 'serif',
    weights: [400, 700],
    urlPattern:
      'https://fonts.gstatic.com/s/timesnewroman/v1/timesnewroman.ttf',
  },
  // =========================================================================
  // Monospace (synced with backend font_service.py)
  // =========================================================================
  {
    family: 'JetBrains Mono',
    category: 'monospace',
    weights: [100, 200, 300, 400, 500, 600, 700, 800],
    urlPattern:
      'https://fonts.gstatic.com/s/jetbrainsmono/v18/tDbY2o-flEEny0FZhsfKu5WU4zr3E_BX0PnT8RD8yKxjPVmUsaaDhw.ttf',
  },
  {
    family: 'Fira Code',
    category: 'monospace',
    weights: [300, 400, 500, 600, 700],
    urlPattern:
      'https://fonts.gstatic.com/s/firacode/v22/uU9NCBsR6Z2vfE9aq3bh0NSDulI4.ttf',
  },
  {
    family: 'Source Code Pro',
    category: 'monospace',
    weights: [200, 300, 400, 500, 600, 700, 900],
    urlPattern:
      'https://fonts.gstatic.com/s/sourcecodepro/v23/HI_diYsKILxRpg3hIP6sJ7fM7PqPMcMnZFqUwX28DEyQhM5hTXUcdJg.ttf',
  },
  {
    family: 'IBM Plex Mono',
    category: 'monospace',
    weights: [100, 300, 400, 500, 600, 700],
    urlPattern:
      'https://fonts.gstatic.com/s/ibmplexmono/v19/-F63fjptAgt5VM-kVkqdyU8n5igg1l9kn-s.ttf',
  },
  {
    family: 'Roboto Mono',
    category: 'monospace',
    weights: [100, 300, 400, 500, 700],
    urlPattern:
      'https://fonts.gstatic.com/s/robotomono/v23/L0xuDF4xlVMF-BfR8bXMIhJHg45mwgGEFl0_3vq_ROW4.ttf',
  },
  {
    family: 'Space Mono',
    category: 'monospace',
    weights: [400, 700],
    urlPattern:
      'https://fonts.gstatic.com/s/spacemono/v13/i7dPIFZifjKcF5UAWdDRYEF8RQ.ttf',
  },
  {
    family: 'Inconsolata',
    category: 'monospace',
    weights: [200, 300, 400, 500, 600, 700, 800, 900],
    urlPattern:
      'https://fonts.gstatic.com/s/inconsolata/v32/QldgNThLqRwH-OJ1UHjlKENVzkWGVkL3GZQmAwLYxYWI2qfdm7Lpp4U8aRr8.ttf',
  },
  // System monospace
  {
    family: 'Menlo',
    category: 'monospace',
    weights: [400, 700],
    urlPattern:
      'https://fonts.gstatic.com/s/menlo/v1/menlo.ttf',
  },
  // =========================================================================
  // Display (synced with backend font_service.py)
  // =========================================================================
  {
    family: 'Lobster',
    category: 'display',
    weights: [400],
    urlPattern:
      'https://fonts.gstatic.com/s/lobster/v30/neILzCirqoswsqX9zoKmM4MwWJU.ttf',
  },
  {
    family: 'Bebas Neue',
    category: 'display',
    weights: [400],
    urlPattern:
      'https://fonts.gstatic.com/s/bebasneue/v14/JTUSjIg69CK48gW7PXooxW5rygbi49c.ttf',
  },
  {
    family: 'Oswald',
    category: 'display',
    weights: [200, 300, 400, 500, 600, 700],
    urlPattern:
      'https://fonts.gstatic.com/s/oswald/v53/TK3_WkUHHAIjg75cFRf3bXL8LICs1_FvsUZiYA.ttf',
  },
  {
    family: 'Anton',
    category: 'display',
    weights: [400],
    urlPattern:
      'https://fonts.gstatic.com/s/anton/v25/1Ptgg87GROyAm3Kz-C8CSKlv.ttf',
  },
  {
    family: 'Abril Fatface',
    category: 'display',
    weights: [400],
    urlPattern:
      'https://fonts.gstatic.com/s/abrilfatface/v23/zOL64pLDlL1D99S8HAFadkHiHE9gRe5B.ttf',
  },
  {
    family: 'Righteous',
    category: 'display',
    weights: [400],
    urlPattern:
      'https://fonts.gstatic.com/s/righteous/v17/1cXxaUPXBpj2rGoU7C9mj3uEicG01A.ttf',
  },
  {
    family: 'Fredoka',
    category: 'display',
    weights: [300, 400, 500, 600, 700],
    urlPattern:
      'https://fonts.gstatic.com/s/fredoka/v14/X7nP4b87HvSqjb_WIi2yDCRwoQ_k7367_B-i2yQag0-mac3OryLMFuOLlNldbw.ttf',
  },
  {
    family: 'Comfortaa',
    category: 'display',
    weights: [300, 400, 500, 600, 700],
    urlPattern:
      'https://fonts.gstatic.com/s/comfortaa/v45/1Pt_g8LJRfWJmhDAuUsSQamb1W0lwk4S4WjMDrMfIA.ttf',
  },
  {
    family: 'Alfa Slab One',
    category: 'display',
    weights: [400],
    urlPattern:
      'https://fonts.gstatic.com/s/alfaslabone/v19/6NUQ8FmMKwSEKjnm5-4v-4Jh6dVretWvYmE.ttf',
  },
  {
    family: 'ZCOOL QingKe HuangYou',
    category: 'display',
    weights: [400],
    urlPattern:
      'https://fonts.gstatic.com/s/zcoolqingkehuangyou/v15/2Eb5L_R5IXJEWhD3AOhSvFC554MOOahI4mRIi_28c8S3gw.ttf',
    cjk: true,
  },
  {
    family: 'ZCOOL KuaiLe',
    category: 'display',
    weights: [400],
    urlPattern:
      'https://fonts.gstatic.com/s/zcoolkuaile/v19/tssqApdaRQokwFjFJjvM6h2Wo_7GwlFIA.ttf',
    cjk: true,
  },
  // =========================================================================
  // Handwriting (synced with backend font_service.py)
  // =========================================================================
  {
    family: 'Caveat',
    category: 'handwriting',
    weights: [400, 500, 600, 700],
    urlPattern:
      'https://fonts.gstatic.com/s/caveat/v18/WnznHAc5bAfYB2QRah7pcpNvOx-pjfJ9SIKjYBxPigs.ttf',
  },
  {
    family: 'Dancing Script',
    category: 'handwriting',
    weights: [400, 500, 600, 700],
    urlPattern:
      'https://fonts.gstatic.com/s/dancingscript/v25/If2cXTr6YS-zF4S-kcSWSVi_sxjsniB7ulqWLQRhcCKh.ttf',
  },
  {
    family: 'Pacifico',
    category: 'handwriting',
    weights: [400],
    urlPattern:
      'https://fonts.gstatic.com/s/pacifico/v22/FwZY7-Qmy14u9lezJ-6H6MmBp0u-.ttf',
  },
  {
    family: 'Satisfy',
    category: 'handwriting',
    weights: [400],
    urlPattern:
      'https://fonts.gstatic.com/s/satisfy/v21/rP2Hp2yn6lkG50LoOZSCHBeHFl0.ttf',
  },
  {
    family: 'Shadows Into Light',
    category: 'handwriting',
    weights: [400],
    urlPattern:
      'https://fonts.gstatic.com/s/shadowsintolight/v19/UqyNK9UOIntux_czAvDQx_ZcHqZXBNQDcsr4xzSM.ttf',
  },
  {
    family: 'Indie Flower',
    category: 'handwriting',
    weights: [400],
    urlPattern:
      'https://fonts.gstatic.com/s/indieflower/v21/m8JVjfNVeKWVnh7QMuKkFcZlbkGG1dKEDw.ttf',
  },
  {
    family: 'Great Vibes',
    category: 'handwriting',
    weights: [400],
    urlPattern:
      'https://fonts.gstatic.com/s/greatvibes/v19/RWmMoKWR9v4ksMfaWd_JN-XCg6UKDXlq.ttf',
  },
  {
    family: 'Sacramento',
    category: 'handwriting',
    weights: [400],
    urlPattern:
      'https://fonts.gstatic.com/s/sacramento/v15/buEzpo6gcdjy0EiZMBUG0CoV_NxIRg.ttf',
  },
  {
    family: 'Ma Shan Zheng',
    category: 'handwriting',
    weights: [400],
    urlPattern:
      'https://fonts.gstatic.com/s/mashanzheng/v10/NaPecZTRCLxvwo41b4gvzkXaRMTpFCZsDQ.ttf',
    cjk: true,
  },
  {
    family: 'Long Cang',
    category: 'handwriting',
    weights: [400],
    urlPattern:
      'https://fonts.gstatic.com/s/longcang/v17/LYjAdGP8kkQIdiwsCbRCr0IsPHm5.ttf',
    cjk: true,
  },
  {
    family: 'Zhi Mang Xing',
    category: 'handwriting',
    weights: [400],
    urlPattern:
      'https://fonts.gstatic.com/s/zhimangxing/v17/f0Xw0ey79sErYFtWQ9a2rq-g0actfektbEkN.ttf',
    cjk: true,
  },
];

// ---------------------------------------------------------------------------
// Runtime registry — mutable Map keyed by lowercase family name
// ---------------------------------------------------------------------------

/** Internal registry, keyed by family name (lowercase). */
let registry = new Map<string, FontRegistryEntry>();

/** Snapshot of the built-in registry for resetRegistry(). */
const builtinSnapshot = new Map<string, FontRegistryEntry>();

// Populate on module load
for (const entry of BUILTIN_ENTRIES) {
  const key = entry.family.toLowerCase();
  registry.set(key, entry);
  builtinSnapshot.set(key, entry);
}

// ---------------------------------------------------------------------------
// Well-known CDN URLs (used by preloader as defaults)
// ---------------------------------------------------------------------------

export const NOTO_SANS_SC_URL =
  'https://fonts.gstatic.com/s/notosanssc/v37/k3kCo84MPvpLmixcA63oeAL7Iqp5IZJF9bmaG9_FnYxNbPzS5HE.ttf';

export const INTER_URL =
  'https://fonts.gstatic.com/s/inter/v18/UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIw2boKoduKmMEVuLyfAZ9hiA.woff2';

// ---------------------------------------------------------------------------
// Dynamic Registration API
// ---------------------------------------------------------------------------

/**
 * Register a custom font into the registry at runtime.
 * Skips silently when a font with the same family already exists,
 * unless `overwrite` is set to `true`.
 */
export function registerFont(entry: FontRegistryEntry, overwrite = false): void {
  const key = entry.family.toLowerCase();
  if (!overwrite && registry.has(key)) return;
  registry.set(key, entry);
}

/**
 * Batch-register multiple fonts.
 */
export function registerFonts(entries: FontRegistryEntry[], overwrite = false): void {
  for (const entry of entries) {
    registerFont(entry, overwrite);
  }
}

/**
 * Remove a font family from the registry. Built-in fonts can also be removed.
 * Returns `true` if the font was found and removed, `false` otherwise.
 */
export function unregisterFont(family: string): boolean {
  return registry.delete(family.toLowerCase());
}

/**
 * Reset the registry to its initial state (built-in fonts only).
 * Primarily intended for testing.
 */
export function resetRegistry(): void {
  registry = new Map(builtinSnapshot);
}

// ---------------------------------------------------------------------------
// Public Query API (backward-compatible)
// ---------------------------------------------------------------------------

export function getAvailableFonts(): FontRegistryEntry[] {
  return Array.from(registry.values());
}

export function findFont(family: string): FontRegistryEntry | undefined {
  return registry.get(family.toLowerCase());
}

export function getFontUrl(family: string, _weight = 400): string | undefined {
  return findFont(family)?.urlPattern;
}

export function getClosestWeight(family: string, targetWeight: number): number | undefined {
  const entry = findFont(family);
  if (!entry) return undefined;
  return entry.weights.reduce((prev, curr) =>
    Math.abs(curr - targetWeight) < Math.abs(prev - targetWeight) ? curr : prev,
  );
}

/**
 * Resolve a fontFamily name to a download URL + metadata.
 * Returns undefined if the family is not in the registry.
 */
export function resolveFontFamily(family: string): ResolvedFont | undefined {
  const entry = findFont(family);
  if (!entry) return undefined;
  return {
    url: entry.urlPattern,
    resolvedFamily: entry.family,
    weights: entry.weights,
    cjk: entry.cjk ?? false,
  };
}

export function getCjkFonts(): FontRegistryEntry[] {
  return Array.from(registry.values()).filter((e) => e.cjk);
}

export function getFontsByCategory(
  category: FontRegistryEntry['category'],
): FontRegistryEntry[] {
  return Array.from(registry.values()).filter((e) => e.category === category);
}
