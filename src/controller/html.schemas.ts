import { B_FORM, B_SCALE, B_TARGET, B_TRIGGER, SCALE } from './controller.constants.ts'

// ── Internal helper schemas (not exported) ────────────────────────────────

/**
 * Booleanish — `boolean | 'true' | 'false'`.
 * @internal
 */
const BooleanishSchema = { anyOf: [{ type: 'boolean' }, { type: 'string', enum: ['true', 'false'] }] }

/**
 * Cross-origin attribute value.
 * @internal
 */
const CrossOriginSchema = { type: 'string', enum: ['anonymous', 'use-credentials', ''] }

/**
 * Anchor target attribute values.
 * @internal
 */
const AnchorTargetSchema = { type: 'string', enum: ['_self', '_blank', '_parent', '_top'] }

/**
 * Referrer policy attribute values.
 * @internal
 */
const ReferrerPolicySchema = {
  type: 'string',
  enum: [
    '',
    'no-referrer',
    'no-referrer-when-downgrade',
    'origin',
    'origin-when-cross-origin',
    'same-origin',
    'strict-origin',
    'strict-origin-when-cross-origin',
    'unsafe-url',
  ],
}

/**
 * Input `type` attribute values.
 * @internal
 */
const InputTypeSchema = {
  type: 'string',
  enum: [
    'button',
    'checkbox',
    'color',
    'date',
    'datetime-local',
    'email',
    'file',
    'hidden',
    'image',
    'month',
    'number',
    'password',
    'radio',
    'range',
    'reset',
    'search',
    'submit',
    'tel',
    'text',
    'time',
    'url',
    'week',
  ],
}

// ── ARIA ───────────────────────────────────────────────────────────────────

const AriaAttributesSchema = {
  type: 'object',
  properties: {
    'aria-activedescendant': { type: 'string' },
    'aria-atomic': BooleanishSchema,
    'aria-autocomplete': { type: 'string', enum: ['none', 'inline', 'list', 'both'] },
    'aria-braillelabel': { type: 'string' },
    'aria-brailleroledescription': { type: 'string' },
    'aria-busy': BooleanishSchema,
    'aria-checked': {
      anyOf: [{ type: 'boolean' }, { type: 'string', enum: ['false', 'mixed', 'true'] }],
    },
    'aria-colcount': { type: 'number' },
    'aria-colindex': { type: 'number' },
    'aria-colindextext': { type: 'string' },
    'aria-colspan': { type: 'number' },
    'aria-controls': { type: 'string' },
    'aria-current': {
      anyOf: [
        { type: 'boolean' },
        { type: 'string', enum: ['false', 'true', 'page', 'step', 'location', 'date', 'time'] },
      ],
    },
    'aria-describedby': { type: 'string' },
    'aria-description': { type: 'string' },
    'aria-details': { type: 'string' },
    'aria-disabled': BooleanishSchema,
    'aria-errormessage': { type: 'string' },
    'aria-expanded': BooleanishSchema,
    'aria-flowto': { type: 'string' },
    'aria-haspopup': {
      anyOf: [
        { type: 'boolean' },
        { type: 'string', enum: ['false', 'true', 'menu', 'listbox', 'tree', 'grid', 'dialog'] },
      ],
    },
    'aria-hidden': BooleanishSchema,
    'aria-invalid': {
      anyOf: [{ type: 'boolean' }, { type: 'string', enum: ['false', 'true', 'grammar', 'spelling'] }],
    },
    'aria-keyshortcuts': { type: 'string' },
    'aria-label': { type: 'string' },
    'aria-labelledby': { type: 'string' },
    'aria-level': { type: 'number' },
    'aria-live': { type: 'string', enum: ['off', 'assertive', 'polite'] },
    'aria-modal': BooleanishSchema,
    'aria-multiline': BooleanishSchema,
    'aria-multiselectable': BooleanishSchema,
    'aria-orientation': { type: 'string', enum: ['horizontal', 'vertical'] },
    'aria-owns': { type: 'string' },
    'aria-placeholder': { type: 'string' },
    'aria-posinset': { type: 'number' },
    'aria-pressed': {
      anyOf: [{ type: 'boolean' }, { type: 'string', enum: ['false', 'mixed', 'true'] }],
    },
    'aria-readonly': BooleanishSchema,
    'aria-relevant': {
      type: 'string',
      enum: [
        'additions',
        'additions removals',
        'additions text',
        'all',
        'removals',
        'removals additions',
        'removals text',
        'text',
        'text additions',
        'text removals',
      ],
    },
    'aria-required': BooleanishSchema,
    'aria-roledescription': { type: 'string' },
    'aria-rowcount': { type: 'number' },
    'aria-rowindex': { type: 'number' },
    'aria-rowindextext': { type: 'string' },
    'aria-rowspan': { type: 'number' },
    'aria-selected': BooleanishSchema,
    'aria-setsize': { type: 'number' },
    'aria-sort': { type: 'string', enum: ['none', 'ascending', 'descending', 'other'] },
    'aria-valuemax': { type: 'number' },
    'aria-valuemin': { type: 'number' },
    'aria-valuenow': { type: 'number' },
    'aria-valuetext': { type: 'string' },
  },
}

