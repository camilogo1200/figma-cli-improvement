/**
 * figma-cli-ultimate plugin — structured-command edition of the FigCli bridge
 *
 * Figma 126+ blocks eval() inside the plugin sandbox (it throws "Not available"),
 * which killed the original transport: the CLI used to ship JS source strings and
 * eval them here. This build never executes dynamic code. It accepts a structured
 * JSON command and interprets it against the Plugin API natively.
 *
 * The eval handler is retained only so an older CLI gets a clear diagnostic
 * instead of a bare "Not available".
 */

// The window always opens as the stealth banner in the viewport's bottom-left
// corner; presets and edge drags resize it. Storage failure must not stop work.
var UI_MODES = { stealth: [300, 40], compact: [360, 300], standard: [360, 600], console: [1060, 904] };
var UI_MIN = [300, 200], UI_MAX = [2400, 1800];
var uiMode = 'stealth', uiSize = UI_MODES.stealth;
var UI_THEMES = ['ios', 'signal'];
var uiTheme = 'ios';
var uiStorageWrite = Promise.resolve();
var rememberedCredential = '';
async function openConsole() {
  try {
    var savedPairing = await figma.clientStorage.getAsync('ultimate-computer-pairing-v1');
    if (typeof savedPairing === 'string' && /^[a-f0-9]{64}$/.test(savedPairing)) rememberedCredential = savedPairing;
  } catch (e) {}
  try {
    var savedTheme = await figma.clientStorage.getAsync('ui-theme');
    if (savedTheme === 'ios-color' || savedTheme === 'ios-uber') savedTheme = 'ios';
    if (savedTheme === 'graphite') savedTheme = 'signal';
    if (UI_THEMES.indexOf(savedTheme) !== -1) uiTheme = savedTheme;
  } catch (e) {}
  var size = UI_MODES[uiMode], options = { width: size[0], height: size[1], themeColors: true }, corner = bottomLeft(size);
  if (corner) options.position = corner;
  // Paint the banner from the first frame instead of flashing the console layout.
  figma.showUI(String(__html__).replace('<body data-mode="standard"', '<body data-mode="' + uiMode + '"'), options);
}
// Canvas-space position near the viewport's bottom-left corner. Figma keeps a
// window inside the viewport, so an approximate title-bar height is enough.
function bottomLeft(size) {
  try {
    var b = figma.viewport.bounds, z = figma.viewport.zoom;
    if (!b || !(z > 0) || ![b.x, b.y, b.height].every(isFinite)) return null;
    return { x: b.x + 12 / z, y: b.y + b.height - (size[1] + 52) / z };
  } catch (e) { return null; }
}
function lowerHalf() {
  try {
    var p = figma.ui.getPosition().canvasSpace, b = figma.viewport.bounds;
    return p.y > b.y + b.height / 2;
  } catch (e) { return false; }
}
// dx/dy move the window's top-left corner in screen pixels (left/top edge drags,
// or keeping the bottom edge fixed). Older Figma builds without reposition only resize.
function resizeWindow(width, height, dx, dy) {
  figma.ui.resize(width, height); uiSize = [width, height];
  if (!(dx || dy) || typeof figma.ui.reposition !== 'function' || typeof figma.ui.getPosition !== 'function') return;
  try {
    var p = figma.ui.getPosition().canvasSpace, z = figma.viewport.zoom || 1;
    figma.ui.reposition(p.x + dx / z, p.y + dy / z);
  } catch (e) {}
}

var VERSION = '3.0.0-ultimate';
// 3: bounded cancellable FIFO, ownership cleanup and build/session fencing.
var PROTOCOL = 4;
var BUILD = 'db3e2db86449fcc61165d146'; // stamped by bridge/launcher.mjs build
var INSTANCE_ID = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
// One metadata-only receipt, never a retained SceneNode or creation payload.
var historyCandidate = null;

// The bridge never reads hidden children of instances; skipping them makes
// every children/findAll walk cheaper on big pages (bridge review F5).
try { figma.skipInvisibleInstanceChildren = true; } catch (e) {}

// ============ color ============

function hexToRgb(hex) {
  var h = String(hex).trim().replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  var a = 1;
  if (h.length === 8) {
    a = parseInt(h.slice(6, 8), 16) / 255;
    h = h.slice(0, 6);
  }
  var n = parseInt(h, 16);
  if (isNaN(n)) return { r: 0, g: 0, b: 0, a: 1 };
  return {
    r: ((n >> 16) & 255) / 255,
    g: ((n >> 8) & 255) / 255,
    b: (n & 255) / 255,
    a: a
  };
}

function parseColor(c) {
  if (c == null) return null;
  if (typeof c === 'string') return hexToRgb(c);
  // {r,g,b} already normalized 0..1
  return { r: c.r || 0, g: c.g || 0, b: c.b || 0, a: c.a == null ? 1 : c.a };
}

function solidPaint(color, opacity) {
  var c = parseColor(color) || { r: 0, g: 0, b: 0, a: 1 };
  var p = { type: 'SOLID', color: { r: c.r, g: c.g, b: c.b } };
  var o = opacity == null ? c.a : opacity;
  if (o != null) p.opacity = o;
  return p;
}

// Rotation about the fill's center. deg 0 = left→right, 90 = top→bottom.
function gradientTransform(deg) {
  var rad = ((deg == null ? 90 : deg) * Math.PI) / 180;
  var c = Math.cos(rad);
  var s = Math.sin(rad);
  return [
    [c, s, (1 - c - s) / 2],
    [-s, c, (1 + s - c) / 2]
  ];
}

function paintFrom(p) {
  if (p == null) return null;
  if (typeof p === 'string') return solidPaint(p);

  var t = (p.type || 'SOLID').toUpperCase();
  if (t === 'SOLID') return solidPaint(p.color, p.opacity);

  if (t.indexOf('GRADIENT') === 0) {
    var stops = (p.stops || []).map(function (s, i, arr) {
      var col = parseColor(typeof s === 'string' ? s : s.color) || { r: 0, g: 0, b: 0, a: 1 };
      var pos = typeof s === 'string' ? (arr.length === 1 ? 0 : i / (arr.length - 1)) : s.pos;
      return {
        position: pos == null ? i / Math.max(1, arr.length - 1) : pos,
        color: { r: col.r, g: col.g, b: col.b, a: col.a == null ? 1 : col.a }
      };
    });
    var paint = {
      type: t === 'GRADIENT' ? 'GRADIENT_LINEAR' : t,
      gradientStops: stops,
      gradientTransform: gradientTransform(p.angle)
    };
    if (p.opacity != null) paint.opacity = p.opacity;
    return paint;
  }

  if (t === 'IMAGE') {
    if (!p.hash) return null;
    var ip = { type: 'IMAGE', imageHash: p.hash, scaleMode: String(p.scaleMode || 'FILL').toUpperCase() };
    if (p.opacity != null) ip.opacity = p.opacity;
    return ip;
  }

  return solidPaint(p.color || '#000000', p.opacity);
}

// null   => leave untouched
// 'none' => clear
function toPaints(v) {
  if (v == null) return null;
  if (v === 'none' || v === false) return [];
  if (Array.isArray(v)) return v.map(paintFrom).filter(Boolean);
  var one = paintFrom(v);
  return one ? [one] : [];
}

// ============ fonts ============

var WEIGHTS = {
  thin: 'Thin',
  extralight: 'Extra Light',
  ultralight: 'Extra Light',
  light: 'Light',
  regular: 'Regular',
  normal: 'Regular',
  book: 'Regular',
  medium: 'Medium',
  semibold: 'Semi Bold',
  demibold: 'Semi Bold',
  bold: 'Bold',
  extrabold: 'Extra Bold',
  ultrabold: 'Extra Bold',
  black: 'Black',
  heavy: 'Black'
};

function fontOf(spec) {
  var family = spec.font || 'Inter';
  var w = spec.weight == null ? 'regular' : String(spec.weight).toLowerCase().replace(/[\s_-]/g, '');
  var style = WEIGHTS[w] || (spec.weight ? String(spec.weight) : 'Regular');
  if (spec.style) style = String(spec.style);
  if (spec.italic) style = style === 'Regular' ? 'Italic' : style + ' Italic';
  return { family: family, style: style };
}

function isTextSpec(spec) {
  return String(spec.type || '').toUpperCase() === 'TEXT' || spec.text != null;
}

function collectFonts(spec, out) {
  if (!spec || typeof spec !== 'object') return;
  if (isTextSpec(spec)) {
    var f = fontOf(spec);
    out[f.family + '||' + f.style] = f;
  }
  var kids = spec.children || [];
  for (var i = 0; i < kids.length; i++) collectFonts(kids[i], out);
}

// Loads every font the tree needs. Unavailable ones fall back to Inter Regular,
// recorded so the caller learns about the substitution instead of silently
// getting the wrong type.
var FALLBACK = { family: 'Inter', style: 'Regular' };
var fontCache = Object.create(null); // reset per command; never retain an unbounded session cache

// Families disagree on style spelling: Inter ships "Semi Bold", Poppins ships
// "SemiBold". Trying both spellings before giving up prevents a silent
// half-fallback where regular weights load and semibold quietly becomes Inter.
function styleVariants(style) {
  var out = [style];
  var nospace = style.replace(/\s+/g, '');
  if (out.indexOf(nospace) === -1) out.push(nospace);
  var spaced = style.replace(/([a-z])([A-Z])/g, '$1 $2');
  if (out.indexOf(spaced) === -1) out.push(spaced);
  // Apple's SF families spell it "Semibold": joined, lowercase second word.
  var joined = nospace.charAt(0) + nospace.slice(1).toLowerCase();
  if (out.indexOf(joined) === -1) out.push(joined);
  return out;
}

async function loadFonts(spec) {
  var wanted = {};
  collectFonts(spec, wanted);
  var subs = [];
  var keys = Object.keys(wanted);
  var haveFallback = false;

  for (var i = 0; i < keys.length; i++) {
    checkCancelled();
    var f = wanted[keys[i]];
    if (fontCache[keys[i]]) continue;

    var variants = styleVariants(f.style);
    var resolved = null;
    for (var v = 0; v < variants.length; v++) {
      var candidate = { family: f.family, style: variants[v] };
      try {
        await figma.loadFontAsync(candidate);
        resolved = candidate;
        break;
      } catch (e) { /* try the next spelling */ }
      checkCancelled();
    }

    if (resolved) {
      fontCache[keys[i]] = resolved;
    } else {
      if (!haveFallback) {
        try { await figma.loadFontAsync(FALLBACK); haveFallback = true; } catch (e2) {}
      }
      fontCache[keys[i]] = FALLBACK;
      subs.push(f.family + ' ' + f.style);
    }
  }
  checkCancelled();
  return subs;
}

function resolvedFont(spec) {
  var f = fontOf(spec);
  return fontCache[f.family + '||' + f.style] || f;
}

// ============ node construction ============

var ALIGN = {
  start: 'MIN', min: 'MIN', left: 'MIN', top: 'MIN',
  center: 'CENTER', middle: 'CENTER',
  end: 'MAX', max: 'MAX', right: 'MAX', bottom: 'MAX',
  between: 'SPACE_BETWEEN', 'space-between': 'SPACE_BETWEEN', spacebetween: 'SPACE_BETWEEN',
  baseline: 'BASELINE'
};

function align(v, dflt) {
  if (v == null) return dflt;
  return ALIGN[String(v).toLowerCase()] || dflt;
}

