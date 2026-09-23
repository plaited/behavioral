import type { ControllerExtensionParams } from '../../controller.types.ts'

/**
 * Controller extension module for testing the extension feature.
 *
 * @remarks
 * Exports a `key` that maps to a `b-trigger` pair, and a default `ControllerExtension`
 * function that is invoked inside the controller's delegated listener when a matching
 * DOM event fires.
 */
export const key = 'click:module_enhanced_action'

const extension = (params: ControllerExtensionParams<HTMLElement, 'click'>) => {
  const { event, trigger } = params
  const element = event.currentTarget as HTMLElement

  trigger({
    type: 'extension_action',
    detail: {
      id: element.id,
      'data-extra': element.getAttribute('data-extra'),
    },
  })
}

export default extension