const AriaRoleSchema = {
  type: 'string',
  enum: [
    'alert',
    'alertdialog',
    'application',
    'article',
    'banner',
    'button',
    'cell',
    'checkbox',
    'columnheader',
    'combobox',
    'complementary',
    'contentinfo',
    'definition',
    'dialog',
    'directory',
    'document',
    'feed',
    'figure',
    'form',
    'grid',
    'gridcell',
    'group',
    'heading',
    'img',
    'link',
    'list',
    'listbox',
    'listitem',
    'log',
    'main',
    'marquee',
    'math',
    'menu',
    'menubar',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'navigation',
    'none',
    'note',
    'option',
    'presentation',
    'progressbar',
    'radio',
    'radiogroup',
    'region',
    'row',
    'rowgroup',
    'rowheader',
    'scrollbar',
    'search',
    'searchbox',
    'separator',
    'slider',
    'spinbutton',
    'status',
    'switch',
    'tab',
    'table',
    'tablist',
    'tabpanel',
    'term',
    'textbox',
    'timer',
    'toolbar',
    'tooltip',
    'tree',
    'treegrid',
    'treeitem',
  ],
}

// ── Behavioral attributes ────────────────────────────────────────────────────

export const BehavioralAttributesSchema = {
  type: 'object',
  properties: {
    class: { type: 'string' },
    [B_SCALE]: { type: 'string', enum: Object.values(SCALE) },
    [B_TARGET]: { anyOf: [{ type: 'string' }, { type: 'number' }] },
    [B_TRIGGER]: { type: 'string', pTriggerFormat: true },
    style: { type: 'string', pStyleFormat: true },
  },
}

// ── Detailed HTML attributes ──────────────────────────────────────────────

/**
 * Standard HTML attributes combined with ARIA and behavioral attributes.
 * @public
 */
export const DetailedHTMLAttributesSchema = {
  type: 'object',
  properties: {
    ...BehavioralAttributesSchema.properties,
    ...AriaAttributesSchema.properties,
    // Standard HTML Attributes
    accesskey: { type: 'string' },
    autofocus: { type: 'boolean' },
    contenteditable: {
      anyOf: [BooleanishSchema, { type: 'string', enum: ['inherit', 'plaintext-only'] }],
    },
    dir: { type: 'string' },
    draggable: BooleanishSchema,
    hidden: { type: 'boolean' },
    id: { anyOf: [{ type: 'string' }, { type: 'number' }] },
    lang: { type: 'string' },
    nonce: { type: 'string' },
    placeholder: { type: 'string' },
    slot: { type: 'string' },
    spellcheck: BooleanishSchema,
    tabindex: { type: 'number' },
    title: { type: 'string' },
    translate: { type: 'string', enum: ['yes', 'no'] },

    // WAI-ARIA
    role: AriaRoleSchema,

    // RDFa Attributes
    about: { type: 'string' },
    content: { type: 'string' },
    datatype: { type: 'string' },
    prefix: { type: 'string' },
    property: { type: 'string' },
    rel: { type: 'string' },
    resource: { type: 'string' },
    rev: { type: 'string' },
    typeof: { type: 'string' },
    vocab: { type: 'string' },

    // Non-standard Attributes
    autocapitalize: { type: 'string', enum: ['off', 'none', 'on', 'sentences', 'words', 'characters'] },
    autocorrect: { type: 'string', enum: ['on', 'off'] },
    autosave: { type: 'string' },
    itemprop: { type: 'string' },
    itemscope: { type: 'boolean' },
    itemtype: { type: 'string' },
    itemid: { type: 'string' },
    itemref: { type: 'string' },
    results: { type: 'number' },
    security: { type: 'string' },

    // Standard HTML attributes not covered above
    for: { type: 'string' },

    // Living Standard
    inputmode: {
      type: 'string',
      enum: ['none', 'text', 'tel', 'url', 'email', 'numeric', 'decimal', 'search'],
    },
    is: { type: 'string' },
  },
  // catchall(z.union([z.string(), z.number(), z.boolean()]))
  additionalProperties: { type: ['string', 'number', 'boolean'] },
}

// ── Element-specific attribute schemas ─────────────────────────────────────
// Each extends DetailedHTMLAttributesSchema with tag-specific attributes.

const DetailedAnchorHTMLAttributesSchema = {
  type: 'object',
  properties: {
    ...DetailedHTMLAttributesSchema.properties,
    download: { type: 'boolean' },
    href: { type: 'string' },
    hreflang: { type: 'string' },
    media: { type: 'string' },
    ping: { type: 'string' },
    target: AnchorTargetSchema,
    type: { type: 'string' },
    referrerpolicy: ReferrerPolicySchema,
  },
}

const DetailedAreaHTMLAttributesSchema = {
  type: 'object',
  properties: {
    ...DetailedHTMLAttributesSchema.properties,
    alt: { type: 'string' },
    coords: { type: 'string' },
    download: { type: 'boolean' },
    href: { type: 'string' },
    hreflang: { type: 'string' },
    media: { type: 'string' },
    referrerpolicy: ReferrerPolicySchema,
    shape: { type: 'string' },
    target: { type: 'string' },
  },
}

const DetailedBaseHTMLAttributesSchema = {
  type: 'object',
  properties: {
    ...DetailedHTMLAttributesSchema.properties,
    href: { type: 'string' },
    target: { type: 'string' },
  },
}

const DetailedBlockquoteHTMLAttributesSchema = {
  type: 'object',
  properties: {
    ...DetailedHTMLAttributesSchema.properties,
    cite: { type: 'string' },
  },
}

const DetailedButtonHTMLAttributesSchema = {
  type: 'object',
  properties: {
    ...DetailedHTMLAttributesSchema.properties,
    disabled: { type: 'boolean' },
    form: { type: 'string' },
    formaction: { type: 'string' },
    formenctype: { type: 'string' },
    formmethod: { type: 'string' },
    formnovalidate: { type: 'boolean' },
    formtarget: { type: 'string' },
    name: { type: 'string' },
    type: { type: 'string', enum: ['submit', 'reset', 'button'] },
    value: { anyOf: [{ type: 'string' }, { type: 'number' }] },
  },
}

