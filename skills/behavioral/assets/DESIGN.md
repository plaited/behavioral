---
version: alpha
name: Behavioral (behavioral.sh)
description: >
  Dual-theme design system and technical specification for behavioral.sh:
  a sovereign agent harness and execution observer framework providing
  multi-agent orchestration, telemetry inspection, memory visualization, and
  autonomous node supervision. Basic theming — values only; component
  styling emerges from generation, not component tokens.
omitted:
  - section: components
    reason: "basic theming — component styling emerges from generation (the ui_* producer threads derive structure from Structural IA; these tokens carry values only)"
brand:
  name: behavioral.sh
  product: behavioral.sh
  domain: behavioral.sh
  system_classification: "Sovereign Agent Harness & Execution Observer"
  logo_mark: "B{  }"
  logo_mark_description: "Capital letter B followed by curly brackets with explicit double spacing between brackets"
  typography_font: "Ropa Sans"
  font_specimen: "https://fonts.google.com/specimen/Ropa+Sans"
  font_google_url: "https://fonts.googleapis.com/css2?family=Ropa+Sans:ital@0;1&display=swap"
  weight_rule: "unweighted / regular rhythm (400 weight throughout, no aggressive heavy bolding); italics supported for annotations and agent prompts"
  brand_anchor_gradient: "linear-gradient(135deg, #E2BAE0 0%, #FFC6CE 100%)"
  brand_anchor_tokens: "Primary Lavender (#E2BAE0) → Tertiary Rose (#FFC6CE)"
  aesthetic: "Technical, disciplined, notebook-inspired with muted violet and rose accents"