function createEmpty(type) {
  switch (type) {
    case 'TEXT': return figma.createText();
    case 'RECT':
    case 'RECTANGLE': return figma.createRectangle();
    case 'ELLIPSE':
    case 'CIRCLE': return figma.createEllipse();
    case 'LINE': return figma.createLine();
    case 'COMPONENT': return figma.createComponent();
    case 'SECTION': return figma.createSection();
    default: return figma.createFrame();
  }
}

function applyPadding(node, spec) {
  if (spec.p != null) {
    node.paddingTop = node.paddingRight = node.paddingBottom = node.paddingLeft = spec.p;
  }
  if (spec.px != null) { node.paddingLeft = spec.px; node.paddingRight = spec.px; }
  if (spec.py != null) { node.paddingTop = spec.py; node.paddingBottom = spec.py; }
  if (spec.pt != null) node.paddingTop = spec.pt;
  if (spec.pr != null) node.paddingRight = spec.pr;
  if (spec.pb != null) node.paddingBottom = spec.pb;
  if (spec.pl != null) node.paddingLeft = spec.pl;
}

function applyRadius(node, spec) {
  if (spec.radius == null) return;
  if (Array.isArray(spec.radius)) {
    var r = spec.radius;
    if ('topLeftRadius' in node) {
      node.topLeftRadius = r[0] || 0;
      node.topRightRadius = r[1] || 0;
      node.bottomRightRadius = r[2] || 0;
      node.bottomLeftRadius = r[3] || 0;
    }
  } else if ('cornerRadius' in node) {
    node.cornerRadius = spec.radius;
  }
}

function applyEffects(node, spec) {
  if (!spec.effects || !('effects' in node)) return;
  node.effects = spec.effects.map(function (e) {
    var t = (e.type || 'DROP_SHADOW').toUpperCase();
    if (t === 'LAYER_BLUR' || t === 'BACKGROUND_BLUR') {
      return { type: t, radius: e.blur == null ? 8 : e.blur, visible: true };
    }
    var c = parseColor(e.color || '#000000') || { r: 0, g: 0, b: 0, a: 1 };
    return {
      type: t,
      color: { r: c.r, g: c.g, b: c.b, a: e.opacity == null ? (c.a == null ? 0.15 : c.a) : e.opacity },
      offset: { x: e.x || 0, y: e.y == null ? 2 : e.y },
      radius: e.blur == null ? 8 : e.blur,
      spread: e.spread || 0,
      visible: true,
      blendMode: 'NORMAL'
    };
  });
}

// create sets every field, with defaults for the ones left out. update passes
// { font } (null = keep the node's font) and changes only the fields the spec
// names, so a text-only update keeps the font, colour and wrapping it had.
async function applyText(node, spec, update) {
  if (!update) node.fontName = resolvedFont(spec);
  else if (update.font) node.fontName = update.font;
  if (spec.size != null) node.fontSize = spec.size;
  if (!update || spec.text != null) node.characters = String(spec.text == null ? '' : spec.text);

  if (spec.lineHeight != null) {
    node.lineHeight = typeof spec.lineHeight === 'number'
      ? { value: spec.lineHeight, unit: 'PIXELS' }
      : spec.lineHeight;
  }
  if (spec.letterSpacing != null) {
    node.letterSpacing = typeof spec.letterSpacing === 'number'
      ? { value: spec.letterSpacing, unit: 'PIXELS' }
      : spec.letterSpacing;
  }
  if (spec.align) {
    var h = align(spec.align, 'MIN');
    node.textAlignHorizontal = h === 'MAX' ? 'RIGHT' : h === 'CENTER' ? 'CENTER' : 'LEFT';
  }
  if (spec.valign) {
    var v = align(spec.valign, 'MIN');
    node.textAlignVertical = v === 'MIN' ? 'TOP' : v === 'MAX' ? 'BOTTOM' : 'CENTER';
  }
  if (spec.textCase) node.textCase = String(spec.textCase).toUpperCase();
  if (spec.textDecoration) node.textDecoration = String(spec.textDecoration).toUpperCase();

  // Fixed width => wrap; otherwise grow to fit the string. A text node that
  // will be stretched to FILL by its parent must also wrap, or Figma rejects
  // the sizing change against WIDTH_AND_HEIGHT.
  var willFill = String(spec.wSize || '').toUpperCase() === 'FILL';
  if (!update || spec.w != null || spec.wSize) node.textAutoResize = (spec.w != null || willFill) ? 'HEIGHT' : 'WIDTH_AND_HEIGHT';

  if (!update || spec.color != null) node.fills = toPaints(spec.color == null ? '#000000' : spec.color);
}

var TEXT_FIELDS = ['text', 'font', 'weight', 'style', 'italic', 'size', 'color', 'lineHeight', 'letterSpacing',
  'align', 'valign', 'textCase', 'textDecoration', 'w', 'wSize'];

// The fonts a TEXT node already uses (several when its ranges differ).
function nodeFonts(node) {
  if (node.fontName && typeof node.fontName === 'object') return [node.fontName];
  if (typeof node.getRangeAllFontNames === 'function' && node.characters) return node.getRangeAllFontNames(0, node.characters.length);
  return [];
}

// The font an update asks for, or null to keep the node's. Parts the spec leaves
// out come from the current font: { weight: 'bold' } on Poppins stays Poppins,
// { italic: true } on Bold becomes Bold Italic.
function updateFont(node, spec) {
  if (spec.font == null && spec.weight == null && spec.style == null && spec.italic == null) return null;
  var cur = nodeFonts(node)[0] || FALLBACK;
  var want = { type: 'TEXT', font: spec.font != null ? spec.font : cur.family };
  if (spec.weight != null || spec.style != null) {
    want.weight = spec.weight; want.style = spec.style; want.italic = spec.italic;
  } else {
    var base = cur.style.replace(/\s*Italic$/i, '') || 'Regular';
    var italic = spec.italic != null ? !!spec.italic : /Italic$/i.test(cur.style);
    want.style = !italic ? base : base === 'Regular' ? 'Italic' : base + ' Italic';
  }
  return want;
}

// Loads what a text update needs before anything changes: the node's own fonts
// (Figma refuses to edit characters or layout without them) and any new font.
// A font this machine lacks falls back to Inter Regular, reported like create.
async function loadTextUpdate(node, spec) {
  var have = nodeFonts(node), missing = [];
  for (var i = 0; i < have.length; i++) {
    try { await figma.loadFontAsync(have[i]); } catch (e) { missing.push(have[i].family + ' ' + have[i].style); }
    checkCancelled();
  }
  var want = updateFont(node, spec);
  if (want) { var subs = await loadFonts(want); return { font: resolvedFont(want), subs: subs }; }
  if (!missing.length) return { font: null, subs: [] };
  await figma.loadFontAsync(FALLBACK);
  checkCancelled();
  return { font: FALLBACK, subs: missing };
}

function applySizing(node, spec) {
  if (node.type === 'SECTION') {
    if (spec.w != null || spec.h != null) node.resizeWithoutConstraints(spec.w == null ? node.width : spec.w, spec.h == null ? node.height : spec.h);
    return;
  }
  if ('layoutMode' in node && node.layoutMode !== 'NONE') {
    var horizAuto = spec.w == null;
    var vertAuto = spec.h == null;
    if (node.layoutMode === 'HORIZONTAL') {
      node.primaryAxisSizingMode = horizAuto ? 'AUTO' : 'FIXED';
      node.counterAxisSizingMode = vertAuto ? 'AUTO' : 'FIXED';
    } else {
      node.primaryAxisSizingMode = vertAuto ? 'AUTO' : 'FIXED';
      node.counterAxisSizingMode = horizAuto ? 'AUTO' : 'FIXED';
    }
  }

  if (node.type === 'TEXT') {
    if (spec.w != null) {
      try { node.resize(Math.max(0.01, spec.w), node.height); } catch (e) {}
    }
    return;
  }

  if ((spec.w != null || spec.h != null) && typeof node.resize === 'function') {
    var w = spec.w != null ? spec.w : node.width;
    var h = spec.h != null ? spec.h : node.height;
    try { node.resize(Math.max(0.01, w), Math.max(0.01, h)); } catch (e) {}
  }
}

// update: only the axes the spec names (w, h) change. applySizing would make
// every other axis of an auto-layout frame hug its content.
function applyNamedSizing(node, spec) {
  if (spec.w == null && spec.h == null) return;
  if (!('layoutMode' in node) || node.layoutMode === 'NONE' || node.type === 'SECTION' || node.type === 'TEXT') {
    applySizing(node, spec);
    return;
  }
  var row = node.layoutMode === 'HORIZONTAL';
  var primary = (row ? spec.w : spec.h) != null ? 'FIXED' : node.primaryAxisSizingMode;
  var counter = (row ? spec.h : spec.w) != null ? 'FIXED' : node.counterAxisSizingMode;
  node.primaryAxisSizingMode = primary;
  node.counterAxisSizingMode = counter;
  try {
    node.resize(Math.max(0.01, spec.w != null ? spec.w : node.width), Math.max(0.01, spec.h != null ? spec.h : node.height));
  } catch (e) {}
  // resize() takes both axes; leave the one the spec did not name as it was.
  node.primaryAxisSizingMode = primary;
  node.counterAxisSizingMode = counter;
}

// Only valid once the node is parented into an auto-layout frame.
function applyChildLayout(node, spec) {
  try {
    if (spec.grow != null) node.layoutGrow = spec.grow;
    if (spec.wSize) node.layoutSizingHorizontal = String(spec.wSize).toUpperCase();
    if (spec.hSize) node.layoutSizingVertical = String(spec.hSize).toUpperCase();
    if (spec.alignSelf) node.layoutAlign = String(spec.alignSelf).toUpperCase();
    // Only meaningful when the parent has no auto-layout; harmless otherwise.
    if (spec.x != null) node.x = spec.x;
    if (spec.y != null) node.y = spec.y;
  } catch (e) {
    // A FILL/HUG the parent can't honor is not worth failing the whole build over.
  }
}