const DetailedCanvasHTMLAttributesSchema = {
  type: 'object',
  properties: {
    ...DetailedHTMLAttributesSchema.properties,
    height: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    width: { anyOf: [{ type: 'number' }, { type: 'string' }] },
  },
}

const DetailedColHTMLAttributesSchema = {
  type: 'object',
  properties: {
    ...DetailedHTMLAttributesSchema.properties,
    span: { type: 'number' },
    width: { anyOf: [{ type: 'number' }, { type: 'string' }] },
  },
}

const DetailedColgroupHTMLAttributesSchema = {
  type: 'object',
  properties: {
    ...DetailedHTMLAttributesSchema.properties,
    span: { type: 'number' },
  },
}

const DetailedDataHTMLAttributesSchema = {
  type: 'object',
  properties: {
    ...DetailedHTMLAttributesSchema.properties,
    value: { anyOf: [{ type: 'string' }, { type: 'number' }] },
  },
}

const DetailedDetailsHTMLAttributesSchema = {
  type: 'object',
  properties: {
    ...DetailedHTMLAttributesSchema.properties,
    open: { type: 'boolean' },
  },
}

const DetailedDelHTMLAttributesSchema = {
  type: 'object',
  properties: {
    ...DetailedHTMLAttributesSchema.properties,
    cite: { type: 'string' },
    datetime: { type: 'string' },
  },
}

const DetailedDialogHTMLAttributesSchema = {
  type: 'object',
  properties: {
    ...DetailedHTMLAttributesSchema.properties,
    open: { type: 'boolean' },
  },
}

const DetailedEmbedHTMLAttributesSchema = {
  type: 'object',
  properties: {
    ...DetailedHTMLAttributesSchema.properties,
    height: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    src: { type: 'string' },
    type: { type: 'string' },
    width: { anyOf: [{ type: 'number' }, { type: 'string' }] },
  },
}

const DetailedFieldsetHTMLAttributesSchema = {
  type: 'object',
  properties: {
    ...DetailedHTMLAttributesSchema.properties,
    disabled: { type: 'boolean' },
    form: { type: 'string' },
    name: { type: 'string' },
  },
}

const DetailedFormHTMLAttributesSchema = {
  type: 'object',
  properties: {
    ...DetailedHTMLAttributesSchema.properties,
    'accept-charset': { type: 'string' },
    action: { not: {} },
    autocomplete: { type: 'string' },
    enctype: { type: 'string' },
    method: { type: 'string' },
    name: { type: 'string' },
    novalidate: { type: 'boolean' },
    target: { type: 'string' },
    [B_TRIGGER]: { not: {} },
    [B_FORM]: { type: 'string' },
  },
  required: [B_FORM],
}

const DetailedHtmlHTMLAttributesSchema = {
  type: 'object',
  properties: {
    ...DetailedHTMLAttributesSchema.properties,
    manifest: { type: 'string' },
  },
}

const DetailedIframeHTMLAttributesSchema = {
  type: 'object',
  properties: {
    ...DetailedHTMLAttributesSchema.properties,
    allow: { type: 'string' },
    height: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    loading: { type: 'string', enum: ['eager', 'lazy'] },
    name: { type: 'string' },
    referrerpolicy: ReferrerPolicySchema,
    sandbox: { type: 'string' },
    seamless: { type: 'boolean' },
    src: { type: 'string' },
    srcdoc: { type: 'string' },
    width: { anyOf: [{ type: 'number' }, { type: 'string' }] },
  },
}

const DetailedImgHTMLAttributesSchema = {
  type: 'object',
  properties: {
    ...DetailedHTMLAttributesSchema.properties,
    alt: { type: 'string' },
    crossorigin: CrossOriginSchema,
    decoding: { type: 'string', enum: ['async', 'auto', 'sync'] },
    height: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    loading: { type: 'string', enum: ['eager', 'lazy'] },
    referrerpolicy: ReferrerPolicySchema,
    sizes: { type: 'string' },
    src: { type: 'string' },
    srcset: { type: 'string' },
    usemap: { type: 'string' },
    width: { anyOf: [{ type: 'number' }, { type: 'string' }] },
  },
}

const DetailedInputHTMLAttributesSchema = {
  type: 'object',
  properties: {
    ...DetailedHTMLAttributesSchema.properties,
    accept: { type: 'string' },
    alt: { type: 'string' },
    autocomplete: { type: 'string' },
    capture: { anyOf: [{ type: 'boolean' }, { type: 'string', enum: ['user', 'environment'] }] },
    checked: { type: 'boolean' },
    disabled: { type: 'boolean' },
    enterkeyhint: { type: 'string', enum: ['enter', 'done', 'go', 'next', 'previous', 'search', 'send'] },
    form: { type: 'string' },
    formaction: { type: 'string' },
    formenctype: { type: 'string' },
    formmethod: { type: 'string' },
    formnovalidate: { type: 'boolean' },
    formtarget: { type: 'string' },
    height: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    list: { type: 'string' },
    max: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    maxlength: { type: 'number' },
    min: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    minlength: { type: 'number' },
    multiple: { type: 'boolean' },
    name: { type: 'string' },
    pattern: { type: 'string' },
    placeholder: { type: 'string' },
    readonly: { type: 'boolean' },
    required: { type: 'boolean' },
    size: { type: 'number' },
    src: { type: 'string' },
    step: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    type: InputTypeSchema,
    value: { anyOf: [{ type: 'string' }, { type: 'number' }] },
    width: { anyOf: [{ type: 'number' }, { type: 'string' }] },
  },
}

