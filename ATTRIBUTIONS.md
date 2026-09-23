# Attributions

This document acknowledges the outside work that still has a visible, current
influence on Plaited's architecture, vocabulary, and research direction.

It is intentionally narrow. Older or weaker influences have been removed so
this file tracks what is materially present in the repo now, not every source
that was once referenced during exploration.

## Structural Information Architecture

**Author:** Rachel Jaffe
**Source:** [Structural Information Architecture](https://medium.com/@rjaffe01/structural-information-architecture-e7d5de94a211)

Rachel Jaffe's Structural IA vocabulary remains one of the clearest direct
inputs into Plaited's structural language.

Concepts that still show up in the repo:
- **Objects**
- **Channels**
- **Levers**
- **Loops**
- **Blocks**

Where that influence is visible now:
- [docs/wiki/architecture.md](docs/wiki/architecture.md)
- [skills/plaited-framework/references/design-spec.md](skills/plaited-framework/references/design-spec.md)

In Plaited, Structural IA is not just UI vocabulary. It also informs the
module composition language, module-era system framing, and the bridge between
symbolic constraints and generated artifacts.

## Matt Pocock Skills

**Author:** Matt Pocock
**Source:** [mattpocock/skills](https://github.com/mattpocock/skills)
**License:** [MIT](https://github.com/mattpocock/skills/blob/main/LICENSE),
copyright (c) 2026 Matt Pocock

Plaited includes adapted skill material from:
- [TDD](https://github.com/mattpocock/skills/blob/main/skills/engineering/tdd/SKILL.md)
- [grill-me](https://github.com/mattpocock/skills/blob/main/skills/productivity/grill-me/SKILL.md)

Where that influence is visible now:
- [skills/tdd/SKILL.md](skills/tdd/SKILL.md)
- [skills/grill-me/SKILL.md](skills/grill-me/SKILL.md)

## Scope Note

This attribution file is intentionally conservative.

At the moment, the strongest and clearest influence that is still reflected in
the active repo is Rachel Jaffe's Structural Information Architecture.

Other ideas around generative UI, browser-grounded evaluation, or AI-assisted
design may still inform experiments or language in places, but they are not as
foundational or as directly encoded in the current codebase.
