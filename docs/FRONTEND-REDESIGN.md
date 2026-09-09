# Clawtide frontend redesign

## Confirmed direction

Warm ivory, forest-green navigation, muted teal accents, generous spacing and
abstract tidal artwork. Preserve the current English UI and existing API contracts.
OpenDesign Local Codex is the selected design workflow; do not use Cloud credits.
The user supplies generated raster artwork. SVG/CSS decoration is the fallback.

## Implementation order

1. Generate the OpenDesign product shell and chat reference; inspect its tokens.
2. Implement shared visual primitives, navigation and responsive page containers.
3. Rebuild chat layout with transcript above composer, readable session metadata,
   clear empty/error states and keyboard-safe input.
4. Apply the same system to profiles, tasks, workspaces and provider settings.
5. Style login/setup with a replaceable tidal art panel.
6. Verify the frontend build, desktop/mobile layout and important interactions.

## Artwork brief

## First implementation delivered

- OpenDesign Local Codex reference: `clawtide-tide-studio-d8d2`, run
  `e2904a12-a253-4a83-a948-fe676d6f77ce` (succeeded).
- Adapted its editorial typography, ivory/forest palette, fine navigation icons,
  tidal linework and light content surfaces to all seven existing page routes.
- Fixed chat composer placement and mobile scroll containment; added IME-safe
  sending, retained HTTP fallback, and added visible request-error feedback.
- Added native accessible in-app deletion dialogs and task run feedback.
- Fixed Vite document-route handling so refreshing console URLs serves HTML
  while fetch requests still reach the existing API proxy.
- Validation: frontend typecheck, production Vite build, seven desktop route
  screenshots, five mobile route screenshots, mobile overflow/composer assertions,
  IME/send interaction, deletion cancellation and task-run feedback passed.
- Browser checks use intercepted fixtures, not live account/model execution.
- User-supplied tidal sculpture artwork is integrated into login/setup at
  `web/public/images/tidal-sculpture.png`. Desktop copy uses the upper negative
  space; mobile uses a right-aligned art crop with a soft CSS mask. The original
  downloaded file is unchanged.

### Image specification

One original login-panel image, portrait 3:4, ideally 2400 × 3200 pixels.
No lettering, logos, frame or room mockup. Keep pale negative space in the upper
third and a sculptural wave in the lower two-thirds. Palette: warm ivory,
deep forest green and muted teal. UI text remains HTML, never baked into images.

Suggested prompt:

> A refined abstract tidal sculpture for an editorial AI workspace, one graceful
> curling ocean wave, deep forest green and muted teal with ivory foam, warm
> off-white background, tactile matte ceramic and subtle painterly texture,
> soft gallery daylight, quiet architectural composition, generous empty space
> in the upper third, exquisite material detail, restrained sophisticated color,
> portrait 3:4, high resolution, artwork only, no text, no typography, no logo,
> no watermark, no frame, no interior mockup, no neon, no glossy plastic.

Use an optimized WebP derivative for the website; retain the original separately.