const DetailedInsHTMLAttributesSchema = {
  type: 'object',
  properties: {
    ...DetailedHTMLAttributesSchema.properties,
    cite: { type: 'string' },
    datetime: { type: 'string' },
  },
}

const DetailedLabelHTMLAttributesSchema = {
  type: 'object',
  properties: {
    ...DetailedHTMLAttributesSchema.properties,
    form: { type: 'string' },
    for: { type: 'string' },
  },
}

const DetailedLiHTMLAttributesSchema = {
  type: 'object',
  properties: {
    ...DetailedHTMLAttributesSchema.properties,
    value: { anyOf: [{ type: 'string' }, { type: 'number' }] },
  },
}

const DetailedLinkHTMLAttributesSchema = {
  type: 'object',
  properties: {
    ...DetailedHTMLAttributesSchema.properties,
    as: { type: 'string' },
    crossorigin: CrossOriginSchema,
    fetchPriority: { type: 'string', enum: ['high', 'low', 'auto'] },
    href: { type: 'string' },
    hreflang: { type: 'string' },
    integrity: { type: 'string' },
    media: { type: 'string' },
    imagesrcset: { type: 'string' },
    imagesizes: { type: 'string' },
    referrerpolicy: ReferrerPolicySchema,
    sizes: { type: 'string' },
    type: { type: 'string' },
    charSet: { type: 'string' },
  },
}

const DetailedMapHTMLAttributesSchema = {
  type: 'object',
  properties: {
    ...DetailedHTMLAttributesSchema.properties,
    name: { type: 'string' },
  },
}

const DetailedMenuHTMLAttributesSchema = {
  type: 'object',
  properties: {
    ...DetailedHTMLAttributesSchema.properties,
    type: { type: 'string' },
  },
}

const DetailedMetaHTMLAttributesSchema = {
  type: 'object',
  properties: {
    ...DetailedHTMLAttributesSchema.properties,
    charset: { type: 'string' },
    'http-equiv': { type: 'string' },
    name: { type: 'string' },
    media: { type: 'string' },
    content: { type: 'string' },
  },
}

const DetailedMeterHTMLAttributesSchema = {
  type: 'object',
  properties: {
    ...DetailedHTMLAttributesSchema.properties,
    form: { type: 'string' },
    high: { type: 'number' },
    low: { type: 'number' },
    max: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    min: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    optimum: { type: 'number' },
    value: { anyOf: [{ type: 'string' }, { type: 'number' }] },
  },
}

const DetailedObjectHTMLAttributesSchema = {
  type: 'object',
  properties: {
    ...DetailedHTMLAttributesSchema.properties,
    classid: { type: 'string' },
    data: { type: 'string' },
    form: { type: 'string' },
    height: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    name: { type: 'string' },
    type: { type: 'string' },
    usemap: { type: 'string' },
    width: { anyOf: [{ type: 'number' }, { type: 'string' }] },
  },
}

const DetailedOlHTMLAttributesSchema = {
  type: 'object',
  properties: {
    ...DetailedHTMLAttributesSchema.properties,
    reversed: { type: 'boolean' },
    start: { type: 'number' },
    type: { type: 'string', enum: ['1', 'a', 'A', 'i', 'I'] },
  },
}

const DetailedOptgroupHTMLAttributesSchema = {
  type: 'object',
  properties: {
    ...DetailedHTMLAttributesSchema.properties,
    disabled: { type: 'boolean' },
    label: { type: 'string' },
  },
}

const DetailedOptionHTMLAttributesSchema = {
  type: 'object',
  properties: {
    ...DetailedHTMLAttributesSchema.properties,
    disabled: { type: 'boolean' },
    label: { type: 'string' },
    selected: { type: 'boolean' },
    value: { anyOf: [{ type: 'string' }, { type: 'number' }] },
  },
}

const DetailedOutputHTMLAttributesSchema = {
  type: 'object',
  properties: {
    ...DetailedHTMLAttributesSchema.properties,
    form: { type: 'string' },
    for: { type: 'string' },
    name: { type: 'string' },
  },
}

const DetailedProgressHTMLAttributesSchema = {
  type: 'object',
  properties: {
    ...DetailedHTMLAttributesSchema.properties,
    max: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    value: { anyOf: [{ type: 'string' }, { type: 'number' }] },
  },
}

const DetailedQuoteHTMLAttributesSchema = {
  type: 'object',
  properties: {
    ...DetailedHTMLAttributesSchema.properties,
    cite: { type: 'string' },
  },
}

const DetailedSlotHTMLAttributesSchema = {
  type: 'object',
  properties: {
    ...DetailedHTMLAttributesSchema.properties,
    name: { type: 'string' },
  },
}

const DetailedScriptHTMLAttributesSchema = {
  type: 'object',
  properties: {
    ...DetailedHTMLAttributesSchema.properties,
    async: { type: 'boolean' },
    crossorigin: CrossOriginSchema,
    defer: { type: 'boolean' },
    integrity: { type: 'string' },
    nomodule: { type: 'boolean' },
    referrerpolicy: ReferrerPolicySchema,
    src: { type: 'string' },
    type: { type: 'string' },
  },
}

