# Intermediate cohort design plan

Dated 23 September 2026.

This note records the current design findings and the decisions for the next Intermediate cohort page pass. It does not replace the site-wide design direction in `docs/project-brief.md` §12.3. That section remains the source of truth: the credential is the object, training is one route to it, the structural reference is Microsoft Learn / Cisco, and the hard constraints are 360px layout, visible keyboard focus, sufficient contrast, semantic headings, and `prefers-reduced-motion` support.

---

## 1. Card system

### Finding

`.facts__col`, `.price`, and `.domain` are visually the same surface doing different jobs: white `--field`, a 1px `--sand-rule` border, `--r-card` rounding, no shadow, and similar padding. `.faq` is the exception: it is a plain disclosure row with a bottom divider and no card surface.

### Decision

Keep the shared card surface as the system default. Do not invent a new card family for every content type. Use the existing geometry and emphasis vocabulary deliberately when a block carries different weight: the rounded `--r-card` training/campus treatment, the squarer `--r-sm` credential treatment, or a lighter border/accent modifier where emphasis is needed without changing the object into a credential block.

The immediate implementation uses a border/accent modifier for the price-and-dates facts column because that column carries purchase-decision information while still belonging to the training page.

---

## 2. Intermediate hero — PR B backlog

### Finding

`/intermediate-cohort` has no dedicated hero component. It borrows the Foundations title treatment (`.found__title` / `.found__lede`) and then moves directly into facts panels. The certification page has a fully authored dark `.floor` hero with an SVG workflow pipeline.

### Open decision — NOT APPROVED

**PR B needs a separate Step 2 design proposal before any code is written.** The open question is whether the Intermediate page should get its own authored hero and, specifically, whether the certification page's workflow SVG should be adapted into a diagnostic/troubleshooting motif that shows silent, partial, or wrong-but-valid failure.

If that motif is built, it should be decorative with `aria-hidden="true"`, not exposed as an informational image with `role="img"`. The page copy should carry the meaning; the diagram should reinforce it rather than make assistive-technology users parse a visual diagnostic puzzle.

No SVG-pipeline hero work is part of the current implementation round.

---

## 3. Connector typography — PR C / C4 deferred

The middle-dot (`·`) and spaced-em-dash connector patterns appear across site-wide eyebrows, Path A / Path B labels, and route metadata. This is not an Intermediate-only treatment.

**Decision: defer.** Before any change, do a full site-wide instance count and location inventory. Do not make a typographic connector change as part of this launch-week page pass.

---

## 4. Decided implementation fixes — PR 2

These four changes are approved for the implementation PR:

1. **Fix `.btn--ghost` contrast by context.** Its current rule was authored for the dark hero but is reused on light paper/sand sections, producing effectively invisible text. Make the default light-ground treatment readable and scope the existing near-white treatment to `.floor__frame`, where it is correct.
2. **Emphasise the decision-bearing facts column using an existing pattern.** Add `.facts__col--pick` with the same verified-green border signal used by `.price--pick`, rather than inventing a new surface or shadow.
3. **Rename the facts-column heading to `Price and dates`.** This matches the terse, reader-facing style of the other `.facts__head` labels and names the contents directly.
4. **Use the confirmed cohort start date.** The Intermediate cohort starts Saturday, 3 October 2026. Render it as a factual `<time>` value rather than a placeholder state.

These are contained fixes. They do not change information architecture, prices, seat count, assessment values, enrollment form markup, build configuration, routes, or motion behaviour.

---

## Open decisions

- **PR B:** whether the Intermediate page gets an authored diagnostic hero based on the existing workflow SVG. Not approved; requires a separate design proposal first.
- **PR C / C4:** whether to change the site's middle-dot and spaced-em-dash connector conventions. Deferred until a full site-wide instance count is complete.
- Card hierarchy beyond the approved `facts__col--pick` modifier remains a later design decision. The current round fixes a concrete emphasis problem without refactoring the whole card system.