async function createNode(spec) {
  checkCancelled();
  var kind = String(spec.type || 'FRAME').toUpperCase();
  if (current && current.lease && (kind === 'INSTANCE' || kind === 'SECTION')) {
    throw failure('unsupported-scope', 'Sections and component instances require an explicit parent outside automatic placement', 'not-started');
  }
  if (kind === 'INSTANCE') {
    var source = await checked(figma.getNodeByIdAsync(spec.of));
    if (!source || source.type !== 'COMPONENT') throw failure('invalid-request', 'INSTANCE requires an existing component ID', 'not-started');
    // Account for native descendants before allocating the instance.
    var pending = [{ node: source, depth: 1 }], count = 0;
    while (pending.length) {
      var entry = pending.pop();
      if (++count + current.total + (current.copiedNodes || 0) > LIMITS.specNodes || entry.depth > LIMITS.specDepth) throw failure('limit-exceeded', 'Instance node/depth budget exceeded', 'not-started');
      var children = entry.node.children || [];
      for (var ci = 0; ci < children.length; ci++) pending.push({ node: children[ci], depth: entry.depth + 1 });
    }
    current.copiedNodes = (current.copiedNodes || 0) + count;
    var copy = source.createInstance();
    ownNode(copy);
    if (spec.name) copy.name = spec.name;
    if (spec.opacity != null) copy.opacity = spec.opacity;
    if (spec.visible != null) copy.visible = !!spec.visible;
    return copy;
  }
  // SVG markup (figma-cli-ultimate addition): { type: 'SVG', svg: '<svg …>', w, h } becomes a
  // frame of vectors via figma.createNodeFromSvg, rescaled to w. Colour and
  // stroke width are expected to be baked into the markup by the caller.
  if (String(spec.type || '').toUpperCase() === 'SVG') {
    var svgNode = figma.createNodeFromSvg(String(spec.svg || '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"/>'));
    ownNode(svgNode);
    svgNode.name = spec.name || 'svg';
    if (spec.w != null && svgNode.width > 0) svgNode.rescale(spec.w / svgNode.width);
    svgNode.clipsContent = false;
    if (spec.opacity != null) svgNode.opacity = spec.opacity;
    if (current && current.lease) { current.visibility[svgNode.id] = spec.visible !== false; svgNode.visible = false; }
    return svgNode;
  }
  var node = createEmpty(String(spec.type || 'FRAME').toUpperCase());
  ownNode(node);

  if (spec.name) node.name = spec.name;

  if (node.type === 'TEXT') {
    await applyText(node, spec);
  } else {
    if ('layoutMode' in node) {
      // Padding and gap only do anything under auto-layout. A frame given
      // padding but no layout would silently stay 100×100 and clip its
      // content, so infer a row rather than honour a meaningless combination.
      var hasBoxProps = spec.p != null || spec.px != null || spec.py != null ||
        spec.pt != null || spec.pr != null || spec.pb != null || spec.pl != null || spec.gap != null;
      var mode = String(spec.layout || (hasBoxProps ? 'ROW' : 'NONE')).toUpperCase();
      if (mode === 'ROW' || mode === 'HORIZONTAL') node.layoutMode = 'HORIZONTAL';
      else if (mode === 'COL' || mode === 'COLUMN' || mode === 'VERTICAL') node.layoutMode = 'VERTICAL';
      else node.layoutMode = 'NONE';

      if (node.layoutMode !== 'NONE') {
        if (spec.gap != null) node.itemSpacing = spec.gap;
        applyPadding(node, spec);
        node.primaryAxisAlignItems = align(spec.justify, 'MIN');
        var ca = align(spec.items, 'MIN');
        node.counterAxisAlignItems = ca === 'SPACE_BETWEEN' ? 'MIN' : ca;
        if (spec.wrap) {
          try {
            node.layoutWrap = 'WRAP';
            if (spec.rowGap != null) node.counterAxisSpacing = spec.rowGap;
          } catch (e) {}
        }
      }
      if (spec.clip != null) node.clipsContent = !!spec.clip;
    }

    var fills = toPaints(spec.fill);
    if (fills && 'fills' in node) node.fills = fills;
    else if (spec.fill == null && node.type === 'FRAME') node.fills = [];
  }

  var strokes = toPaints(spec.stroke);
  if (strokes && 'strokes' in node) node.strokes = strokes;
  if (spec.strokeWidth != null && 'strokeWeight' in node) node.strokeWeight = spec.strokeWidth;
  if (spec.strokeAlign && 'strokeAlign' in node) node.strokeAlign = String(spec.strokeAlign).toUpperCase();
  if (spec.dash && 'dashPattern' in node) node.dashPattern = spec.dash;
  if (spec.strokeCap && 'strokeCap' in node) node.strokeCap = String(spec.strokeCap).toUpperCase();

  // Arc / donut ellipses — rings and gauges are a first-class need, and faking
  // them with a stacked pair of ellipses can't express partial progress.
  if (node.type === 'ELLIPSE' && (spec.arc != null || spec.innerRadius != null)) {
    var start = spec.arcStart == null ? -90 : spec.arcStart;
    var sweep = spec.arc == null ? 360 : spec.arc;
    node.arcData = {
      startingAngle: (start * Math.PI) / 180,
      endingAngle: ((start + sweep) * Math.PI) / 180,
      innerRadius: spec.innerRadius == null ? 0 : spec.innerRadius
    };
  }

  applyRadius(node, spec);
  applyEffects(node, spec);

  if (spec.opacity != null && 'opacity' in node) node.opacity = spec.opacity;
  if (spec.blend && 'blendMode' in node) node.blendMode = String(spec.blend).toUpperCase();
  if (spec.visible != null) node.visible = !!spec.visible;

  if (current && current.lease) { current.visibility[node.id] = spec.visible !== false; node.visible = false; }

  return node;
}

async function buildTree(spec) {
  checkCancelled();
  var node = await createNode(spec);
  checkCancelled();
  await tick();
  if (String(spec.type || '').toUpperCase() === 'INSTANCE') return node;
  var kids = spec.children || [];

  for (var i = 0; i < kids.length; i++) {
    var child = await buildTree(kids[i]);
    node.appendChild(child);
    applyChildLayout(child, kids[i]);
  }

  applySizing(node, spec);
  checkCancelled();

  if (spec.rotation != null && 'rotation' in node) node.rotation = spec.rotation;
  return node;
}

// ============ placement ============

function placeOnCanvas(node, spec) {
  if (spec.x != null && spec.y != null) {
    node.x = spec.x;
    node.y = spec.y;
    return;
  }
  var sibs = node.parent.children.filter(function (n) { return n.id !== node.id; });
  if (!sibs.length) {
    node.x = spec.x != null ? spec.x : 0;
    node.y = spec.y != null ? spec.y : 0;
    return;
  }
  var maxX = -Infinity;
  var minY = Infinity;
  for (var i = 0; i < sibs.length; i++) {
    maxX = Math.max(maxX, sibs[i].x + sibs[i].width);
    minY = Math.min(minY, sibs[i].y);
  }
  node.x = spec.x != null ? spec.x : maxX + 120;
  node.y = spec.y != null ? spec.y : (minY === Infinity ? 0 : minY);
}

function summarize(node) {
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    x: Math.round(node.x * 100) / 100,
    y: Math.round(node.y * 100) / 100,
    w: Math.round(node.width * 100) / 100,
    h: Math.round(node.height * 100) / 100
  };
}

// ============ ops ============

async function resolveParent(ref) {
  if (!ref || ref === 'page' || ref === 'PAGE') return figma.currentPage;
  var n = await checked(figma.getNodeByIdAsync(ref));
  if (!n) throw new Error('Parent not found: ' + ref);
  return n;
}