const DetailedSelectHTMLAttributesSchema = {
  type: 'object',
  properties: {
    ...DetailedHTMLAttributesSchema.properties,
    autocomplete: { type: 'string' },
    disabled: { type: 'boolean' },
    form: { type: 'string' },
    multiple: { type: 'boolean' },
    name: { type: 'string' },
    required: { type: 'boolean' },
    size: { type: 'number' },
    value: { anyOf: [{ type: 'string' }, { type: 'number' }] },
  },
}

const DetailedSourceHTMLAttributesSchema = {
  type: 'object',
  properties: {
    ...DetailedHTMLAttributesSchema.properties,
    height: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    media: { type: 'string' },
    sizes: { type: 'string' },
    src: { type: 'string' },
    srcset: { type: 'string' },
    type: { type: 'string' },
    width: { anyOf: [{ type: 'number' }, { type: 'string' }] },
  },
}

const DetailedStyleHTMLAttributesSchema = {
  type: 'object',
  properties: {
    ...DetailedHTMLAttributesSchema.properties,
    media: { type: 'string' },
  },
}

const DetailedTableHTMLAttributesSchema = {
  type: 'object',
  properties: {
    ...DetailedHTMLAttributesSchema.properties,
    align: { type: 'string', enum: ['left', 'center', 'right'] },
    bgcolor: { type: 'string' },
    border: { type: 'number' },
    cellpadding: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    cellspacing: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    frame: { type: 'boolean' },
    rules: { type: 'string', enum: ['none', 'groups', 'rows', 'columns', 'all'] },
    summary: { type: 'string' },
    width: { anyOf: [{ type: 'number' }, { type: 'string' }] },
  },
}

const DetailedTemplateHTMLAttributesSchema = {
  type: 'object',
  properties: {
    ...DetailedHTMLAttributesSchema.properties,
    shadowrootmode: { type: 'string', enum: ['open', 'closed'] },
    shadowrootdelegatesfocus: { type: 'boolean' },
    shadowrootclonable: { type: 'boolean' },
  },
}

const DetailedTextareaHTMLAttributesSchema = {
  type: 'object',
  properties: {
    ...DetailedHTMLAttributesSchema.properties,
    autocomplete: { type: 'string' },
    cols: { type: 'number' },
    dirname: { type: 'string' },
    disabled: { type: 'boolean' },
    form: { type: 'string' },
    maxlength: { type: 'number' },
    minlength: { type: 'number' },
    name: { type: 'string' },
    placeholder: { type: 'string' },
    readonly: { type: 'boolean' },
    required: { type: 'boolean' },
    rows: { type: 'number' },
    value: { anyOf: [{ type: 'string' }, { type: 'number' }] },
    wrap: { type: 'string' },
  },
}

const DetailedTdHTMLAttributesSchema = {
  type: 'object',
  properties: {
    ...DetailedHTMLAttributesSchema.properties,
    align: { type: 'string', enum: ['left', 'center', 'right', 'justify', 'char'] },
    colspan: { type: 'number' },
    headers: { type: 'string' },
    rowspan: { type: 'number' },
    scope: { type: 'string' },
    abbr: { type: 'string' },
    height: { type: 'string' },
    width: { type: 'string' },
    valign: { type: 'string', enum: ['top', 'middle', 'bottom', 'baseline'] },
  },
}

const DetailedThHTMLAttributesSchema = {
  type: 'object',
  properties: {
    ...DetailedHTMLAttributesSchema.properties,
    align: { type: 'string', enum: ['left', 'center', 'right', 'justify', 'char'] },
    colspan: { type: 'number' },
    headers: { type: 'string' },
    rowspan: { type: 'number' },
    scope: { type: 'string' },
    abbr: { type: 'string' },
  },
}

const DetailedTimeHTMLAttributesSchema = {
  type: 'object',
  properties: {
    ...DetailedHTMLAttributesSchema.properties,
    datetime: { type: 'string' },
  },
}

const DetailedTrackHTMLAttributesSchema = {
  type: 'object',
  properties: {
    ...DetailedHTMLAttributesSchema.properties,
    default: { type: 'boolean' },
    kind: { type: 'string', enum: ['subtitles', 'captions', 'descriptions', 'chapters', 'metadata'] },
    label: { type: 'string' },
    src: { type: 'string' },
    srclang: { type: 'string' },
  },
}

// Media-based elements

const DetailedAudioHTMLAttributesSchema = {
  type: 'object',
  properties: {
    ...DetailedHTMLAttributesSchema.properties,
    autoplay: { type: 'boolean' },
    controls: { type: 'boolean' },
    controlslist: { type: 'string' },
    crossorigin: CrossOriginSchema,
    loop: { type: 'boolean' },
    mediagroup: { type: 'string' },
    muted: { type: 'boolean' },
    playsinline: { type: 'boolean' },
    preload: { type: 'string' },
    src: { type: 'string' },
  },
}

const DetailedVideoHTMLAttributesSchema = {
  type: 'object',
  properties: {
    ...DetailedAudioHTMLAttributesSchema.properties,
    height: { type: 'string' },
    playsinline: { type: 'boolean' },
    poster: { type: 'string' },
    width: { type: 'string' },
    disablepictureinpicture: { type: 'boolean' },
    disableremoteplayback: { type: 'boolean' },
  },
}

// ── SVG Attributes ─────────────────────────────────────────────────────────

