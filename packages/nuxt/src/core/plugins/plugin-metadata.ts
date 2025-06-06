import type { Literal } from 'estree'
import { defu } from 'defu'
import { findExports } from 'mlly'
import type { Nuxt } from '@nuxt/schema'
import { createUnplugin } from 'unplugin'
import MagicString from 'magic-string'
import { normalize } from 'pathe'
import type { ObjectPlugin, PluginMeta } from 'nuxt/app'

import { parseAndWalk } from 'oxc-walker'
import type { IdentifierName, ObjectPropertyKind } from 'oxc-parser'
import { logger } from '../../utils'

const internalOrderMap = {
  // -50: pre-all (nuxt)
  'nuxt-pre-all': -50,
  // -40: custom payload revivers (user)
  'user-revivers': -40,
  // -30: payload reviving (nuxt)
  'nuxt-revivers': -30,
  // -20: pre (user) <-- pre mapped to this
  'user-pre': -20,
  // -10: default (nuxt)
  'nuxt-default': -10,
  // 0: default (user) <-- default behavior
  'user-default': 0,
  // +10: post (nuxt)
  'nuxt-post': 10,
  // +20: post (user) <-- post mapped to this
  'user-post': 20,
  // +30: post-all (nuxt)
  'nuxt-post-all': 30,
}

export const orderMap: Record<NonNullable<ObjectPlugin['enforce']>, number> = {
  pre: internalOrderMap['user-pre'],
  default: internalOrderMap['user-default'],
  post: internalOrderMap['user-post'],
}

const metaCache: Record<string, Omit<PluginMeta, 'enforce'>> = {}
export function extractMetadata (code: string, loader = 'ts' as 'ts' | 'tsx') {
  let meta: PluginMeta = {}
  if (metaCache[code]) {
    return metaCache[code]
  }
  if (code.match(/defineNuxtPlugin\s*\([\w(]/)) {
    return {}
  }
  parseAndWalk(code, `file.${loader}`, (node) => {
    if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier') { return }

    const name = 'name' in node.callee && node.callee.name
    if (name !== 'defineNuxtPlugin' && name !== 'definePayloadPlugin') { return }

    if (name === 'definePayloadPlugin') {
      meta.order = internalOrderMap['user-revivers']
    }

    const metaArg = node.arguments[1]
    if (metaArg) {
      if (metaArg.type !== 'ObjectExpression') {
        throw new Error('Invalid plugin metadata')
      }
      meta = extractMetaFromObject(metaArg.properties)
    }

    const plugin = node.arguments[0]
    if (plugin?.type === 'ObjectExpression') {
      meta = defu(extractMetaFromObject(plugin.properties), meta)
    }

    meta.order ||= orderMap[meta.enforce || 'default'] || orderMap.default
    delete meta.enforce
  })
  metaCache[code] = meta
  return meta as Omit<PluginMeta, 'enforce'>
}

type PluginMetaKey = keyof PluginMeta
const keys: Record<PluginMetaKey, string> = {
  name: 'name',
  order: 'order',
  enforce: 'enforce',
  dependsOn: 'dependsOn',
}
function isMetadataKey (key: string | IdentifierName): key is PluginMetaKey {
  return typeof key !== 'string' ? key.name in keys : key in keys
}

function extractMetaFromObject (properties: Array<ObjectPropertyKind>) {
  const meta: PluginMeta = {}
  for (const property of properties) {
    if (property.type === 'SpreadElement' || !('name' in property.key)) {
      throw new Error('Invalid plugin metadata')
    }
    const propertyKey = property.key.name
    if (!isMetadataKey(propertyKey)) { continue }
    if (property.value.type === 'Literal') {
      meta[propertyKey] = property.value.value as any
    }
    if (property.value.type === 'UnaryExpression' && property.value.argument.type === 'Literal') {
      meta[propertyKey] = JSON.parse(property.value.operator + property.value.argument.raw!)
    }
    if (propertyKey === 'dependsOn' && property.value.type === 'ArrayExpression') {
      if (property.value.elements.some(e => !e || e.type !== 'Literal' || typeof e.value !== 'string')) {
        throw new Error('dependsOn must take an array of string literals')
      }
      meta[propertyKey] = property.value.elements.map(e => (e as Literal)!.value as string)
    }
  }
  return meta
}

export const RemovePluginMetadataPlugin = (nuxt: Nuxt) => createUnplugin(() => {
  return {
    name: 'nuxt:remove-plugin-metadata',
    transform (code, id) {
      id = normalize(id)
      const plugin = nuxt.apps.default?.plugins.find(p => p.src === id)
      if (!plugin) { return }

      if (!code.trim()) {
        logger.warn(`Plugin \`${plugin.src}\` has no content.`)

        return {
          code: 'export default () => {}',
          map: null,
        }
      }

      const exports = findExports(code)
      const defaultExport = exports.find(e => e.type === 'default' || e.name === 'default')
      if (!defaultExport) {
        logger.warn(`Plugin \`${plugin.src}\` has no default export and will be ignored at build time. Add \`export default defineNuxtPlugin(() => {})\` to your plugin.`)
        return {
          code: 'export default () => {}',
          map: null,
        }
      }

      const s = new MagicString(code)
      let wrapped = false
      const wrapperNames = new Set(['defineNuxtPlugin', 'definePayloadPlugin'])

      try {
        parseAndWalk(code, id, (node) => {
          if (node.type === 'ImportSpecifier' && node.imported.type === 'Identifier' && (node.imported.name === 'defineNuxtPlugin' || node.imported.name === 'definePayloadPlugin')) {
            wrapperNames.add(node.local.name)
          }
          if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier') { return }

          const name = 'name' in node.callee && node.callee.name
          if (!name || !wrapperNames.has(name)) { return }
          wrapped = true

          // Remove metadata that already has been extracted
          if (!('order' in plugin) && !('name' in plugin)) { return }
          for (const [argIndex, arg] of node.arguments.entries()) {
            if (arg.type !== 'ObjectExpression') { continue }

            for (const [propertyIndex, property] of arg.properties.entries()) {
              if (property.type === 'SpreadElement' || !('name' in property.key)) { continue }

              const propertyKey = property.key.name
              if (propertyKey === 'order' || propertyKey === 'enforce' || propertyKey === 'name') {
                const nextNode = arg.properties[propertyIndex + 1] || node.arguments[argIndex + 1]
                const nextIndex = nextNode?.start || (arg.end - 1)

                s.remove(property.start, nextIndex)
              }
            }
          }
        })
      } catch (e) {
        logger.error(e)
        return
      }

      if (!wrapped) {
        logger.warn(`Plugin \`${plugin.src}\` is not wrapped in \`defineNuxtPlugin\`. It is advised to wrap your plugins as in the future this may enable enhancements.`)
      }

      if (s.hasChanged()) {
        return {
          code: s.toString(),
          map: nuxt.options.sourcemap.client || nuxt.options.sourcemap.server ? s.generateMap({ hires: true }) : null,
        }
      }
    },
  }
})
