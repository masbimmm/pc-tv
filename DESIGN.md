# PC-TV design direction

Owner instruction: dark minimal editor, single accent.

## Identity

A local TV workbench. It sits on a second monitor next to a terminal, and it
should feel like a tool an engineer left open, not a streaming product trying to
sell a subscription. Dense, quiet, factual. No marketing surface exists in this
app: every pixel is either a control or a channel.

## Palette

| Role | Value | Reason |
| --- | --- | --- |
| Base | `#0a0a0b` | Near black, the video frame is the brightest thing on screen |
| Surface | `#121215` | Panels lift off the base by one step, no shadow needed |
| Surface raised | `#191a1f` | Inputs, hover rows |
| Line | `#26272e` | 1px separators carry the entire structure |
| Text | `#e8e8ea` | 15.1:1 on base |
| Text muted | `#9a9ba4` | 6.6:1 on base, still AA for body |
| Accent | `#e0a13c` | Amber. Single accent. Marks the playing channel and the primary action only |
| Danger | `#d9584f` | Errors and destructive actions only |

One accent, used in at most three places at once: the now-playing marker, the
primary button, and the focus ring. Everything else is neutral.

## Type

System sans for channel names and body text. Monospace (`ui-monospace`) for
group labels, counts, timecodes and status, because those are read as data, not
prose. Two families, both already on the machine, no webfont request.

## Structure

- Top bar: brand, search, refresh, add source
- Left rail: groups with counts, then the sources list with per-source state
- Main: player, then the channel list
- No hero, no cards with icons, no footer. The channel list is the product.

## Motion

One transition: a 120ms colour change on hover and focus. Nothing else moves.
The live dot pulses only while a channel is actually playing, and it stops under
`prefers-reduced-motion`.

## Constraints held

- Dark is the whole app. There is no light mode to break (R-34 does not apply).
- Every control has a real behaviour or it is not rendered (R-26).
- Empty, loading and error states are designed, not afterthoughts (R-27).
- Keyboard: Tab order follows the visual order, Escape closes the dialog (R-32).