const DetailedSVGAttributesSchema = {
  type: 'object',
  properties: {
    ...DetailedHTMLAttributesSchema.properties,
    'accent-height': { type: 'number' },
    // z.union([z.enum([...]), z.string()]) — the string branch accepts any
    // string, making the enum redundant. Simplified to { type: 'string' }.
    accumulate: { type: 'string' },
    additive: { type: 'string' },
    'alignment-baseline': { type: 'string' },
    allowReorder: { type: 'string' },
    amplitude: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    attributeName: { type: 'string' },
    attributeType: { type: 'string' },
    autoReverse: BooleanishSchema,
    azimuth: { type: 'number' },
    baseFrequency: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    'baseline-shift': { anyOf: [{ type: 'number' }, { type: 'string' }] },
    baseProfile: { type: 'string' },
    begin: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    bias: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    by: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    calcMode: { type: 'string' },
    'clip-path': { type: 'string' },
    'clip-rule': { type: 'string' },
    clipPathUnits: { type: 'string' },
    color: { type: 'string' },
    'color-interpolation': { type: 'string' },
    'color-interpolation-filters': { type: 'string' },
    'color-rendering': { anyOf: [{ type: 'number' }, { type: 'string' }] },
    contentScriptType: { type: 'string' },
    contentStyleType: { type: 'string' },
    cursor: { type: 'string' },
    cx: { type: 'string' },
    cy: { type: 'string' },
    d: { type: 'string' },
    decoding: { type: 'string' },
    diffuseConstant: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    direction: { type: 'string' },
    display: { type: 'string' },
    divisor: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    'dominant-baseline': { type: 'string' },
    dur: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    dx: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    dy: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    edgeMode: { type: 'string' },
    elevation: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    end: { type: 'string' },
    exponent: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    fill: { type: 'string' },
    'fill-opacity': { anyOf: [{ type: 'number' }, { type: 'string' }] },
    'fill-rule': { type: 'string' },
    filter: { type: 'string' },
    filterRes: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    filterUnits: { type: 'string' },
    'flood-color': { type: 'string' },
    'flood-opacity': { anyOf: [{ type: 'number' }, { type: 'string' }] },
    focusable: { anyOf: [BooleanishSchema, { type: 'string', enum: ['auto'] }] },
    'font-family': { type: 'string' },
    'font-size': { type: 'string' },
    'font-size-adjust': { type: 'string' },
    'font-stretch': { type: 'string' },
    'font-style': { type: 'string' },
    'font-variant': { type: 'string' },
    'font-weight': { type: 'string' },
    fr: { type: 'string' },
    from: { type: 'string' },
    fx: { type: 'string' },
    fy: { type: 'string' },
    gradientTransform: { type: 'string' },
    gradientUnits: { type: 'string' },
    href: { type: 'string' },
    'image-rendering': { type: 'string' },
    in: { type: 'string' },
    in2: { type: 'string' },
    intercept: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    k1: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    k2: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    k3: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    k4: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    kernelMatrix: { type: 'string' },
    kernelUnitLength: { type: 'string' },
    keyPoints: { type: 'string' },
    keySplines: { type: 'string' },
    keyTimes: { type: 'string' },
    lengthAdjust: { type: 'string' },
    'letter-spacing': { anyOf: [{ type: 'number' }, { type: 'string' }] },
    'lighting-color': { type: 'string' },
    limitingConeAngle: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    'marker-end': { type: 'string' },
    'marker-mid': { type: 'string' },
    'marker-start': { type: 'string' },
    markerHeight: { anyOf: [{ type: 'string' }, { type: 'number' }] },
    markerUnits: { type: 'string' },
    markerWidth: { anyOf: [{ type: 'string' }, { type: 'number' }] },
    mask: { type: 'string' },
    maskContentUnits: { type: 'string' },
    maskUnits: { type: 'string' },
    method: { type: 'string', enum: ['align', 'stretch'] },
    mode: { type: 'string' },
    numOctaves: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    offset: { type: 'string' },
    opacity: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    operator: { type: 'string' },
    order: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    orient: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    origin: { type: 'string' },
    overflow: { type: 'string' },
    'overline-position': { anyOf: [{ type: 'number' }, { type: 'string' }] },
    'overline-thickness': { anyOf: [{ type: 'number' }, { type: 'string' }] },
    'paint-order': { type: 'string' },
    path: { type: 'string' },
    pathLength: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    patternContentUnits: { type: 'string' },
    patternTransform: { type: 'string' },
    patternUnits: { type: 'string' },
    'pointer-events': { type: 'string' },
    points: { type: 'string' },
    pointsAtX: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    pointsAtY: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    pointsAtZ: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    preserveAlpha: { type: 'string', enum: ['true', 'false'] },
    preserveAspectRatio: { type: 'string' },
    primitiveUnits: { type: 'string' },
    r: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    radius: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    refX: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    refY: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    repeatCount: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    repeatDur: { type: 'string' },
    restart: { type: 'string' },
    result: { type: 'string' },
    rotate: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    rx: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    ry: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    scale: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    seed: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    'shape-rendering': { type: 'string' },
    spacing: { type: 'string', enum: ['auto', 'exact'] },
    specularConstant: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    specularExponent: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    spreadMethod: { type: 'string' },
    startOffset: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    stdDeviation: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    stitchTiles: { type: 'string' },
    'stop-color': { type: 'string' },
    'stop-opacity': { anyOf: [{ type: 'number' }, { type: 'string' }] },
    'strikethrough-position': { anyOf: [{ type: 'number' }, { type: 'string' }] },
    'strikethrough-thickness': { anyOf: [{ type: 'number' }, { type: 'string' }] },
    stroke: { type: 'string' },
    'stroke-dasharray': { type: 'string' },
    'stroke-dashoffset': { anyOf: [{ type: 'number' }, { type: 'string' }] },
    'stroke-linecap': { type: 'string' },
    'stroke-linejoin': { type: 'string' },
    'stroke-miterlimit': { anyOf: [{ type: 'number' }, { type: 'string' }] },
    'stroke-opacity': { anyOf: [{ type: 'number' }, { type: 'string' }] },
    'stroke-width': { anyOf: [{ type: 'number' }, { type: 'string' }] },
    surfaceScale: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    systemLanguage: { type: 'string' },
    tableValues: { type: 'string' },
    targetX: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    targetY: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    'text-anchor': { type: 'string' },
    'text-decoration': { type: 'string' },
    'text-rendering': { type: 'string' },
    textLength: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    to: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    transform: { type: 'string' },
    'transform-origin': { type: 'string' },
    'underline-position': { anyOf: [{ type: 'number' }, { type: 'string' }] },
    'underline-thickness': { anyOf: [{ type: 'number' }, { type: 'string' }] },
    values: { type: 'string' },
    'vector-effect': { type: 'string' },
    viewBox: { type: 'string' },
    visibility: { type: 'string' },
    'word-spacing': { anyOf: [{ type: 'number' }, { type: 'string' }] },
    'writing-mode': { type: 'string' },
    x: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    x1: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    x2: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    xChannelSelector: { type: 'string' },
    y: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    y1: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    y2: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    yChannelSelector: { type: 'string' },
    z: { anyOf: [{ type: 'number' }, { type: 'string' }] },
  },
}

