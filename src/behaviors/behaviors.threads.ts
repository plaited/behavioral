import type { Thread } from '../behavioral/behavioral.types.ts'
import { CONTROLLER_DETAIL_SCHEMAS } from '../controller/controller.schemas.ts'

/**
 * The composition's root thread pack — the default threads, always mounted
 * (independent of the family allow-list).
 *
 * @remarks
 * The guard thread forbids malformed `ui_*` messages at the schema boundary: it
 * `block`s every controller message whose detail does not conform to its
 * {@link CONTROLLER_DETAIL_SCHEMAS} entry (`detailMatch: false` matches
 * non-conforming details). Both directions are covered by the one registry —
 * `ui_render`/`ui_attrs`/… (egress) and `ui_event`/`ui_form_submit`/… (ingress).
 * A blocked message is never selected, so the rejection is visible in the
 * `frontier`/`pending_bids` traces; valid messages pass untouched.
 *
 * A block-only thread stays pending forever (nothing resumes it), so its block
 * declaration is active every super-step.
 *
 * @packageDocumentation
 */

const invalidControllerMessages = Object.entries(CONTROLLER_DETAIL_SCHEMAS).map(([type, schema]) => ({
  type,
  detailSchema: schema as Record<string, unknown>,
  detailMatch: false,
}))

/** The root pack: default threads mounted by every composition. */
export const behaviorsThreads: Thread[] = [
  {
    label: 'guard:controller-schema',
    rules: [{ block: invalidControllerMessages }],
  },
]