// ping, info and cancel answer at once, outside the queue (see IMMEDIATE), so
// they report what the queue is doing instead of waiting behind it.
var OPS = {
  layoutInfo: async function (cmd) {
    requireFileKey(cmd.expectedFileKey);
    var page = await checked(figma.getNodeByIdAsync(cmd.pageId));
    if (!page || page.type !== 'PAGE') throw failure('wrong-page', 'Automatic layout requires a page, not a nested frame', 'not-started');
    if (typeof page.loadAsync === 'function') await checked(page.loadAsync());
    requireFileKey(cmd.expectedFileKey);
    noteTarget(page, 'read');
    var children = page.children, bounds = [], budget = { nodes: 0 };
    if (children.length > LIMITS.specNodes) throw failure('spatial-budget', 'Too many page roots to plan safely', 'not-started');
    // Another highway's zone job may be mid-creation: its hidden scaffolding is
    // skipped here because its whole zone is already reserved with the coordinator.
    // No page switch, selection change or scene mutation is needed.
    var others = activeJobs.filter(function (j) { return j !== current && j.lease && j.ownedIds; });
    for (var i = 0; i < children.length; i++) {
      if (others.some(function (j) { return j.ownedIds[children[i].id]; })) continue;
      bounds.push(sceneBounds(children[i], budget));
    }
    return { fileKey: figma.fileKey, pageId: page.id, page: page.name, bounds: bounds };
  },
  inspectReservation: async function (cmd) {
    requireFileKey(cmd.expectedFileKey);
    var page = await figma.getNodeByIdAsync(cmd.pageId);
    if (!page || page.type !== 'PAGE') throw failure('wrong-page', 'Reservation page missing', 'not-started');
    if (typeof page.loadAsync === 'function') await page.loadAsync();
    requireFileKey(cmd.expectedFileKey);
    var raw = page.getPluginData('ultimate-reservation-' + cmd.leaseId), receipt;
    try { receipt = JSON.parse(raw); } catch (e) { throw failure('unverifiable', 'No durable plugin receipt; keep this reservation held', 'not-started'); }
    if (receipt.token !== cmd.token || receipt.requestId !== cmd.requestId || receipt.fileKey !== cmd.expectedFileKey || !['committed', 'rolled-back'].includes(receipt.state)) throw failure('unverifiable', 'Plugin receipt is incomplete or does not match this lease', 'not-started');
    if (receipt.state === 'committed') {
      if (!Array.isArray(receipt.nodeIds) || !receipt.nodeIds.length || receipt.nodeIds.length > 64 || !validZoneRect(receipt.rect)) throw failure('unverifiable', 'Invalid commit receipt', 'not-started');
      for (var i = 0; i < receipt.nodeIds.length; i++) {
        var node = await figma.getNodeByIdAsync(receipt.nodeIds[i]);
        requireFileKey(cmd.expectedFileKey);
        if (!node || node.parent !== page) throw failure('external-edit', 'Committed root moved or disappeared', 'not-started');
        var b = sceneBounds(node), r = receipt.rect;
        if (b.x < r.x || b.y < r.y || b.x + b.width > r.x + r.width || b.y + b.height > r.y + r.height) throw failure('external-edit', 'Committed geometry no longer fits its receipt', 'not-started');
      }
      if (page.children.length > LIMITS.specNodes) throw failure('spatial-budget', 'Page scan exceeds the root budget', 'not-started');
      var count = 0;
      for (var j = 0; j < page.children.length; j++) {
        var root = page.children[j]; if (receipt.nodeIds.indexOf(root.id) !== -1) continue;
        var stack = [root];
        while (stack.length) { var child = stack.pop(); if (++count > LIMITS.specNodes) throw failure('spatial-budget', 'Page scan exceeds the node budget', 'not-started'); if (child.children) for (var k = 0; k < child.children.length; k++) stack.push(child.children[k]); }
        if (zoneIntersects(receipt.rect, sceneBounds(root), receipt.gutter || 0)) throw failure('external-edit', 'Other artwork now intersects this reservation', 'not-started');
      }
    }
    return receipt;
  },
  ping: async function () {
    return merge(merge({ ok: true, editor: figma.editorType }, identity()), queueStatus());
  },

  verifyFile: async function (cmd) {
    requireFileKey(cmd.expectedFileKey);
    return identity();
  },

  // A self-contained native undo probe. Anchor the current state, remove only
  // the last explicitly tracked test root, then undo that removal synchronously.
  // Never traverse pre-existing user history or claim that re-creation is redo.
  undo: async function (cmd) {
    requireFileKey(cmd.expectedFileKey);
    if (typeof figma.triggerUndo !== 'function') throw failure('unsupported', 'Native undo is unavailable', 'not-started');
    var receipt = historyCandidate;
    if (!receipt || cmd.receipt !== receipt.requestId || cmd.id !== receipt.id || receipt.fileKey !== figma.fileKey ||
        receipt.pageId !== figma.currentPage.id || cmd.expectedPageId !== receipt.pageId) {
      throw failure('history-guard', 'Undo requires the last tracked test creation receipt in its original file/page', 'not-started');
    }
    var node = await checked(figma.getNodeByIdAsync(receipt.id));
    if (!node || node.name !== receipt.name || node.parent !== figma.currentPage ||
        figma.currentPage.name.indexOf('__Ultimate memory disposable ') !== 0) {
      throw failure('history-guard', 'Tracked test root changed or is outside its disposable page', 'not-started');
    }
    // No await between anchor/remove/undo: user input cannot interleave here.
    historyCandidate = null;
    try { figma.commitUndo(); } catch (e) { throw failure('history-guard', 'Cannot anchor undo state', 'not-started'); }
    try { node.remove(); figma.triggerUndo(); }
    catch (e) { throw failure('history-verification', 'Native history action failed: ' + e.message, 'uncertain'); }
    var restored = await checked(figma.getNodeByIdAsync(receipt.id));
    if (!restored || restored.removed || restored.name !== receipt.name || restored.parent !== figma.currentPage) {
      throw failure('history-verification', 'Native undo did not restore the tracked root; reconcile before continuing', 'uncertain');
    }
    return { verified: true, native: true, semantics: 'remove-and-restore-owned-root', id: restored.id,
      fileKey: figma.fileKey, pageId: figma.currentPage.id };
  },

  redo: async function (cmd) {
    requireFileKey(cmd.expectedFileKey);
    throw failure('unsupported', 'Figma exposes no documented native redo Plugin API. No keyboard input or synthetic replay was performed.', 'not-started');
  },

  reload: async function (cmd) {
    requireFileKey(cmd.expectedFileKey);
    throw failure('unsupported', 'Whole-file reload belongs to the daemon lifecycle API; reloading the plugin iframe is not a document reload.', 'not-started');
  },

  info: async function () {
    return merge({
      file: figma.root.name,
      page: figma.currentPage.name,
      children: figma.currentPage.children.length,
      selection: figma.currentPage.selection.map(summarize)
    }, queueStatus());
  },

  // { op: 'cancel', id }: stop that command (running or queued); without id,
  // everything running and queued. Active work stops at cooperative checkpoints.
  cancel: async function (cmd) {
    var hit = cancelCommands(cmd.id == null ? '*' : cmd.id, cmd.reason || 'cancel op');
    return merge({ cancelled: hit }, queueStatus());
  },

  create: async function (cmd) {
    var specs = cmd.specs || (cmd.spec ? [cmd.spec] : []);
    if (!specs.length) throw new Error('create requires spec or specs');

    var parent = await resolveParent(cmd.parent);
    if (current.lease) {
      if (parent.type !== 'PAGE' || parent.id !== current.lease.pageId) throw failure('wrong-page', 'Reservation parent must be its exact page', 'not-started');
      if (typeof parent.loadAsync === 'function') await checked(parent.loadAsync());
      current.zonePage = parent;
      validateZoneScene(false);
      saveZoneReceipt('running');
    }
    noteTarget(parent, 'write');
    var subs = [];
    var made = [];

    for (var i = 0; i < specs.length; i++) {
      if (i > 0) await pause();
      checkCancelled();
      var s = specs[i];
      var fs = await loadFonts(s);
      if (current.lease) validateZoneScene(false);
      for (var j = 0; j < fs.length; j++) if (subs.indexOf(fs[j]) === -1) subs.push(fs[j]);

      var node = await buildTree(s);
      parent.appendChild(node);

      if (parent.type === 'PAGE') placeOnCanvas(node, s);
      else applyChildLayout(node, s);

      made.push(summarize(node));
    }

    if (current.lease) {
      current.owned.forEach(function (n) { n.visible = current.visibility[n.id] !== false; });
      validateZoneScene(true);
      // Let host layout settle once, then check visual bounds including effects.
      await pause();
      validateZoneScene(true);
      saveZoneReceipt('committed', made.map(function (n) { return n.id; }));
    }

    if (cmd.select !== false && made.length && containingPage(parent) === figma.currentPage) {
      var nodes = [];
      for (var k = 0; k < made.length; k++) {
        var nn = await checked(figma.getNodeByIdAsync(made[k].id));
        if (nn) nodes.push(nn);
      }
      figma.currentPage.selection = nodes;
      if (cmd.zoom !== false) figma.viewport.scrollAndZoomIntoView(nodes);
    }

    var out = { created: made };
    if (current.lease) {
      // No await or mutation separates the final validation and this response.
      out.reservation = { roots: current.validatedRoots.map(function (rect) { return { rect: rect }; }) };
      out.performance = current.performance;
    }
    if (subs.length) out.fontFallbacks = subs;
    return out;
  },

  update: async function (cmd) {
    var node = await checked(figma.getNodeByIdAsync(cmd.id));
    if (!node) throw new Error('Node not found: ' + cmd.id);
    noteTarget(node, 'write');
    var s = cmd.spec || {};
    var text = node.type === 'TEXT' && TEXT_FIELDS.some(function (k) { return s[k] != null; });
    var fonts = text ? await loadTextUpdate(node, s) : null;

    if (s.name) node.name = s.name;
    var fills = toPaints(s.fill);
    if (fills && 'fills' in node) node.fills = fills;
    var strokes = toPaints(s.stroke);
    if (strokes && 'strokes' in node) node.strokes = strokes;
    if (s.strokeWidth != null && 'strokeWeight' in node) node.strokeWeight = s.strokeWidth;
    applyRadius(node, s);
    applyEffects(node, s);
    if (s.opacity != null && 'opacity' in node) node.opacity = s.opacity;
    if (s.visible != null) node.visible = !!s.visible;
    if (s.x != null) node.x = s.x;
    if (s.y != null) node.y = s.y;
    if (text) await applyText(node, s, fonts);
    applyNamedSizing(node, s);
    var out = summarize(node);
    if (fonts && fonts.subs.length) out.fontFallbacks = fonts.subs;
    return out;
  },

  find: async function (cmd) {
    var q = String(cmd.name || '').toLowerCase();
    noteTarget(figma.currentPage, 'read');
    var matches = figma.currentPage.findAll(function (n) {
      return !q || n.name.toLowerCase().indexOf(q) !== -1;
    });
    return matches.slice(0, cmd.limit || 100).map(summarize);
  },

  // Direct children of a node (default: the current page), optionally only the
  // ones whose name starts with `prefix`. Marker scans need nothing deeper, and
  // unlike find this never walks the subtree (bridge review F5).
  //   { op: 'children', id?, prefix? } -> [{ id, name, type, x, y, w, h }]
  children: async function (cmd) {
    var root = cmd.id ? await checked(figma.getNodeByIdAsync(cmd.id)) : figma.currentPage;
    if (!root) throw new Error('Node not found: ' + cmd.id);
    // dynamic-page: a page that is not current may not be loaded yet.
    if (root.type === 'PAGE' && typeof root.loadAsync === 'function') await root.loadAsync();
    noteTarget(root, 'read');
    var kids = root.children || [];
    var prefix = cmd.prefix == null ? null : String(cmd.prefix);
    var out = [];
    for (var i = 0; i < kids.length; i++) {
      if (prefix !== null && kids[i].name.indexOf(prefix) !== 0) continue;
      out.push(summarize(kids[i]));
    }
    return out;
  },

  tree: async function (cmd) {
    var root = cmd.id ? await checked(figma.getNodeByIdAsync(cmd.id)) : figma.currentPage;
    if (!root) throw new Error('Node not found: ' + cmd.id);
    var maxDepth = cmd.depth == null ? 3 : cmd.depth;
    noteTarget(root, 'read');

    function walk(n, d) {
      var o = n.type === 'PAGE' ? { id: n.id, name: n.name, type: n.type } : summarize(n);
      if (d < maxDepth && n.children && n.children.length) {
        o.children = n.children.map(function (c) { return walk(c, d + 1); });
      }
      return o;
    }
    return walk(root, 0);
  },

  remove: async function (cmd) {
    var ids = cmd.ids || (cmd.id ? [cmd.id] : []);
    var removed = [];
    for (var i = 0; i < ids.length; i++) {
      var n = await checked(figma.getNodeByIdAsync(ids[i]));
      checkCancelled();
      if (n) { noteTarget(n, 'write', removed.length > 0); removed.push(ids[i]); n.remove(); }
      await tick();
    }
    return { removed: removed };
  },

  select: async function (cmd) {
    var ids = cmd.ids || (cmd.id ? [cmd.id] : []);
    var nodes = [];
    for (var i = 0; i < ids.length; i++) {
      var n = await checked(figma.getNodeByIdAsync(ids[i]));
      if (n) nodes.push(n);
    }
    figma.currentPage.selection = nodes;
    if (nodes.length) figma.viewport.scrollAndZoomIntoView(nodes);
    return { selected: nodes.map(summarize) };
  },

  /**
   * Pages (figma-cli-ultimate addition). The file holds one page per client app
   * ("Customer app", "Portería app"); create/select/rename them here.
   *   { op: 'page' }                                   -> list pages, current flagged
   *   { op: 'page', action: 'create', name, select }   -> new page (made current unless select === false)
   *   { op: 'page', action: 'select', id }             -> make a page current (create targets it)
   *   { op: 'page', action: 'rename', id, name }
   * documentAccess is dynamic-page, so switching goes through setCurrentPageAsync.
   */
  page: async function (cmd) {
    var action = cmd.action || 'list';
    function brief(p) { return { id: p.id, name: p.name, current: p.id === figma.currentPage.id }; }
    if (action === 'list') return figma.root.children.map(brief);
    if (action === 'select') return selectPage(cmd);
    if (action === 'create') {
      if (!cmd.name) throw new Error('page create requires name');
      var created = figma.createPage();
      created.name = cmd.name;
      if (cmd.select !== false) await figma.setCurrentPageAsync(created);
      return brief(created);
    }
    var pg = await checked(figma.getNodeByIdAsync(cmd.id));
    if (!pg || pg.type !== 'PAGE') throw new Error('Page not found: ' + cmd.id);
    if (action === 'update') {
      if (cmd.index != null && (!Number.isInteger(cmd.index) || cmd.index < 0 || cmd.index >= figma.root.children.length)) throw failure('invalid-request', 'Page index is out of range', 'not-started');
      if (cmd.bg != null && (typeof cmd.bg !== 'string' || !/^#[a-f0-9]{6}$/i.test(cmd.bg))) throw failure('invalid-request', 'Page background must be #RRGGBB', 'not-started');
      if (cmd.index != null) figma.root.insertChild(cmd.index, pg);
      if (cmd.bg != null) pg.backgrounds = toPaints(cmd.bg);
      return brief(pg);
    }
    if (action === 'rename') {
      if (!cmd.name) throw new Error('page rename requires name');
      pg.name = cmd.name;
      return brief(pg);
    }
    throw new Error('Unknown page action "' + action + '". Known: list, create, select, rename, update');
  },

  /**
   * Walks a frame and reports what a contrast/legibility audit needs, resolved
   * against the REAL composited background rather than the nominal fill — a
   * tinted chip over a card over a page is three layers deep, and judging its
   * text against any single one of them gives the wrong ratio.
   */
  audit: async function (cmd) {
    var root = await checked(figma.getNodeByIdAsync(cmd.id));
    if (!root) throw new Error('Node not found: ' + cmd.id);
    noteTarget(root, 'read');

    function firstSolid(n) {
      if (!('fills' in n)) return null;
      var fills = n.fills;
      if (!fills || fills === figma.mixed || !fills.length) return null;
      for (var i = fills.length - 1; i >= 0; i--) {
        var p = fills[i];
        if (p.type === 'SOLID' && p.visible !== false) {
          return { r: p.color.r, g: p.color.g, b: p.color.b, a: p.opacity == null ? 1 : p.opacity };
        }
      }
      return null;
    }

    function over(top, bottom) {
      var a = top.a == null ? 1 : top.a;
      return { r: top.r * a + bottom.r * (1 - a), g: top.g * a + bottom.g * (1 - a), b: top.b * a + bottom.b * (1 - a), a: 1 };
    }

    // Composite every ancestor fill from the outside in.
    function bgOf(n) {
      var chain = [];
      var cur = n.parent;
      while (cur && cur.type !== 'PAGE' && cur.type !== 'DOCUMENT') {
        var p = firstSolid(cur);
        if (p) chain.push(p);
        cur = cur.parent;
      }
      var acc = { r: 1, g: 1, b: 1, a: 1 };   // canvas assumed white
      for (var i = chain.length - 1; i >= 0; i--) acc = over(chain[i], acc);
      return acc;
    }

    var hex = function (c) {
      var f = function (v) { var s = Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16); return s.length < 2 ? '0' + s : s; };
      return '#' + f(c.r) + f(c.g) + f(c.b);
    };

    var texts = [];
    var targets = [];
    var overflow = [];

    var all = root.findAll(function () { return true; });
    for (var i = 0; i < all.length; i++) {
      var n = all[i];

      if (n.type === 'TEXT') {
        var bg = bgOf(n);
        var fgP = firstSolid(n);
        var fg = fgP ? over(fgP, bg) : { r: 0, g: 0, b: 0 };
        var fname = n.fontName;
        texts.push({
          name: n.name,
          chars: String(n.characters).slice(0, 48),
          size: n.fontSize === figma.mixed ? null : Math.round(n.fontSize * 10) / 10,
          style: fname && fname !== figma.mixed ? fname.style : null,
          fg: hex(fg),
          bg: hex(bg),
          w: Math.round(n.width),
          h: Math.round(n.height)
        });
      }

      // Anything shaped like a control that is too small to hit reliably
      if (n.type === 'FRAME' && n.parent && n.parent.type !== 'PAGE') {
        // A pill containing only text is a badge, not a tap target. Require an
        // icon child (or an explicitly interactive name) before flagging size.
        var kids = n.children || [];
        var hasNonText = kids.some(function (k) { return k.type !== 'TEXT'; });
        var isControl = (/button|tab|toggle|btn/i.test(n.name)) ||
                        ((n.cornerRadius === 999 || n.cornerRadius >= 12) && hasNonText && kids.length > 0);
        if (isControl && (n.width < 44 || n.height < 44)) {
          targets.push({ name: n.name, w: Math.round(n.width), h: Math.round(n.height) });
        }
      }

      // Content pushed past the bottom of the screen frame
      if (n.parent === root && n.y + n.height > root.height + 0.5) {
        overflow.push({ name: n.name, bottom: Math.round(n.y + n.height), frameH: Math.round(root.height) });
      }
    }

    return { frame: { id: root.id, name: root.name, w: Math.round(root.width), h: Math.round(root.height) }, texts: texts, targets: targets, overflow: overflow };
  },

  // ---- figma-cli-ultimate additions ----

  // Installed font families (optionally filtered), with their styles. Lets a
  // build script pick a monospace family that really exists instead of
  // silently falling back to Inter.
  fonts: async function (cmd) {
    var all = await figma.listAvailableFontsAsync();
    var q = String(cmd.query || '').toLowerCase();
    var fams = {};
    for (var i = 0; i < all.length; i++) {
      var fn = all[i].fontName;
      if (q && fn.family.toLowerCase().indexOf(q) === -1) continue;
      if (!fams[fn.family]) fams[fn.family] = [];
      fams[fn.family].push(fn.style);
    }
    return fams;
  },

  // Prototype wiring. reactions: [{ trigger, to | back }], where trigger is a
  // Plugin API Trigger ({type:'ON_CLICK'} or {type:'ON_KEY_DOWN', keyCodes:[..]})
  // and `to` a destination node id. Replaces the node's existing reactions.
  reactions: async function (cmd) {
    var node = await checked(figma.getNodeByIdAsync(cmd.id));
    if (!node) throw new Error('Node not found: ' + cmd.id);
    noteTarget(node, 'write');
    var rs = (cmd.reactions || []).map(function (r) {
      var trigger = r.trigger || { type: 'ON_CLICK' };
      if (trigger.type === 'ON_KEY_DOWN' && !trigger.device) trigger.device = 'KEYBOARD';
      var action;
      if (r.back) {
        action = { type: 'BACK' };
      } else if (r.to) {
        action = {
          type: 'NODE',
          destinationId: r.to,
          navigation: r.navigation || 'NAVIGATE',
          transition: r.transition || null,
          preserveScrollPosition: false
        };
      } else {
        action = { type: 'NONE' };
      }
      return { trigger: trigger, actions: [action] };
    });
    try {
      if (typeof node.setReactionsAsync === 'function') await node.setReactionsAsync(rs);
      else node.reactions = rs;
    } catch (e1) {
      // Older API shape: a single `action` per reaction.
      var legacy = rs.map(function (r) { return { trigger: r.trigger, action: r.actions[0] }; });
      if (typeof node.setReactionsAsync === 'function') await node.setReactionsAsync(legacy);
      else node.reactions = legacy;
    }
    return { id: node.id, reactions: rs.length };
  },

  // Marks a frame as a prototype flow starting point on the current page.
  flowStart: async function (cmd) {
    var page = cmd.pageId ? await checked(figma.getNodeByIdAsync(cmd.pageId)) : figma.currentPage;
    var target = await checked(figma.getNodeByIdAsync(cmd.id));
    if (!page || page.type !== 'PAGE' || !target || containingPage(target) !== page) throw failure('wrong-page', 'Flow start must belong to the specified page', 'not-started');
    if (typeof page.loadAsync === 'function') await checked(page.loadAsync());
    noteTarget(target, 'write');
    var pts = cmd.reset ? [] : page.flowStartingPoints.filter(function (p) { return p.nodeId !== cmd.id; });
    pts.push({ nodeId: cmd.id, name: cmd.name || 'Start' });
    page.flowStartingPoints = pts;
    return { flows: pts.map(function (p) { return p.name; }) };
  },

  // Registers a bitmap (base64 PNG/JPEG, <= 4096px) and returns its hash for
  // { type: 'IMAGE', hash } fills. Upload once per build, reuse everywhere.
  image: async function (cmd) {
    if (!cmd.base64) throw new Error('image requires base64');
    if (typeof figma.base64Decode !== 'function') throw new Error('figma.base64Decode unavailable');
    var img = figma.createImage(figma.base64Decode(cmd.base64));
    var size = null;
    try { size = await img.getSizeAsync(); } catch (e) {}
    return { hash: img.hash, width: size && size.width, height: size && size.height };
  },

  // ---- end figma-cli-ultimate additions ----

  exportImage: async function (cmd) {
    var node = cmd.id ? await checked(figma.getNodeByIdAsync(cmd.id)) : figma.currentPage.selection[0];
    if (!node) throw new Error('Nothing to export');
    noteTarget(node, 'snapshot');
    checkCancelled();
    var scale = cmd.scale == null ? 1 : cmd.scale;
    if (!isFinite(scale) || scale <= 0 || node.width * node.height * scale * scale > LIMITS.exportPixels) {
      throw failure('limit-exceeded', 'Export exceeds the pixel budget; lower scale');
    }
    var bytes = await node.exportAsync({
      format: cmd.format || 'PNG',
      constraint: { type: 'SCALE', value: scale }
    });
    checkCancelled();
    if (typeof figma.base64Encode !== 'function') {
      throw new Error('figma.base64Encode unavailable in this Figma build');
    }
    return {
      id: node.id,
      name: node.name,
      format: cmd.format || 'PNG',
      base64: figma.base64Encode(bytes)
    };
  }
};


// Page references are available without loading their scene. Preload explicitly
// so native switching does not also have to load a heavy page. Neither phase
// yields through the UI watchdog, and a cancelled native call must settle before
// the file queue advances. Do not race it against a timer or retry it blindly.
async function selectPage(cmd) {
  var started = Date.now(), phase = 'lookup', previous = figma.currentPage.id, switching = false, page;
  function details(cause) {
    var d = { phase: phase, requestedPageId: typeof cmd.id === 'string' ? cmd.id.slice(0, 128) : null, previousPageId: previous,
      currentPageId: figma.currentPage.id, elapsedMs: Date.now() - started, artworkChanged: false };
    if (arguments.length) d.cause = String(cause && cause.message || cause).slice(0, 512);
    return d;
  }
  function result(navigation) { return { id: page.id, name: page.name, current: page.id === figma.currentPage.id, navigation: navigation }; }
  try {
    if (typeof cmd.id !== 'string' || !cmd.id || cmd.id.length > 128) throw new Error('page select requires a page id');
    page = figma.root.children.find(function (p) { return p.id === cmd.id; });
    if (!page || page.type !== 'PAGE') throw new Error('Page not found: ' + cmd.id);
    noteTarget(page, 'navigation');
    checkCancelled();
    if (page.id === figma.currentPage.id) return result(details());
    phase = 'load';
    if (typeof page.loadAsync === 'function') await checked(page.loadAsync());
    checkCancelled();
    phase = 'switch'; switching = true;
    await checked(figma.setCurrentPageAsync(page));
    if (figma.currentPage.id !== page.id) throw new Error('Figma did not select the requested page');
    return result(details());
  } catch (cause) {
    var navigation = details(cause);
    // The native promise can reject after the visible page has changed. Read
    // back the actual page to reconcile navigation; never claim a cancelled job succeeded.
    if (switching && !(current && current.cancelReason) && figma.currentPage.id === page.id) {
      navigation.reconciled = true; return result(navigation);
    }
    // Native errors may be non-extensible; wrap rather than annotating them.
    var error = failure(cause && cause.kind || 'page-navigation', 'Page navigation (' + phase + '): ' + navigation.cause,
      switching ? 'failed' : 'not-started');
    error.details = { navigation: navigation }; throw error;
  }
}
async function checked(promise) { var value = await promise; checkCancelled(); if (current && current.zonePage) validateZoneScene(false); return value; }
function failure(kind, message, outcome) {
  var e = new Error(message); e.kind = kind; e.outcome = outcome; return e;
}
function merge(a, b) { for (var k in b) a[k] = b[k]; return a; }
function containingPage(n) { while (n && n.type !== 'PAGE') n = n.parent; return n; }
function boxOf(node) {
  if (!node || node.type === 'PAGE') return null;
  try {
    var r = node.absoluteBoundingBox;
    return r && [r.x, r.y, r.width, r.height].every(isFinite) ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
  } catch (e) { return null; }
}
// Where the current job reads or writes, for the console map: its page and the
// page-space box of the node it touches (none = the whole page). widen grows the
// box over several nodes on the same page.
function noteTarget(node, kind, widen) {
  if (!current || !node) return;
  var page = containingPage(node); if (!page) return;
  var box = boxOf(node), old = current.target;
  if (widen && old && old.pageId === page.id && old.kind === kind) {
    if (!box || !old.bounds) box = null;
    else {
      var x = Math.min(old.bounds.x, box.x), y = Math.min(old.bounds.y, box.y);
      box = { x: x, y: y, width: Math.max(old.bounds.x + old.bounds.width, box.x + box.width) - x, height: Math.max(old.bounds.y + old.bounds.height, box.y + box.height) - y };
    }
  }
  current.target = { pageId: page.id, page: page.name, parentId: node.id, kind: kind, bounds: box };
  current.targetPage = page;
  if (kind === 'write' && current.touched && current.touched.indexOf(page) === -1 && current.touched.length < 8) current.touched.push(page);
  // A batch of small edits reports its moving target a few times a second, not per node.
  if (current.targetSentPage !== page.id || Date.now() - (current.targetSentAt || 0) > 250) {
    current.targetSentPage = page.id; current.targetSentAt = Date.now(); status();
  }
}
// Coarse artwork map for the console: top-level frame bounds bucketed into a
// small grid, hex-encoded. It never loads a page; an unloaded page has no sketch.
var SKETCH_COLS = 48, SKETCH_ROWS = 30, SKETCH_ROOTS = 5000, SKETCH_MS = 1000;
var sketchAt = Object.create(null), dirtyPages = [];
function pageSketch(page) {
  var children;
  try { children = page.children; } catch (e) { return null; }
  var base = { pageId: page.id, page: page.name, roots: children.length, cols: SKETCH_COLS, rows: SKETCH_ROWS, extent: null, cells: '', measuredAt: Date.now() };
  if (children.length > SKETCH_ROOTS) { base.cells = null; return base; }
  var boxes = [], minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (var i = 0; i < children.length; i++) {
    var b = boxOf(children[i]); if (!b) continue;
    boxes.push(b); minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width); maxY = Math.max(maxY, b.y + b.height);
  }
  if (!boxes.length) return base;
  var w = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY), bits = [];
  for (var c = 0; c < SKETCH_COLS * SKETCH_ROWS; c++) bits.push(0);
  boxes.forEach(function (r) {
    var c0 = Math.floor((r.x - minX) / w * SKETCH_COLS), c1 = Math.ceil((r.x + r.width - minX) / w * SKETCH_COLS) - 1;
    var r0 = Math.floor((r.y - minY) / h * SKETCH_ROWS), r1 = Math.ceil((r.y + r.height - minY) / h * SKETCH_ROWS) - 1;
    for (var y = Math.max(0, r0); y <= Math.min(SKETCH_ROWS - 1, r1); y++)
      for (var x = Math.max(0, c0); x <= Math.min(SKETCH_COLS - 1, Math.max(c0, c1)); x++) bits[y * SKETCH_COLS + x] = 1;
  });
  var hex = '';
  for (var k = 0; k < bits.length; k += 4) hex += (bits[k] * 8 + bits[k + 1] * 4 + bits[k + 2] * 2 + bits[k + 3]).toString(16);
  base.extent = { x: minX, y: minY, width: w, height: h }; base.cells = hex;
  return base;
}
function sendSketch(page, force) {
  if (!page || page.removed || page.type !== 'PAGE') return;
  var now = Date.now();
  if (!force && sketchAt[page.id] && now - sketchAt[page.id] < SKETCH_MS) return;
  var sketch = pageSketch(page); if (!sketch) return;
  sketchAt[page.id] = now;
  var keys = Object.keys(sketchAt); if (keys.length > 64) delete sketchAt[keys[0]];
  figma.ui.postMessage(merge({ type: 'page-sketch' }, sketch));
}
// Written pages redraw at most once a second while work streams, and once more
// when the queue drains, so a burst of small writes still ends on a fresh sketch.
function sketchAfter(written, read) {
  written.forEach(function (p) { if (dirtyPages.indexOf(p) === -1) dirtyPages.push(p); });
  if (dirtyPages.length > 8) dirtyPages = dirtyPages.slice(-8);
  if (!queuedJobs() && activeJobs.length === 0) { var pages = dirtyPages; dirtyPages = []; pages.forEach(function (p) { sendSketch(p, true); }); }
  else written.forEach(function (p) { sendSketch(p, false); });
  // A page that was only read is drawn once for context (first look or stale).
  if (read && written.indexOf(read) === -1) sendSketch(read, false);
}
function requireFileKey(expected) {
  if (typeof expected !== 'string' || !/^[A-Za-z0-9]{1,128}$/.test(expected)) throw failure('invalid-request', 'An exact expectedFileKey is required', 'not-started');
  if (typeof figma.fileKey !== 'string' || !figma.fileKey) throw failure('file-key-unavailable', 'This plugin session cannot attest the live file key', 'not-started');
  if (figma.fileKey !== expected) throw failure('wrong-file', 'Live file key does not match expectedFileKey', 'not-started');
}
function identity() {
  return { version: VERSION, protocol: PROTOCOL, build: BUILD, file: figma.root.name,
    fileKey: typeof figma.fileKey === 'string' ? figma.fileKey : null, instanceId: INSTANCE_ID,
    capabilities: { fileKey: typeof figma.fileKey === 'string' && !!figma.fileKey, smartBuilderBoard: true,
      undo: typeof figma.triggerUndo === 'function' ? 'owned-remove-restore' : false, redo: false, documentReload: false },
    page: figma.currentPage.name, pageId: figma.currentPage.id };
}
var LIMITS = { messageBytes: 8 * 1024 * 1024, resultBytes: 32 * 1024 * 1024,
  queueBytes: 16 * 1024 * 1024, queueJobs: 8, batchItems: 128, specNodes: 10000,
  specDepth: 64, exportPixels: 32 * 1024 * 1024 };