// ── Element attribute list ────────────────────────────────────────────────

export const ElementAttributeListSchema = {
  type: 'object',
  properties: {
    a: DetailedAnchorHTMLAttributesSchema,
    abbr: DetailedHTMLAttributesSchema,
    address: DetailedHTMLAttributesSchema,
    area: DetailedAreaHTMLAttributesSchema,
    article: DetailedHTMLAttributesSchema,
    aside: DetailedHTMLAttributesSchema,
    audio: DetailedAudioHTMLAttributesSchema,
    b: DetailedHTMLAttributesSchema,
    base: DetailedBaseHTMLAttributesSchema,
    bdi: DetailedHTMLAttributesSchema,
    bdo: DetailedHTMLAttributesSchema,
    big: DetailedHTMLAttributesSchema,
    blockquote: DetailedBlockquoteHTMLAttributesSchema,
    body: DetailedHTMLAttributesSchema,
    br: DetailedHTMLAttributesSchema,
    button: DetailedButtonHTMLAttributesSchema,
    canvas: DetailedCanvasHTMLAttributesSchema,
    caption: DetailedHTMLAttributesSchema,
    cite: DetailedHTMLAttributesSchema,
    code: DetailedHTMLAttributesSchema,
    col: DetailedColHTMLAttributesSchema,
    colgroup: DetailedColgroupHTMLAttributesSchema,
    data: DetailedDataHTMLAttributesSchema,
    datalist: DetailedHTMLAttributesSchema,
    dd: DetailedHTMLAttributesSchema,
    del: DetailedDelHTMLAttributesSchema,
    details: DetailedDetailsHTMLAttributesSchema,
    dfn: DetailedHTMLAttributesSchema,
    dialog: DetailedDialogHTMLAttributesSchema,
    div: DetailedHTMLAttributesSchema,
    dl: DetailedHTMLAttributesSchema,
    dt: DetailedHTMLAttributesSchema,
    em: DetailedHTMLAttributesSchema,
    embed: DetailedEmbedHTMLAttributesSchema,
    fieldset: DetailedFieldsetHTMLAttributesSchema,
    figcaption: DetailedHTMLAttributesSchema,
    figure: DetailedHTMLAttributesSchema,
    footer: DetailedHTMLAttributesSchema,
    form: DetailedFormHTMLAttributesSchema,
    h1: DetailedHTMLAttributesSchema,
    h2: DetailedHTMLAttributesSchema,
    h3: DetailedHTMLAttributesSchema,
    h4: DetailedHTMLAttributesSchema,
    h5: DetailedHTMLAttributesSchema,
    h6: DetailedHTMLAttributesSchema,
    head: DetailedHTMLAttributesSchema,
    header: DetailedHTMLAttributesSchema,
    hgroup: DetailedHTMLAttributesSchema,
    hr: DetailedHTMLAttributesSchema,
    html: DetailedHtmlHTMLAttributesSchema,
    i: DetailedHTMLAttributesSchema,
    iframe: DetailedIframeHTMLAttributesSchema,
    img: DetailedImgHTMLAttributesSchema,
    input: DetailedInputHTMLAttributesSchema,
    ins: DetailedInsHTMLAttributesSchema,
    kbd: DetailedHTMLAttributesSchema,
    label: DetailedLabelHTMLAttributesSchema,
    legend: DetailedHTMLAttributesSchema,
    li: DetailedLiHTMLAttributesSchema,
    link: DetailedLinkHTMLAttributesSchema,
    main: DetailedHTMLAttributesSchema,
    map: DetailedMapHTMLAttributesSchema,
    mark: DetailedHTMLAttributesSchema,
    menu: DetailedMenuHTMLAttributesSchema,
    menuitem: DetailedHTMLAttributesSchema,
    meta: DetailedMetaHTMLAttributesSchema,
    meter: DetailedMeterHTMLAttributesSchema,
    nav: DetailedHTMLAttributesSchema,
    noscript: DetailedHTMLAttributesSchema,
    object: DetailedObjectHTMLAttributesSchema,
    ol: DetailedOlHTMLAttributesSchema,
    optgroup: DetailedOptgroupHTMLAttributesSchema,
    option: DetailedOptionHTMLAttributesSchema,
    output: DetailedOutputHTMLAttributesSchema,
    p: DetailedHTMLAttributesSchema,
    picture: DetailedHTMLAttributesSchema,
    pre: DetailedHTMLAttributesSchema,
    progress: DetailedProgressHTMLAttributesSchema,
    q: DetailedQuoteHTMLAttributesSchema,
    rp: DetailedHTMLAttributesSchema,
    rt: DetailedHTMLAttributesSchema,
    ruby: DetailedHTMLAttributesSchema,
    s: DetailedHTMLAttributesSchema,
    samp: DetailedHTMLAttributesSchema,
    script: DetailedScriptHTMLAttributesSchema,
    search: DetailedHTMLAttributesSchema,
    section: DetailedHTMLAttributesSchema,
    select: DetailedSelectHTMLAttributesSchema,
    slot: DetailedSlotHTMLAttributesSchema,
    small: DetailedHTMLAttributesSchema,
    source: DetailedSourceHTMLAttributesSchema,
    span: DetailedHTMLAttributesSchema,
    strong: DetailedHTMLAttributesSchema,
    style: DetailedStyleHTMLAttributesSchema,
    sub: DetailedHTMLAttributesSchema,
    summary: DetailedHTMLAttributesSchema,
    sup: DetailedHTMLAttributesSchema,
    table: DetailedTableHTMLAttributesSchema,
    template: DetailedTemplateHTMLAttributesSchema,
    tbody: DetailedHTMLAttributesSchema,
    td: DetailedTdHTMLAttributesSchema,
    textarea: DetailedTextareaHTMLAttributesSchema,
    tfoot: DetailedHTMLAttributesSchema,
    th: DetailedThHTMLAttributesSchema,
    thead: DetailedHTMLAttributesSchema,
    time: DetailedTimeHTMLAttributesSchema,
    title: DetailedHTMLAttributesSchema,
    tr: DetailedHTMLAttributesSchema,
    track: DetailedTrackHTMLAttributesSchema,
    u: DetailedHTMLAttributesSchema,
    ul: DetailedHTMLAttributesSchema,
    var: DetailedHTMLAttributesSchema,
    video: DetailedVideoHTMLAttributesSchema,
    wbr: DetailedHTMLAttributesSchema,
    // SVG
    svg: DetailedSVGAttributesSchema,
    animate: DetailedSVGAttributesSchema,
    circle: DetailedSVGAttributesSchema,
    animateMotion: DetailedSVGAttributesSchema,
    animateTransform: DetailedSVGAttributesSchema,
    clipPath: DetailedSVGAttributesSchema,
    defs: DetailedSVGAttributesSchema,
    desc: DetailedSVGAttributesSchema,
    ellipse: DetailedSVGAttributesSchema,
    feBlend: DetailedSVGAttributesSchema,
    feColorMatrix: DetailedSVGAttributesSchema,
    feComponentTransfer: DetailedSVGAttributesSchema,
    feComposite: DetailedSVGAttributesSchema,
    feConvolveMatrix: DetailedSVGAttributesSchema,
    feDiffuseLighting: DetailedSVGAttributesSchema,
    feDisplacementMap: DetailedSVGAttributesSchema,
    feDistantLight: DetailedSVGAttributesSchema,
    feDropShadow: DetailedSVGAttributesSchema,
    feFlood: DetailedSVGAttributesSchema,
    feFuncA: DetailedSVGAttributesSchema,
    feFuncB: DetailedSVGAttributesSchema,
    feFuncG: DetailedSVGAttributesSchema,
    feFuncR: DetailedSVGAttributesSchema,
    feGaussianBlur: DetailedSVGAttributesSchema,
    feImage: DetailedSVGAttributesSchema,
    feMerge: DetailedSVGAttributesSchema,
    feMergeNode: DetailedSVGAttributesSchema,
    feMorphology: DetailedSVGAttributesSchema,
    feOffset: DetailedSVGAttributesSchema,
    fePointLight: DetailedSVGAttributesSchema,
    feSpecularLighting: DetailedSVGAttributesSchema,
    feSpotLight: DetailedSVGAttributesSchema,
    feTile: DetailedSVGAttributesSchema,
    feTurbulence: DetailedSVGAttributesSchema,
    filter: DetailedSVGAttributesSchema,
    foreignObject: DetailedSVGAttributesSchema,
    g: DetailedSVGAttributesSchema,
    image: DetailedSVGAttributesSchema,
    line: DetailedSVGAttributesSchema,
    linearGradient: DetailedSVGAttributesSchema,
    marker: DetailedSVGAttributesSchema,
    mask: DetailedSVGAttributesSchema,
    metadata: DetailedSVGAttributesSchema,
    mpath: DetailedSVGAttributesSchema,
    path: DetailedSVGAttributesSchema,
    pattern: DetailedSVGAttributesSchema,
    polygon: DetailedSVGAttributesSchema,
    polyline: DetailedSVGAttributesSchema,
    radialGradient: DetailedSVGAttributesSchema,
    rect: DetailedSVGAttributesSchema,
    set: DetailedSVGAttributesSchema,
    stop: DetailedSVGAttributesSchema,
    switch: DetailedSVGAttributesSchema,
    symbol: DetailedSVGAttributesSchema,
    text: DetailedSVGAttributesSchema,
    textPath: DetailedSVGAttributesSchema,
    tspan: DetailedSVGAttributesSchema,
    use: DetailedSVGAttributesSchema,
    view: DetailedSVGAttributesSchema,
  },
  // catchall(DetailedHTMLAttributesSchema)
  additionalProperties: DetailedHTMLAttributesSchema,
}
