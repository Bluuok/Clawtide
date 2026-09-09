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

## Follow-up refinements

- September 9 final integration follows OpenDesign Local Codex project
  `clawtide-coastal-integration-67d9`, run `ef3c9c48-f5a1-4952-87ac-07cdca9ae193`.
  The reference was read and adapted to the real React app, not substituted for it.
- Login/setup retain the user's preferred original ceramic wave over the full art
  panel with an ivory gradient protecting the heading; the partial-height crop is gone.
  The coastal double exposure stays in workspace artwork. The typing caret blinks
  once per second and respects reduced motion. Non-chat pages use one outer scroller;
  bottom controls are checked at 390/1280 px widths and 650 px viewport height.
- Chat empty artwork is 420 x 250 desktop / 300 x 180 mobile with feathered edges;
  profiles use a larger linen introduction; workspaces use two columns and 3:2 covers.
  The new coast replaces the proposed ink painting. Blue mobile art is not used.
- Finite 600 ms entrance animation and 2 px card hover lift respect reduced motion.
  No authentication, backend or persisted workspace fields were changed for the design.
- Integrated user-supplied tidal stones and optical glass artwork as optimized WebP
  assets (about 150 KB combined). Chat uses art only in empty states; workspace
  cards and the profile introduction use separate decorative image regions.
  Settings and populated task/message lists stay free of background artwork.
- Completed profiles section editing, dirty-state protection, save/discard and version restoration.
- Completed workspace search, creation/rename feedback, pending controls and Home protection.
- Completed admin-only provider settings, URL validation and accurate saved-key status.
- Final verification: frontend typecheck and production build; all seven routes at desktop
  and mobile sizes; browser fixture checks for chat, profiles, tasks, workspaces and settings.
- Local backend health and frontend HTTP responses checked separately. Browser fixtures
  do not verify live model execution or credentials.
- Chat: searchable conversations, per-session in-memory drafts, mobile conversation
  browser, clipboard actions, prompt suggestions and retryable transcript loading.
- Tasks: searchable/status-filtered lists, an accessible creation dialog, explicit
  UTC/local schedule labels, date/interval validation, pending-action controls and
  retryable run history. Creating a task selects it immediately.
- Browser fixture checks cover search, draft isolation, clipboard, retries,
  mobile composer placement, deletion cancellation and task creation payloads.
- No additional generated imagery is required for these functional workspaces.

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