var IMMEDIATE = { ping: true, info: true, cancel: true, verifyFile: true, inspectReservation: true };
var MUTATING = { create: true, update: true, remove: true, reactions: true, flowStart: true, page: true, image: true, select: true };
function mutatesArtwork(cmd) { return !!MUTATING[cmd.op] && !(cmd.op === 'page' && cmd.action === 'select'); }
var YIELD_EVERY = 100;
var waiting = [], queuedBytes = 0, current = null;
// One FIFO per channel: 'main' is the paired control socket, every other channel
// is a highway with its own socket. Jobs of different channels take turns on this
// single thread at their pause points (every 100 nodes and between batch items),
// so one agent's long batch never makes another agent wait for all of it. Only
// the job holding the turn runs between awaits; `current` is always that job.
var channels = { main: { id: 'main', waiting: waiting, running: null } }, activeJobs = [], turnHolder = null, turnQueue = [];
var yieldSeq = 0, yieldWaiters = Object.create(null);
function queuedJobs() { var n = 0; for (var id in channels) n += channels[id].waiting.length; return n; }
function acquireTurn(job) {
  if (!turnHolder) { turnHolder = job; return Promise.resolve(); }
  return new Promise(function (resolve) { turnQueue.push({ job: job, resolve: resolve }); });
}
function passTurn() {
  var next = turnQueue.shift();
  turnHolder = next ? next.job : null;
  if (next) next.resolve();
}
// Called at a pause point: hand the thread to the next waiting job (round robin)
// and continue when the turn comes back. A lone job never stops here.
async function shareTurn() {
  if (!turnQueue.length || !current || turnHolder !== current) return;
  var me = current, back = new Promise(function (resolve) { turnQueue.push({ job: me, resolve: resolve }); });
  me.fontCache = fontCache; current = null;
  passTurn();
  await back;
  current = me; fontCache = me.fontCache; me.turns = (me.turns || 0) + 1;
}
var coordinatorSession = null, usedLeases = Object.create(null);
function saveZoneReceipt(state, nodeIds) {
  if (!current || !current.lease || !current.zonePage) return;
  var l = current.lease;
  current.zonePage.setPluginData('ultimate-reservation-' + l.leaseId, JSON.stringify({ state: state, requestId: l.requestId,
    token: l.token, fileKey: l.fileKey, rect: l.rect, gutter: l.gutter, nodeIds: nodeIds || [] }));
}
function validZoneRect(r) { return r && ['x', 'y', 'width', 'height'].every(function (k) { return Number.isFinite(r[k]) && Math.abs(r[k]) <= 1e7; }) && r.width > 0 && r.height > 0; }
function zoneIntersects(a, b, g) { return a.x < b.x + b.width + g && a.x + a.width + g > b.x && a.y < b.y + b.height + g && a.y + a.height + g > b.y; }
// A lease is fenced to the session of the channel that carries it: the control
// socket's worker session, or the highway's own session (told by the daemon).
var highwaySessions = Object.create(null);
function validateLease(lease, channel) {
  var expected = channel && channel !== 'main' ? highwaySessions[channel] : coordinatorSession && coordinatorSession.sessionEpoch;
  if (!coordinatorSession || !expected || lease.sessionEpoch !== expected || lease.coordinatorEpoch !== coordinatorSession.coordinatorEpoch ||
      !Number.isSafeInteger(lease.token) || lease.token < 1 || typeof lease.leaseId !== 'string' || !validZoneRect(lease.rect) || !Number.isFinite(lease.gutter) || lease.gutter < 0) {
    throw failure('stale-lease', 'Reservation does not belong to this coordinator session', 'not-started');
  }
  requireFileKey(lease.fileKey);
}
function sceneBounds(root, budget, owned) {
  var stack = [root], bounds = null, count = 0;
  while (stack.length) {
    var n = stack.pop();
    if (++count > LIMITS.specNodes) throw failure('spatial-budget', 'Geometry scan exceeds the node budget', 'not-started');
    if (budget && ++budget.nodes > LIMITS.specNodes) throw failure('spatial-budget', 'Page scan exceeds 10000 nodes', 'not-started');
    if (current && current.performance) current.performance.spatialNodes++;
    if (owned && !owned[n.id]) throw failure('external-edit', 'A foreign node was inserted into owned content', 'partial');
    if (n.removed) throw failure('external-edit', 'Node removed during geometry validation', 'partial');
    // Reserve invisible geometry too: making it visible later must not steal a zone.
    var r = n.absoluteRenderBounds || n.absoluteBoundingBox;
    if (!r || !['x', 'y', 'width', 'height'].every(function (k) { return Number.isFinite(r[k]); })) throw failure('bounds-unavailable', 'Cannot attest visual bounds for ' + n.id, 'not-started');
    if (!bounds) bounds = { x: r.x, y: r.y, width: r.width, height: r.height };
    else { var x = Math.min(bounds.x, r.x), y = Math.min(bounds.y, r.y); bounds = { x: x, y: y, width: Math.max(bounds.x + bounds.width, r.x + r.width) - x, height: Math.max(bounds.y + bounds.height, r.y + r.height) - y }; }
    // Conservative: include descendants even when clipped by a parent.
    // Figma properties cross the native boundary. Fetch a child collection once,
    // and count/attest ownership in this same walk instead of traversing twice.
    var children = n.children;
    if (children) for (var i = 0; i < children.length; i++) stack.push(children[i]);
  }
  return bounds;
}
function validateZoneScene(final) {
  if (!current || !current.lease || !current.zonePage) return;
  var started = Date.now(), metrics = current.performance;
  metrics.spatialChecks++;
  try { validateZoneSceneNow(final); }
  finally { var elapsed = Date.now() - started; metrics.spatialMs += elapsed; metrics.spatialMaxMs = Math.max(metrics.spatialMaxMs, elapsed); }
}
function validateZoneSceneNow(final) {
  validateLease(current.lease, current.channel);
  var page = current.zonePage, lease = current.lease, roots = [], foreignBudget = { nodes: 0 };
  if (page.removed || page.id !== lease.pageId) throw failure('external-edit', 'Target page disappeared', 'partial');
  var owned = current.ownedIds;
  var children = page.children;
  if (children.length > LIMITS.specNodes) throw failure('spatial-budget', 'Too many page roots to attest safely', 'not-started');
  // Another zone job sharing the thread parks its hidden scaffolding on the page;
  // its zone is disjoint from ours (admission guarantees it) and it validates itself.
  var others = activeJobs.filter(function (j) { return j !== current && j.lease && j.ownedIds; });
  for (var i = 0; i < children.length; i++) {
    var n = children[i];
    if (owned[n.id]) { roots.push(n); continue; }
    if (others.some(function (j) { return j.ownedIds[n.id]; })) continue;
    // Still read fresh geometry at EVERY checkpoint; no cache survives an await.
    if (zoneIntersects(lease.rect, sceneBounds(n, foreignBudget), lease.gutter)) throw failure('zone-conflict', 'Existing artwork intersects the reserved zone: ' + n.id, 'partial');
  }
  var measured = [], ownedBudget = { nodes: 0 };
  if (final) for (var j = 0; j < roots.length; j++) {
    var b = sceneBounds(roots[j], ownedBudget, owned), r = lease.rect;
    if (b.x < r.x || b.y < r.y || b.x + b.width > r.x + r.width || b.y + b.height > r.y + r.height) throw failure('zone-overflow', 'Created visual bounds exceed the reserved zone', 'partial');
    // Bounds are immutable within this synchronous check. Pairwise arithmetic
    // must not re-enter the native scene graph for each earlier root.
    for (var p = 0; p < measured.length; p++) if (zoneIntersects(b, measured[p], lease.gutter)) throw failure('zone-conflict', 'Created roots overlap each other', 'partial');
    measured.push(b);
  }
  if (final) current.owned.forEach(function (n) { if (n.removed || containingPage(n) !== page) throw failure('external-edit', 'Owned node moved outside its target page', 'partial'); });
  if (final) current.validatedRoots = measured;
}

