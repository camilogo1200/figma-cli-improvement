# Operations and spec fields

Every command is a JSON object with an `op`. Send one with `figma-ultimate send file.json`, or an
array of up to 128 as one batch. Field names are case-sensitive; most enum values (`ROW`, `FILL`,
`DROP_SHADOW`, …) are not.

## Contents

- [Operations](#operations)
- [create](#create)
- [Node spec](#node-spec): common fields, auto layout, children in auto layout, paint, text, types
- [update](#update)
- [Examples](#examples)

## Operations

| Op | Command | Returns |
|---|---|---|
| `ping`, `info` | `{"op":"info"}` | file, current page, child count, selection, queue |
| `page` | `{"op":"page","action":"list"}` | `[{id,name,current}]` |
| | `{"op":"page","action":"create","name":"…","select":false}` | the new page. Without `select:false` it becomes the visible page |
| | `{"op":"page","action":"rename","id":"…","name":"…"}` | |
| | `{"op":"page","action":"update","id":"…","index":2,"bg":"#F5F5F5"}` | move the page and/or set its background (`#RRGGBB`) |
| | `{"op":"page","action":"select","id":"…"}` | changes the page the user sees. Only when asked: creating never needs it |
| `find` | `{"op":"find","name":"Button","limit":100}` | nodes on the **visible page** whose name contains the text |
| `children` | `{"op":"children","id":"<page or node id>","prefix":"UI / "}` | direct children `[{id,name,type,x,y,w,h}]`. Without `id`: the visible page. Works for pages that are not visible |
| `tree` | `{"op":"tree","id":"…","depth":3}` | nested summary |
| `create` | see below | `{created:[{id,name,type,x,y,w,h}], fontFallbacks?, reservation?}` |
| `update` | `{"op":"update","id":"…","spec":{…}}` | the node summary |
| `reactions` | `{"op":"reactions","id":"<button>","reactions":[{"to":"<frame id>"}]}` | replaces the node's prototype reactions |
| `flowStart` | `{"op":"flowStart","id":"<frame>","pageId":"…","name":"Checkout"}` | adds a prototype starting point (`reset:true` replaces all) |
| `image` | `{"op":"image","base64":"<PNG or JPEG>"}` | `{hash,width,height}` for image fills. Same bytes, same hash |
| `fonts` | `{"op":"fonts","query":"Roboto"}` | installed families and their styles |
| `audit` | `{"op":"audit","id":"<frame>"}` | text colours against their real background, small tap targets, overflow |
| `exportImage` | use `figma-ultimate export <id> out.png` instead | |
| `select` | `{"op":"select","ids":["…"]}` | selects and zooms. Only when the user asks to be shown something |
| `remove` | `{"op":"remove","ids":["…"]}` | **Only** for nodes the user explicitly asked to delete, by id |
| `cancel` | `figma-ultimate cancel [requestId]` | |

Reactions: each entry is `{trigger, to | back, navigation, transition}`. `trigger` defaults to
`{"type":"ON_CLICK"}`; `{"type":"ON_KEY_DOWN","keyCodes":[13]}` also works. `back:true` goes back.
`navigation` defaults to `NAVIGATE` (`OVERLAY`, `SWAP`, `SCROLL_TO`, `CHANGE_TO` are Figma's other
values). `transition` is a Figma Plugin API transition object or omitted for instant.

## create

```json
{ "op": "create", "parent": "<page id or frame id>", "select": false, "zoom": false,
  "specs": [ { …node spec… }, { … } ] }
```

- `spec` (one root) or `specs` (several roots, built in order). At most 10,000 nodes per request,
  64 levels deep.
- `parent`: a page id or any frame, component or section id. Omitted or `"page"` means the page the
  user is looking at. Give it explicitly.
- `select: false`, `zoom: false`: keep the user's selection and viewport. Defaults are `true`.
- Roots placed on a page without `x`/`y` go to the right of existing artwork.
- **Automatic placement** (what `figma-ultimate layout` does) applies when `"placement":"auto"` is
  set, or when every root has `w` and `h`, no `x`/`y`, and the parent is the visible page. The bridge
  then picks free space and reserves it. Under automatic placement, `SECTION` and `INSTANCE` nodes are
  refused (`unsupported-scope`, `not-started`). Put them inside an explicitly placed parent, or send
  `"placement":"manual"` with `x`/`y`.

## Node spec

### Common fields

| Field | Values |
|---|---|
| `type` | `FRAME` (default), `TEXT`, `RECTANGLE` (`RECT`), `ELLIPSE` (`CIRCLE`), `LINE`, `COMPONENT`, `SECTION`, `SVG`, `INSTANCE`. A spec with `text` is a `TEXT` |
| `name` | layer name. Use clear, unique names |
| `children` | array of node specs (not for `INSTANCE`) |
| `w`, `h` | size in px. A frame with neither and no auto layout stays 100 × 100 |
| `x`, `y` | position inside a parent without auto layout, or on the page |
| `fill` | paint (see below). Frames without `fill` are transparent |
| `stroke`, `strokeWidth`, `strokeAlign` | paint, px, `INSIDE` / `OUTSIDE` / `CENTER` |
| `dash` | dash pattern, for example `[6, 4]` |
| `strokeCap` | lines and arrows: `NONE`, `ROUND`, `SQUARE`, `ARROW_LINES`, `ARROW_EQUILATERAL` |
| `radius` | number, or `[topLeft, topRight, bottomRight, bottomLeft]` |
| `effects` | `[{ "type": "DROP_SHADOW", "color": "#000000", "opacity": 0.15, "x": 0, "y": 2, "blur": 8, "spread": 0 }]`. Also `INNER_SHADOW`, and `LAYER_BLUR` / `BACKGROUND_BLUR` with `blur` |
| `opacity` | 0 to 1 |
| `blend` | blend mode, for example `MULTIPLY` |
| `visible` | `false` hides it |
| `rotation` | degrees |
| `clip` | `true` clips content (frames) |

### Auto layout (frames and components)

| Field | Values |
|---|---|
| `layout` | `ROW` (`HORIZONTAL`), `COL` (`COLUMN`, `VERTICAL`), `NONE`. Padding or `gap` without `layout` means `ROW` |
| `gap` | space between children |
| `p`, `px`, `py`, `pt`, `pr`, `pb`, `pl` | padding: all, horizontal, vertical, each side |
| `justify` | main axis: `start`, `center`, `end`, `between` |
| `items` | cross axis: `start`, `center`, `end`, `baseline` |
| `wrap`, `rowGap` | wrap rows (`ROW` only) and the gap between them |

An auto-layout frame **hugs** its content on each axis without `w`/`h`, and keeps the size given
on an axis with `w` or `h`.

### Children inside an auto-layout parent

| Field | Values |
|---|---|
| `wSize`, `hSize` | `FILL` (stretch to the parent), `HUG`, `FIXED`. `FILL` needs a parent with a size on that axis |
| `grow` | `1` takes the remaining space on the main axis |
| `alignSelf` | `STRETCH` or `INHERIT` |

### Paint (`fill`, `stroke`, text `color`)

- `"#RRGGBB"`, `"#RRGGBBAA"`, `"#RGB"`, or `{ "r": 0.1, "g": 0.2, "b": 0.3, "a": 1 }` (0 to 1).
- `{ "type": "SOLID", "color": "#0E5A6D", "opacity": 0.5 }`.
- Gradient: `{ "type": "GRADIENT_LINEAR", "angle": 90, "stops": ["#FF0080", "#7928CA"] }`. Stops can
  be `{ "color": "#…", "pos": 0.4 }`. `angle`: 0 left to right, 90 (default) top to bottom. Also
  `GRADIENT_RADIAL`, `GRADIENT_ANGULAR`, `GRADIENT_DIAMOND`.
- Image: `{ "type": "IMAGE", "hash": "<from op image>", "scaleMode": "FILL" }` (`FIT`, `CROP`, `TILE`).
- An array of paints stacks them; `"none"` clears.

### Text

| Field | Values |
|---|---|
| `text` | the characters |
| `font` | family, default `Inter`. Missing fonts fall back to Inter Regular and are listed in `fontFallbacks` |
| `weight` | `thin`, `extralight`, `light`, `regular`, `medium`, `semibold`, `bold`, `extrabold`, `black` |
| `style` | exact style name, overrides `weight` (for example `"Condensed Bold"`) |
| `italic` | `true` |
| `size` | px |
| `color` | paint, default `#000000` |
| `lineHeight`, `letterSpacing` | px number, or `{ "value": 150, "unit": "PERCENT" }` |
| `align`, `valign` | `left` / `center` / `right`, `top` / `center` / `bottom` |
| `textCase`, `textDecoration` | `UPPER`, `LOWER`, `TITLE`; `UNDERLINE`, `STRIKETHROUGH` |

Text with `w` or `wSize: "FILL"` wraps at that width; otherwise it grows to fit on one line.

### Types with extra fields

- `ELLIPSE`: `arc` (sweep in degrees), `arcStart` (default -90, the top), `innerRadius` (0 to 1) for
  rings, progress arcs and donuts.
- `LINE`: `w` is its length; give it a `stroke` and `strokeWidth`.
- `SVG`: `{ "type": "SVG", "svg": "<svg …>…</svg>", "w": 24 }` imports markup (colours baked in) and
  scales it to `w`.
- `INSTANCE`: `{ "type": "INSTANCE", "of": "<component id>", "name", "opacity", "visible" }`. The id
  must be a `COMPONENT`: a variant's id works, a component set's id does not. No `children`.
- `COMPONENT`: like a frame; the result is a reusable component.
- `SECTION`: a canvas section with `w`, `h` and children (explicit placement only).

## update

```json
{ "op": "update", "id": "12:34", "spec": { "fill": "#FFFFFF" } }
```

Changes `name`, `fill`, `stroke`, `strokeWidth`, `radius`, `effects`, `opacity`, `visible`, `x`, `y`,
`w`, `h`, and on text nodes the text fields above (with or without `text`). Only the fields you send
change. Anything else (layout, padding, children) is not changed by `update`.

- An auto-layout axis without `w`/`h` keeps its sizing: a fixed 390×844 screen stays fixed after a
  fill-only update. Sending `w` or `h` fixes that axis at the new size.
- Text keeps its font, colour, size and wrapping unless you send them. A partial font keeps the rest
  of the current one: `{ "weight": "bold" }` on Poppins Semi Bold gives Poppins Bold. Sending `w`
  makes the text wrap at that width. If the node's font is not installed, it becomes Inter Regular
  and the result lists it in `fontFallbacks`.
- Confirm the id with `tree` first: an update of a missing node fails and holds the file
  ([recovery.md](recovery.md)).
- Updates to existing nodes are not transactions: a failure can leave some fields changed.

## Examples

A screen with a button, built by `figma-ultimate layout layout.json`:

```json
{ "label": "Checkout",
  "specs": [ {
    "name": "Checkout / Done", "w": 390, "h": 844, "fill": "#FFFFFF",
    "layout": "COL", "justify": "center", "items": "center", "clip": true,
    "children": [ {
      "name": "Button / Primary", "layout": "ROW", "justify": "center", "items": "center",
      "px": 28, "py": 14, "radius": 12, "fill": "#0E5A6D",
      "effects": [ { "type": "DROP_SHADOW", "color": "#0E5A6D", "opacity": 0.24, "y": 2, "blur": 8 } ],
      "children": [ { "type": "TEXT", "name": "Label", "text": "Done", "size": 16, "weight": "semibold", "color": "#FFFFFF" } ]
    } ]
  } ] }
```

Add a card to an existing frame, then link its button (two requests, because the second needs ids
from the first):

```json
{ "op": "create", "parent": "12:34", "select": false, "zoom": false,
  "spec": { "name": "Card", "layout": "COL", "gap": 8, "p": 16, "radius": 12, "fill": "#F4F4F5", "wSize": "FILL",
    "children": [
      { "type": "TEXT", "name": "Title", "text": "Order summary", "size": 18, "weight": "semibold", "wSize": "FILL" },
      { "name": "Button / Pay", "layout": "ROW", "px": 16, "py": 10, "radius": 8, "fill": "#111111",
        "children": [ { "type": "TEXT", "text": "Pay", "color": "#FFFFFF" } ] } ] } }
```

```json
{ "op": "reactions", "id": "<Button / Pay id from tree>", "reactions": [ { "to": "<target frame id>" } ] }
```