surfaces_texture:
  pattern: "dotted-notebook"
  dot_spacing: "24px"
  dot_size: "1.5px"
  implementation: |
    background-color: light-dark(#FCF8FC, #110D11);
    background-image: radial-gradient(color-mix(in srgb, light-dark(#755576, #E2BAE0) 12%, transparent) 1.5px, transparent 1.5px);
    background-size: 24px 24px;
  note: >
    Dual-mode values use CSS light-dark(); derived values (the dot tint) use
    color-mix() over the primary token rather than hardcoded rgba — theme
    edits propagate to the texture.
typography:
  display-lg:
    fontFamily: "'Ropa Sans', sans-serif"
    fontSize: "57px"
    lineHeight: "64px"
    letterSpacing: "-0.25px"
    fontWeight: "400"
    usage: "Runtime hero metrics, primary console display numbers"
  display-md:
    fontFamily: "'Ropa Sans', sans-serif"
    fontSize: "45px"
    lineHeight: "52px"
    letterSpacing: "0px"
    fontWeight: "400"
    usage: "Telemetry counters, large status displays"
  headline-lg:
    fontFamily: "'Ropa Sans', sans-serif"
    fontSize: "32px"
    lineHeight: "40px"
    letterSpacing: "0px"
    fontWeight: "400"
    usage: "Harness workspace titles, primary dashboard headings"
  headline-md:
    fontFamily: "'Ropa Sans', sans-serif"
    fontSize: "28px"
    lineHeight: "36px"
    letterSpacing: "0px"
    fontWeight: "400"
    usage: "Inspector panels, section titles, modal headers"
  headline-sm:
    fontFamily: "'Ropa Sans', sans-serif"
    fontSize: "24px"
    lineHeight: "32px"
    letterSpacing: "0px"
    fontWeight: "400"
    usage: "Agent cluster card titles, telemetry group headers"
  title-lg:
    fontFamily: "'Ropa Sans', sans-serif"
    fontSize: "22px"
    lineHeight: "28px"
    letterSpacing: "0px"
    fontWeight: "400"
    usage: "Omnibar URI text, top navigation titles"
  title-md:
    fontFamily: "'Ropa Sans', sans-serif"
    fontSize: "16px"
    lineHeight: "24px"
    letterSpacing: "0.15px"
    fontWeight: "400"
    usage: "Agent node status, session descriptors, table headers"
  title-sm:
    fontFamily: "'Ropa Sans', sans-serif"
    fontSize: "14px"
    lineHeight: "20px"
    letterSpacing: "0.1px"
    fontWeight: "400"
    usage: "Subheadings, configuration keys, panel labels"
  body-lg:
    fontFamily: "'Ropa Sans', sans-serif"
    fontSize: "16px"
    lineHeight: "24px"
    letterSpacing: "0.5px"
    fontWeight: "400"
    usage: "Agent trace logs, long-form execution telemetry"
  body-md:
    fontFamily: "'Ropa Sans', sans-serif"
    fontSize: "14px"
    lineHeight: "20px"
    letterSpacing: "0.25px"
    fontWeight: "400"
    usage: "Standard console outputs, event logs, task descriptions"
  body-sm:
    fontFamily: "'Ropa Sans', sans-serif"
    fontSize: "12px"
    lineHeight: "16px"
    letterSpacing: "0.4px"
    fontWeight: "400"
    usage: "Timestamps, metadata, memory addresses, node hashes"
  label-lg:
    fontFamily: "'Ropa Sans', sans-serif"
    fontSize: "14px"
    lineHeight: "20px"
    letterSpacing: "0.1px"
    fontWeight: "400"
    usage: "Primary CTA buttons, interactive triggers"
  label-md:
    fontFamily: "'Ropa Sans', sans-serif"
    fontSize: "12px"
    lineHeight: "16px"
    letterSpacing: "0.5px"
    fontWeight: "400"
    usage: "Filter chips, active state pills, mode toggles"
  label-sm:
    fontFamily: "'Ropa Sans', sans-serif"
    fontSize: "11px"
    lineHeight: "16px"
    letterSpacing: "0.5px"
    fontWeight: "400"
    usage: "Telemetry badges, pulse indicators, status tags"
colors:
  background: "light-dark(#FCF8FC, #110D11)"
  surface: "light-dark(#FCF8FC, #110D11)"
  surface-dim: "light-dark(#DED7DD, #110D11)"
  surface-bright: "light-dark(#FFFFFF, #322A31)"
  surface-container-lowest: "light-dark(#FFFFFF, #000000)"
  surface-container-low: "light-dark(#F7F1F6, #171217)"
  surface-container: "light-dark(#F2EDF0, #1E181E)"
  surface-container-high: "light-dark(#EEE7EB, #241D24)"
  surface-container-highest: "light-dark(#EAE1E6, #2B232B)"
  on-surface: "light-dark(#1E151A, #F0E1EC)"
  on-surface-variant: "light-dark(#564353, #B4A7B2)"
  outline: "light-dark(#9D8B9B, #7D727C)"
  outline-variant: "light-dark(#D5C1D2, #4E454E)"
  primary: "light-dark(#755576, #E2BAE0)"
  on-primary: "light-dark(#FFFFFF, #422644)"
  primary-container: "light-dark(#F7CEF5, #674868)"
  on-primary-container: "light-dark(#2B112E, #FFD7FD)"
  secondary: "light-dark(#534152, #D7BFD5)"
  on-secondary: "light-dark(#FFFFFF, #4C3B4C)"
  secondary-container: "light-dark(#F4DBF1, #473647)"
  on-secondary-container: "light-dark(#251726, #F4DBF1)"
  tertiary: "light-dark(#86505A, #FFC6CE)"
  on-tertiary: "light-dark(#FFFFFF, #4F222C)"
  tertiary-container: "light-dark(#FFCFD5, #86505A)"
  on-tertiary-container: "light-dark(#350E17, #FFCFD5)"
  error: "light-dark(#BA1A1A, #FFB4AB)"
  on-error: "light-dark(#FFFFFF, #690005)"
  error-container: "light-dark(#FFDAD6, #93000A)"
  on-error-container: "light-dark(#410002, #FFDAD6)"
rounded:
  sm: "4px"
  md: "8px"
  default: "12px"
  lg: "16px"
  xl: "24px"
  full: "9999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
  xxl: "48px"
  gutter: "16px"
  margin: "20px"
accessibility:
  wcag_status: "WCAG 2.1 AA & AAA Compliant (audited pairs below; light-dark() preserves the audited values per mode)"
  audited_contrast_pairs:
    dark_primary_text: "15.2:1 (AAA Pass)"
    dark_secondary_text: "8.1:1 (AAA Pass)"
    dark_primary_action: "6.2:1 (AA / AAA Large Pass)"
    dark_tertiary_accent: "7.4:1 (AAA Pass)"
    light_primary_text: "16.1:1 (AAA Pass)"
    light_secondary_text: "7.9:1 (AAA Pass)"
    light_primary_action: "5.8:1 (AA Pass)"
    light_tertiary_accent: "6.5:1 (AA Pass)"
---

# behavioral.sh — Design System Specification (DESIGN.md)

> **Source of Truth:** This specification defines the visual identity, typography, dual-theme surface tokens, dotted-notebook background texture, and accessibility benchmarks for **behavioral.sh**. Basic theming: the frontmatter tokens are the normative values; component styling emerges from generation, not from this file.

---

## 1. Brand Identity & Overview

| Attribute | Specification |
|---|---|
| **Product & Domain** | `behavioral.sh` |
| **System Classification** | Sovereign Agent Harness & Execution Observer |
| **Primary Typography** | **Ropa Sans** (`font-family: 'Ropa Sans', sans-serif`) |
| **Font Specimen** | [Google Fonts: Ropa Sans](https://fonts.google.com/specimen/Ropa+Sans) |
| **Typographic Mark** | `B{  }` (Explicit double-space within brackets in Ropa Sans) |
| **Brand Anchor Gradient** | `#E2BAE0 → #FFC6CE` (Primary Lavender to Tertiary Rose) |
| **Surface Texture** | **Dotted Notebook Grid** (24px grid spacing, 1.5px dots) |
| **Default Corner Radius** | 12px (`rounded.default`) |

---

## 2. Dotted Notebook Surfaces

Both dark console and light workspace surfaces feature a disciplined 24px mathematical dot grid, evoking engineering notebooks and telemetry coordinate spaces.

### 2.1 Dual-Mode Surface Texture

```css
background-color: light-dark(#FCF8FC, #110D11);
background-image: radial-gradient(color-mix(in srgb, light-dark(#755576, #E2BAE0) 12%, transparent) 1.5px, transparent 1.5px);
background-size: 24px 24px;
```

The dot tint derives from the primary token via `color-mix()`, so a theme edit propagates to the texture with no separate maintenance.

---

## 3. Typography: Ropa Sans

**Ropa Sans** is the single source of typographic truth across all screens. To preserve technical discipline, typography is maintained in an **unweighted / 400 regular rhythm** without aggressive bolding; italics are supported for annotations and agent prompts.

- **Google Font Import:**
  ```html
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Ropa+Sans:ital@0;1&display=swap" rel="stylesheet">
  ```

- **Universal Application Rule:**
  ```css
  body, button, input, select, textarea, h1, h2, h3, h4, h5, h6, p, span, div, a, label, code, pre {
    font-family: 'Ropa Sans', sans-serif !important;
  }
  ```

### Type Scale (Ropa Sans)

| Token | Size | Weight | Line Height | Tracking | Usage |
|---|---|---|---|---|---|
| `display-lg` | 57px | 400 | 64px | -0.25px | Hero telemetry metrics, primary display figures |
| `display-md` | 45px | 400 | 52px | 0px | Secondary counters, harness cycle displays |
| `headline-lg` | 32px | 400 | 40px | 0px | Workspace & harness view headers |
| `headline-md` | 28px | 400 | 36px | 0px | Inspector panels, modal headers |
| `headline-sm` | 24px | 400 | 32px | 0px | Agent node cluster card headers |
| `title-lg` | 22px | 400 | 28px | 0px | Omnibar route text, main navigation tabs |
| `title-md` | 16px | 400 | 24px | 0.15px | Node status headers, agent labels |
| `title-sm` | 14px | 400 | 20px | 0.1px | Section subheadings, telemetry keys |
| `body-lg` | 16px | 400 | 24px | 0.5px | Agent memory logs, execution traces |
| `body-md` | 14px | 400 | 20px | 0.25px | Default console logs, task descriptions |
| `body-sm` | 12px | 400 | 16px | 0.4px | Timestamps, metadata, node hashes |
| `label-lg` | 14px | 400 | 20px | 0.1px | Primary interactive buttons, CTA elements |
| `label-md` | 12px | 400 | 16px | 0.5px | Filter chips, state pills, action triggers |
| `label-sm` | 11px | 400 | 16px | 0.5px | Telemetry badges, pulse indicators |

---

## 4. Dual-Theme Surface Architecture & Contrast Compliance

### 4.1 Dark Mode (Primary Console)

| Token | Hex | Role & Mapping | Contrast Ratio |
|---|---|---|---|
| `surface` | `#110D11` | Primary console background | 15.2:1 against text |
| `surface-dim` | `#110D11` | Dimmed surface variant | — |
| `surface-bright` | `#322A31` | Brightened surface variant | — |
| `surface-container-lowest` | `#000000` | Lowest elevation layer | — |
| `surface-container-low` | `#171217` | Inset panels, statusbars | — |
| `surface-container` | `#1E181E` | Node cards, memory clusters | — |
| `surface-container-high` | `#241D24` | Elevated telemetry modules | — |
| `surface-container-highest` | `#2B232B` | Hover states, active layers | — |
| `primary` | `#E2BAE0` | Primary brand accent & active states | 6.2:1 on container |
| `on-primary` | `#422644` | High-contrast text on primary fill | 6.2:1 (AA / AAA Large) |
| `primary-container` | `#674868` | Secondary interactive fills | — |
| `on-primary-container` | `#FFD7FD` | Text on primary containers | — |
| `secondary` | `#D7BFD5` | Muted secondary accent | — |
| `on-secondary` | `#4C3B4C` | Text on secondary fill | — |
| `secondary-container` | `#473647` | Secondary container fills | — |
| `on-secondary-container` | `#F4DBF1` | Text on secondary containers | — |
| `tertiary` | `#FFC6CE` | Soft rose highlights, live AI spark | 7.4:1 on container |
| `on-tertiary` | `#4F222C` | Text on tertiary fill | — |
| `tertiary-container` | `#86505A` | Tertiary container fills | — |
| `on-tertiary-container` | `#FFCFD5` | Text on tertiary containers | — |
| `error` | `#FFB4AB` | Error accent | — |
| `on-error` | `#690005` | Text on error fill | — |
| `error-container` | `#93000A` | Error container fills | — |
| `on-error-container` | `#FFDAD6` | Text on error containers | — |
| `on-surface` | `#F0E1EC` | Primary console readable text | 15.2:1 (AAA Pass) |
| `on-surface-variant` | `#B4A7B2` | Subdued telemetry labels, timestamps | 8.1:1 (AAA Pass) |
| `outline` | `#7D727C` | Architectural borders | 4.8:1 (AA UI Pass) |
| `outline-variant` | `#4E454E` | Inset dividers & grid rules | — |

### 4.2 Light Mode (Mirrored Workspace)

| Token | Hex | Role & Mapping | Contrast Ratio |
|---|---|---|---|
| `surface` | `#FCF8FC` | Primary workspace canvas | 16.1:1 against text |
| `surface-dim` | `#DED7DD` | Dimmed surface variant | — |
| `surface-bright` | `#FFFFFF` | Brightened surface variant | — |
| `surface-container-lowest` | `#FFFFFF` | Lowest elevation layer | — |
| `surface-container-low` | `#F7F1F6` | Lowered canvas regions | — |
| `surface-container` | `#F2EDF0` | Node cards, container modules | — |
| `surface-container-high` | `#EEE7EB` | Elevated inspector panels, omnibar | — |
| `surface-container-highest` | `#EAE1E6` | High-contrast active borders | — |
| `primary` | `#755576` | Solid primary buttons & brand text | 5.8:1 (AA Pass) |
| `on-primary` | `#FFFFFF` | Text on solid primary actions | 5.8:1 (AA Pass) |
| `primary-container` | `#F7CEF5` | Muted chip and highlight backgrounds | — |
| `on-primary-container` | `#2B112E` | Text on primary containers | — |
| `secondary` | `#534152` | Muted secondary accent | — |
| `on-secondary` | `#FFFFFF` | Text on secondary fill | — |
| `secondary-container` | `#F4DBF1` | Secondary container fills | — |
| `on-secondary-container` | `#251726` | Text on secondary containers | — |
| `tertiary` | `#86505A` | Deep rose accent text and badges | 6.5:1 (AA Pass) |
| `on-tertiary` | `#FFFFFF` | Text on tertiary fill | — |
| `tertiary-container` | `#FFCFD5` | Tertiary container fills | — |
| `on-tertiary-container` | `#350E17` | Text on tertiary containers | — |
| `error` | `#BA1A1A` | Error accent | — |
| `on-error` | `#FFFFFF` | Text on error fill | — |
| `error-container` | `#FFDAD6` | Error container fills | — |
| `on-error-container` | `#410002` | Text on error containers | — |
| `on-surface` | `#1E151A` | Primary legible dark text | 16.1:1 (AAA Pass) |
| `on-surface-variant` | `#564353` | Secondary labels & property names | 7.9:1 (AAA Pass) |
| `outline` | `#9D8B9B` | Borders & card outlines | 4.6:1 (AA UI Pass) |
| `outline-variant` | `#D5C1D2` | Inset dividers & table borders | — |

### 4.3 Dual-Mode & Derived Values

Frontmatter color tokens carry dual-mode values via CSS [`light-dark()`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Values/color_value/light-dark) — one token, one custom property, the browser resolves the mode. Derived adjustments (hover tints, texture dots, translucent variants) use [`color-mix()`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Values/color_value/color-mix) over base tokens, never hardcoded rgba — a theme edit propagates to every derived value.

### 4.4 Scale & Spacing Tokens

| Group | Tokens |
|---|---|
| `rounded` | `sm` 4px · `md` 8px · `default` 12px · `lg` 16px · `xl` 24px · `full` 9999px |
| `spacing` | `xs` 4px · `sm` 8px · `md` 16px · `lg` 24px · `xl` 32px · `xxl` 48px · `gutter` 16px · `margin` 20px |

---

*behavioral.sh · Ropa Sans & Dotted Notebook Specification v3.0.0*