function byteLength(text) {
  var n = 0;
  for (var i = 0; i < text.length; i++) {
    var c = text.charCodeAt(i);
    if (c < 128) n++; else if (c < 2048) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { n += 4; i++; }
    else n += 3;
  }
  return n;
}
function isImmediate(cmd) { return !!(cmd && Object.prototype.hasOwnProperty.call(IMMEDIATE, cmd.op)); }
function jobSummary(job) {
  return job && { id: job.id, op: job.op, ms: Date.now() - job.since, done: job.done, total: job.total, cancelled: job.cancelReason || null,
    target: job.target || null, ownedNodes: job.owned.length, channel: job.channel, turns: job.turns || 0 };
}
function queueStatus() {
  var queue = [], shown = current || activeJobs[0] || null;
  Object.keys(channels).forEach(function (id) {
    channels[id].waiting.forEach(function (job) {
      queue.push({ id: job.msg.id, op: job.msg.type === 'cmd' ? job.msg.cmd.op : 'batch', channel: id,
        nodes: job.work, bytes: job.bytes, waitMs: Date.now() - job.enqueuedAt,
        parentId: job.msg.type === 'cmd' && typeof job.msg.cmd.parent === 'string' ? job.msg.cmd.parent.slice(0, 128) : null });
    });
  });
  return { busy: activeJobs.length > 0, queued: queue.length, queuedBytes: queuedBytes, queue: queue,
    historyReceiptEntries: historyCandidate ? 1 : 0,
    yieldWaiters: Object.keys(yieldWaiters).length, fontCacheEntries: Object.keys(fontCache).length, limits: LIMITS,
    current: jobSummary(shown), running: activeJobs.map(jobSummary), turnWaiting: turnQueue.length };
}
function status() { figma.ui.postMessage(merge(merge({ type: 'status' }, identity()), queueStatus())); }
// Every reply carries its highway so the UI returns it on the socket it came from.
function reply(msg, fields) {
  var answer = merge({ type: msg.type === 'cmd-batch' ? 'batch-result' : 'result', id: msg.id, session: msg.session }, fields);
  if (byteLength(JSON.stringify(answer)) > LIMITS.resultBytes) {
    answer = { type: answer.type, id: msg.id, session: msg.session, error: 'Result exceeds the response budget', kind: 'result-too-large', outcome: 'uncertain' };
  }
  if (msg.highway) answer.highway = msg.highway;
  figma.ui.postMessage(answer);
}
function checkCancelled() {
  if (current && current.cancelReason) throw failure(current.cancelKind || 'cancelled', 'Cancelled (' + current.cancelReason + ')', 'partial');
  if (current && current.lease) validateLease(current.lease, current.channel);
}
function finishYield(k, error) {
  var w = yieldWaiters[k]; if (!w) return;
  delete yieldWaiters[k];
  figma.ui.postMessage({ type: 'yield-finished', k: Number(k) });
  if (error) w.reject(error); else w.resolve();
}
// channel limits '*' to one channel (a dropped control socket must not stop highways).
function cancelCommands(id, reason, kind, channel) {
  id = String(id); var hit = [];
  activeJobs.forEach(function (job) {
    if ((channel && job.channel !== channel) || (id !== '*' && job.id !== id)) return;
    job.cancelReason = reason || 'cancelled'; job.cancelKind = kind || 'cancelled'; hit.push(job.id);
    Object.keys(yieldWaiters).forEach(function (k) { if (yieldWaiters[k].job === job) finishYield(k, failure(job.cancelKind, job.cancelReason, 'partial')); });
  });
  Object.keys(channels).forEach(function (name) {
    if (channel && name !== channel) return;
    var list = channels[name].waiting;
    for (var i = list.length - 1; i >= 0; i--) {
      var job = list[i];
      if (id !== '*' && job.msg.id !== id) continue;
      list.splice(i, 1); queuedBytes -= job.bytes; hit.push(job.msg.id);
      reply(job.msg, { error: 'Cancelled before execution', kind: 'cancelled', outcome: 'not-started' });
      job.msg = null;
    }
  });
  status(); return hit;
}
function validateCommand(cmd) {
  if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd) || !Object.prototype.hasOwnProperty.call(OPS, cmd.op)) {
    throw failure('invalid-request', 'Unknown or malformed command', 'not-started');
  }
  if (cmd.expectedFileKey !== undefined) requireFileKey(cmd.expectedFileKey);
  if (cmd.trackHistory) {
    requireFileKey(cmd.expectedFileKey);
    if (cmd.op !== 'create' || !cmd.spec || cmd.specs || typeof cmd.spec.name !== 'string' || cmd.spec.name.indexOf('__history_') !== 0 ||
        cmd.parent !== figma.currentPage.id || figma.currentPage.name.indexOf('__Ultimate memory disposable ') !== 0) {
      throw failure('history-guard', 'History tracking accepts one named test root on the current disposable page', 'not-started');
    }
  }
  if (cmd.ids != null && (!Array.isArray(cmd.ids) || cmd.ids.length > LIMITS.specNodes)) throw failure('invalid-request', 'Invalid ids list', 'not-started');
  if (cmd.depth != null && (!Number.isInteger(cmd.depth) || cmd.depth < 0 || cmd.depth > LIMITS.specDepth)) throw failure('invalid-request', 'Invalid tree depth', 'not-started');
  if (cmd.limit != null && (!Number.isInteger(cmd.limit) || cmd.limit < 1 || cmd.limit > LIMITS.specNodes)) throw failure('invalid-request', 'Invalid result limit', 'not-started');
  var specs = cmd.specs == null ? (cmd.spec == null ? [] : [cmd.spec]) : cmd.specs;
  if (!Array.isArray(specs) || (cmd.op === 'create' && !specs.length)) throw failure('invalid-request', 'create requires spec or specs', 'not-started');
  var stack = specs.map(function (s) { return { spec: s, depth: 1 }; }), count = 0;
  while (stack.length) {
    var item = stack.pop(), spec = item.spec;
    if (++count > LIMITS.specNodes || item.depth > LIMITS.specDepth) throw failure('limit-exceeded', 'Spec node/depth budget exceeded', 'not-started');
    if (!spec || typeof spec !== 'object' || Array.isArray(spec) || (spec.children != null && !Array.isArray(spec.children))) throw failure('invalid-request', 'Malformed node spec', 'not-started');
    if (String(spec.type || '').toUpperCase() === 'INSTANCE' && (typeof spec.of !== 'string' || (spec.children && spec.children.length))) throw failure('invalid-request', 'INSTANCE requires of and cannot contain child specs', 'not-started');
    var kids = spec.children || [];
    if (kids.length + stack.length + count > LIMITS.specNodes) throw failure('limit-exceeded', 'Spec node budget exceeded', 'not-started');
    for (var i = 0; i < kids.length; i++) stack.push({ spec: kids[i], depth: item.depth + 1 });
  }
  return cmd.op === 'create' ? count : 0;
}
function ownNode(node) {
  if (!current) return;
  // SVG imports can create descendants in one native call. Capture them now so
  // later external insertions are distinguishable from nodes created by this job.
  var stack = [node];
  while (stack.length) { var n = stack.pop(); current.owned.push(n); current.ownedIds[n.id] = true; if (current.lease) current.visibility[n.id] = n.visible !== false; var children = n.children; if (children) for (var i = 0; i < children.length; i++) stack.push(children[i]); }
  if (current.zonePage) { node.visible = false; current.zonePage.appendChild(node); node.x = 0; node.y = 0; }
}
function rollbackOwned() {
  var failed = [], owned = Object.create(null);
  current.owned.forEach(function (n) { owned[n.id] = true; });
  for (var i = current.owned.length - 1; i >= 0; i--) {
    var n = current.owned[i];
    try {
      if (!n.removed) {
        // Native instance descendants are immutable. Remove their owned root;
        // an owned node moved outside that root is still cleaned separately.
        if (n.parent && owned[n.parent.id] && !n.parent.removed) continue;
        var stack = n.children ? n.children.slice() : [], foreign = false;
        while (stack.length) { var child = stack.pop(); if (!owned[child.id]) { foreign = true; break; } if (child.children) for (var j = 0; j < child.children.length; j++) stack.push(child.children[j]); }
        if (foreign) failed.push(n.id); else n.remove();
      }
    } catch (e) { failed.push(n.id); }
  }
  current.owned = []; return failed;
}
function performanceCounters() {
  return { spatialChecks: 0, spatialNodes: 0, spatialMs: 0, spatialMaxMs: 0, yieldCount: 0, yieldMs: 0 };
}
async function runCommand(cmd) {
  // Validate again at execution, since a queued request may outlive a page switch.
  if (cmd.expectedFileKey !== undefined) requireFileKey(cmd.expectedFileKey);
  if (isImmediate(cmd)) return OPS[cmd.op](cmd);
  checkCancelled();
  if (cmd.trackHistory) validateCommand(cmd);
  if (mutatesArtwork(cmd)) historyCandidate = null;
  current.owned = []; current.ownedIds = Object.create(null); current.target = null; fontCache = Object.create(null);
  current.performance = performanceCounters();
  try {
    var value = await OPS[cmd.op](cmd);
    checkCancelled();
    if (cmd.trackHistory && value.created.length === 1) {
      historyCandidate = { id: value.created[0].id, name: value.created[0].name,
        fileKey: figma.fileKey, pageId: figma.currentPage.id, requestId: current.id };
      value.historyReceipt = current.id;
    }
    current.owned = []; return value;
  } catch (e) {
    if (cmd.op === 'create') {
      var failed = rollbackOwned();
      e.outcome = failed.length ? 'uncertain' : 'rolled-back';
      if (!failed.length && current.lease) { try { saveZoneReceipt('rolled-back'); } catch (receiptError) { e.outcome = 'uncertain'; } }
      if (failed.length) e.details = { cleanupFailedIds: failed };
    } else if (!e.outcome) e.outcome = mutatesArtwork(cmd) ? 'partial' : 'failed';
    throw e;
  } finally { fontCache = Object.create(null); }
}
function uiRoundTrip() {
  var job = current;
  return new Promise(function (resolve, reject) {
    var k = ++yieldSeq; yieldWaiters[k] = { resolve: resolve, reject: reject, job: job };
    figma.ui.postMessage({ type: 'yield', k: k });
  });
}
async function pause() {
  checkCancelled(); if (!current) return;
  current.lastYield = current.done;
  var progress = { type: 'progress', session: current.session, id: current.id, done: current.done, total: current.total, state: queueStatus() };
  if (current.channel !== 'main') progress.highway = current.channel;
  figma.ui.postMessage(progress);
  var started = Date.now(); current.performance.yieldCount++;
  await uiRoundTrip(); current.performance.yieldMs += Date.now() - started; checkCancelled();
  await shareTurn(); checkCancelled();
  if (current.zonePage) validateZoneScene(false);
}
async function tick() {
  checkCancelled(); if (!current) return;
  current.done++;
  if (current.done - current.lastYield >= YIELD_EVERY) await pause();
  checkCancelled();
}
async function runItems(cmds) {
  var results = [];
  for (var i = 0; i < cmds.length; i++) {
    try {
      if (i > 0) await pause();
      checkCancelled();
      results.push({ success: true, result: await runCommand(cmds[i]) });
    } catch (e) {
      results.push({ success: false, error: e.message || String(e), kind: e.kind || 'plugin', outcome: e.outcome || 'failed', details: e.details });
      // Stop on first failure; never silently continue a dependent batch.
      for (var j = i + 1; j < cmds.length; j++) results.push({ success: false, error: 'Skipped after earlier failure', kind: 'skipped', outcome: 'not-started' });
      break;
    }
  }
  return results;
}
// Each channel runs one job at a time, in arrival order; channels share the thread.
function startChannel(name) {
  var c = channels[name];
  if (!c || c.running || !c.waiting.length) return;
  var job = c.waiting.shift(); queuedBytes -= job.bytes; c.running = job;
  runJob(c, job).catch(function (e) { console.error(e); }).then(function () {
    c.running = null;
    if (name !== 'main' && !c.waiting.length) delete channels[name];
    startChannel(name);
  });
}
async function runJob(c, job) {
  var msg = job.msg;
  // Immediate reads bypass runCommand's per-operation initialization, but
  // every batch still yields between items (including ping/info first).
  var ctx = { id: msg.id, session: msg.session, channel: c.id, lease: msg.lease || null, visibility: Object.create(null), op: msg.type === 'cmd' ? msg.cmd.op : 'batch',
    since: Date.now(), done: 0, total: job.work, lastYield: 0, owned: [], ownedIds: Object.create(null), touched: [], performance: performanceCounters() };
  activeJobs.push(ctx);
  var tag = function (m) { if (c.id !== 'main') m.highway = c.id; return m; };
  await acquireTurn(ctx);
  current = ctx; fontCache = Object.create(null);
  figma.ui.postMessage(tag({ type: 'busy', session: msg.session, busy: true, id: msg.id, op: ctx.op, total: job.work, queued: c.waiting.length, queuedBytes: queuedBytes }));
  status();
  try {
    if (msg.type === 'cmd-batch') {
      var results = await runItems(msg.cmds);
      reply(msg, { results: results, outcome: results.some(function (r) { return !r.success; }) ? 'partial' : 'succeeded' });
      results = null;
    } else reply(msg, { result: await runCommand(msg.cmd) });
  } catch (e) {
    reply(msg, { error: e.message || String(e), kind: e.kind || 'plugin', outcome: e.outcome || 'failed', details: e.details });
  } finally {
    if (job.mutating) { try { figma.commitUndo(); } catch (e) {} }
    Object.keys(yieldWaiters).forEach(function (k) { if (yieldWaiters[k].job === ctx) finishYield(k, failure('cancelled', 'Request finished')); });
    var written = job.mutating ? ctx.touched : [], read = ctx.targetPage || null;
    activeJobs.splice(activeJobs.indexOf(ctx), 1);
    current = null; fontCache = Object.create(null);
    figma.ui.postMessage(tag({ type: 'busy', session: msg.session, busy: false, id: msg.id, queued: c.waiting.length, queuedBytes: queuedBytes }));
    job.msg = null; msg = null; status();
    // Between jobs, never inside one: a sketch reads only top-level bounds.
    try { sketchAfter(written, read); } catch (e) {}
    written = null; read = null;
    passTurn();
  }
}
function channelName(msg) { return typeof msg.highway === 'string' && /^hw-[\w-]{1,124}$/.test(msg.highway) ? msg.highway : 'main'; }
function enqueue(msg) {
  try {
    var name = channelName(msg);
    if (name !== 'main' && !highwaySessions[name]) throw failure('stale-session', 'This highway is not open in this plugin', 'not-started');
    if (msg.lease) {
      validateLease(msg.lease, name);
      if (msg.type !== 'cmd' || msg.cmd.op !== 'create' || msg.cmd.parent !== msg.lease.pageId || msg.cmd.select !== false || msg.cmd.zoom !== false || usedLeases[msg.lease.leaseId]) throw failure('invalid-lease', 'Invalid or replayed zone command', 'not-started');
      if (Object.keys(usedLeases).length >= 512) throw failure('lease-capacity', 'Restart a settled plugin before accepting additional leases', 'not-started');
      usedLeases[msg.lease.leaseId] = msg.lease.token;
    }
    if (typeof msg.id !== 'string' || !msg.id || msg.id.length > 128) throw failure('invalid-request', 'Request id must be a short string', 'not-started');
    var c = channels[name] || (channels[name] = { id: name, waiting: [], running: null });
    if (activeJobs.some(function (j) { return j.id === msg.id; }) || Object.keys(channels).some(function (n) { return channels[n].waiting.some(function (j) { return j.msg.id === msg.id; }); })) throw failure('invalid-request', 'Duplicate request id', 'not-started');
    var bytes = byteLength(JSON.stringify(msg));
    if (bytes > LIMITS.messageBytes || queuedBytes + bytes > LIMITS.queueBytes || c.waiting.length + (c.running ? 1 : 0) >= LIMITS.queueJobs) throw failure('queue-full', 'Plugin capacity exceeded', 'not-started');
    var list = msg.type === 'cmd' ? [msg.cmd] : msg.cmds;
    if (!Array.isArray(list) || !list.length || list.length > LIMITS.batchItems) throw failure('invalid-request', 'Batch must contain 1..128 commands', 'not-started');
    if (msg.type === 'cmd-batch' && list.some(function (c) { return c && (c.trackHistory || ['undo', 'redo', 'reload'].indexOf(c.op) !== -1); })) {
      throw failure('invalid-request', 'History/lifecycle commands must be standalone', 'not-started');
    }
    var work = 0, mutating = false;
    for (var i = 0; i < list.length; i++) { work += validateCommand(list[i]); mutating = mutating || mutatesArtwork(list[i]); }
    if (work > LIMITS.specNodes) throw failure('limit-exceeded', 'Batch node budget exceeded', 'not-started');
    c.waiting.push({ msg: msg, bytes: bytes, work: work, mutating: mutating, enqueuedAt: Date.now() }); queuedBytes += bytes; status();
    // No payload captured in an unbounded promise chain; cancellation splices the queue.
    Promise.resolve().then(function () { startChannel(name); }).catch(function (e) { console.error(e); });
  } catch (e) { reply(msg, { error: e.message, kind: e.kind || 'invalid-request', outcome: 'not-started' }); }
}
figma.ui.onmessage = async function (msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'coordinator-ready') {
    coordinatorSession = { sessionEpoch: msg.sessionEpoch, coordinatorEpoch: msg.coordinatorEpoch };
    if (!current) { try { sendSketch(figma.currentPage, true); } catch (e) {} }
    return;
  }
  // The control socket only needs its own channel settled; highways keep working.
  if (msg.type === 'identify') { figma.ui.postMessage(merge({ type: 'identity', deviceCredential: rememberedCredential, uiMode: uiMode, uiTheme: uiTheme, busy: !!channels.main.running || !!waiting.length }, identity())); status(); return; }
  if (msg.type === 'highway-session') {
    if (typeof msg.highwayId !== 'string' || !/^hw-[\w-]{1,124}$/.test(msg.highwayId) || typeof msg.sessionEpoch !== 'string' || msg.sessionEpoch.length > 128) return;
    highwaySessions[msg.highwayId] = msg.sessionEpoch;
    var known = Object.keys(highwaySessions); if (known.length > 32) delete highwaySessions[known[0]];
    return;
  }
  if (msg.type === 'highway-closed') { if (typeof msg.highwayId === 'string') delete highwaySessions[msg.highwayId]; return; }
  if (msg.type === 'remember-computer' || msg.type === 'forget-computer') {
    var pairingValue = msg.type === 'forget-computer' ? '' : msg.deviceCredential;
    if (typeof pairingValue !== 'string' || (pairingValue && !/^[a-f0-9]{64}$/.test(pairingValue))) return;
    rememberedCredential = pairingValue;
    uiStorageWrite = uiStorageWrite.then(function () { return figma.clientStorage.setAsync('ultimate-computer-pairing-v1', pairingValue); })
      .then(function () { figma.ui.postMessage({ type: 'pairing-saved', saved: true }); })
      .catch(function () { figma.ui.postMessage({ type: 'pairing-saved', saved: false }); });
    return;
  }
  if (msg.type === 'ui-theme') {
    if (UI_THEMES.indexOf(msg.theme) === -1) return;
    uiTheme = msg.theme;
    figma.ui.postMessage({ type: 'ui-theme', theme: uiTheme });
    var selectedTheme = uiTheme;
    uiStorageWrite = uiStorageWrite.then(function () { return figma.clientStorage.setAsync('ui-theme', selectedTheme); }).catch(function () {});
    return;
  }
  if (msg.type === 'ui-mode') {
    if (!Object.prototype.hasOwnProperty.call(UI_MODES, msg.mode)) return;
    // Presets keep the bottom edge in place when the window sits low, so the
    // stealth banner grows upward from its corner instead of off-screen.
    var previous = uiSize, size = UI_MODES[msg.mode];
    uiMode = msg.mode; resizeWindow(size[0], size[1], 0, lowerHalf() ? previous[1] - size[1] : 0);
    figma.ui.postMessage({ type: 'ui-mode', mode: uiMode });
    return;
  }
  if (msg.type === 'ui-resize') {
    if (uiMode === 'stealth' || ![msg.width, msg.height].every(isFinite)) return;
    var clamp = function (v, lo, hi) { return Math.max(lo, Math.min(hi, Math.round(v))); };
    var shift = function (v) { return isFinite(v) ? clamp(v, -4000, 4000) : 0; };
    resizeWindow(clamp(msg.width, UI_MIN[0], UI_MAX[0]), clamp(msg.height, UI_MIN[1], UI_MAX[1]), shift(msg.dx), shift(msg.dy));
    if (msg.mode !== 'stealth' && Object.prototype.hasOwnProperty.call(UI_MODES, msg.mode)) uiMode = msg.mode;
    return;
  }
  // The UI confirms first. Figma's own close button cannot be intercepted.
  if (msg.type === 'close-plugin') { if (typeof figma.closePlugin === 'function') figma.closePlugin(); return; }
  if (msg.type === 'yielded') { finishYield(msg.k); return; }
  if (msg.type === 'yield-timeout') { var stuck = yieldWaiters[msg.k]; if (stuck) cancelCommands(stuck.job ? stuck.job.id : '*', 'UI yield acknowledgement timed out', 'yield-timeout'); return; }
  if (msg.type === 'cancel') { cancelCommands(msg.id == null ? '*' : msg.id, msg.reason || 'daemon', undefined, typeof msg.channel === 'string' ? msg.channel : undefined); return; }
  if (msg.type === 'cmd' && isImmediate(msg.cmd)) {
    try { reply(msg, { result: await runCommand(msg.cmd) }); }
    catch (e) { reply(msg, { error: e.message, kind: e.kind || 'plugin', outcome: e.outcome || 'failed' }); }
    return;
  }
  if (msg.type === 'cmd' || msg.type === 'cmd-batch') { enqueue(msg); return; }
  if (msg.type === 'eval' || msg.type === 'eval-batch') reply(msg, { error: 'Use structured commands; this plugin cannot execute eval', kind: 'unsupported', outcome: 'not-started' });
};
try { if (typeof figma.on === 'function') figma.on('currentpagechange', function () {
  historyCandidate = null; status();
  if (!current) { try { sendSketch(figma.currentPage, false); } catch (e) {} }
}); } catch (e) {}
console.log('figma-cli-ultimate bridge started — ' + VERSION + ' protocol ' + PROTOCOL);
openConsole();
