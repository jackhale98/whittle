# Wren brand assets: perched bird

## Files
| File | Use |
|---|---|
| `svg/wren-loader-dark.svg` | Animated loader for dark surfaces (seamless 4.4 s loop) |
| `svg/wren-loader-light.svg` | Animated loader for light surfaces |
| `svg/wren-mark-dark.svg` / `wren-mark-light.svg` | Static logo mark |
| `svg/favicon.svg` | Simplified 16–32 px mark; adapts to the browser's light/dark theme |
| `svg/app-icon.svg`, `svg/app-icon-maskable.svg` | Sources for the PNG icons |
| `png/icon-192.png`, `png/icon-512.png` | PWA manifest icons |
| `png/icon-maskable-512.png` | PWA maskable icon (extra safe-zone padding) |
| `png/apple-touch-icon.png` | iOS home-screen icon (180 px) |
| `png/favicon-32.png` | PNG favicon fallback |

## Loader behaviour
- One loop: block → rough → shaped → finished (chips fly at each cut) → the finished bird slides out left while a new block slides in. The last frame equals the first, so it runs indefinitely with no visible restart.
- Pure SVG + CSS. No JavaScript, no external assets, and it's safe under COOP/COEP.
- Honours `prefers-reduced-motion`: it shows the static finished bird.
- **Inline the SVG** in the page (not `<img src>`) if you want the accent colour to follow the app theme. The accent is `var(--wren-accent, #2F5BEA)`. As an `<img>`, it animates but always uses the default blue.

```html
<!-- Kernel-loading splash -->
<div class="boot" role="status" aria-live="polite">
  <!-- paste svg/wren-loader-dark.svg here, sized with CSS -->
  <span class="sr-only">Loading Wren…</span>
</div>
<style>.boot svg{width:96px;height:96px} :root{--wren-accent:#2F5BEA}</style>
```

## Web manifest / head
```json
"icons": [
  { "src": "/png/icon-192.png", "sizes": "192x192", "type": "image/png" },
  { "src": "/png/icon-512.png", "sizes": "512x512", "type": "image/png" },
  { "src": "/png/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
],
"theme_color": "#101217",
"background_color": "#101217"
```
```html
<link rel="icon" href="/svg/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/png/favicon-32.png" sizes="32x32">
<link rel="apple-touch-icon" href="/png/apple-touch-icon.png">
```

## Colours
| Token | Hex |
|---|---|
| Accent (wing) | `#2F5BEA` (alternates explored: `#E06A2C`, `#12977A`, `#6D4FE0`) |
| Ink / dark surface | `#101217`, `#16181D` |
| Greys (dark → light) | `#3A404C`, `#545C6C`, `#6A7383`, `#8C93A1`, `#A9B0BC`, `#C3C8D1`, `#ECEDEF` |
| Paper | `#F5F4F0` |

Wordmark: **Inter Tight SemiBold**, lowercase "wren", letter-spacing −0.025em. Use a self-hosted font file because of cross-origin isolation.

Source of truth for regenerating: `build.py` (SVGs) and `render.cjs` (PNGs, via Playwright).
