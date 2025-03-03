/**

*/

import * as _ from 'lodash'
import { BuildSchemaError, ExecuteSchemaError } from '../start-server/errors'
import fs from 'fs-extra'
import path from 'path'
import { build, Platform } from 'esbuild'
import type { Loader } from 'esbuild'
import type { Schema } from '@tinacms/graphql'
import { logText } from '../../utils/theme'
import { fileExists, getPath } from '../../lib'
import { logger } from '../../logger'

const generatedFilesToRemove = [
  '_graphql.json',
  '__lookup.json',
  '__schema.json',
  'frags.gql',
  'queries.gql',
  'schema.gql',
  'db',
]

export const resetGeneratedFolder = async ({
  tinaGeneratedPath,
  usingTs,
  isBuild,
}: {
  tinaGeneratedPath: string
  usingTs: boolean
  isBuild: boolean
}) => {
  try {
    if (isBuild) {
      // When running `tinacms build` we can still remove all generated files
      await fs.emptyDir(tinaGeneratedPath)
    } else {
      for (let index = 0; index < generatedFilesToRemove.length; index++) {
        const file = generatedFilesToRemove[index]
        if (file === 'db') {
          // avoid https://github.com/tinacms/tinacms/issues/3076
          try {
            await fs.remove(path.join(tinaGeneratedPath, file))
          } catch (_e) {
            // fail silently as this is problematic on windows
          }
        } else {
          await fs.remove(path.join(tinaGeneratedPath, file))
        }
      }
    }
  } catch (e) {
    console.log(e)
  }

  await fs.mkdirp(tinaGeneratedPath)
  const ext = usingTs ? 'ts' : 'js'

  // temp types file to allows the client to build
  if (!(await fs.pathExists(path.join(tinaGeneratedPath, `types.${ext}`)))) {
    await fs.writeFile(
      path.join(tinaGeneratedPath, `types.${ext}`),
      `
      export const queries = (client)=>({})
      `
    )
  }
  if (!(await fs.pathExists(path.join(tinaGeneratedPath, `client.${ext}`)))) {
    await fs.writeFile(
      path.join(tinaGeneratedPath, `client.${ext}`),
      `
export const client = ()=>{}
export default client
`
    )
  }

  await fs.outputFile(
    path.join(tinaGeneratedPath, '.gitignore'),
    `app
db
prebuild
client.ts
client.js
types.ts
types.js
types.d.ts
frags.gql
queries.gql
schema.gql
out.jsx
`
  )
}

// Cleanup function that is guaranteed to run
const cleanup = async ({ tinaTempPath }: { tinaTempPath: string }) => {
  await fs.remove(tinaTempPath)
}

export const compileFile = async (
  options: {
    schemaFileType?: string
    verbose?: boolean
    dev?: boolean
    rootPath: string
  },
  fileName: string
) => {
  const root = options.rootPath
  if (!root) {
    throw new Error('ctx.rootPath has not been attached')
  }
  const tinaPath = path.join(root, '.tina')
  const tsConfigPath = path.join(root, 'tsconfig.json')
  const tinaGeneratedPath = path.join(tinaPath, '__generated__')
  const tinaTempPath = path.join(tinaGeneratedPath, `temp_${fileName}`)
  const packageJSONFilePath = path.join(root, 'package.json')

  if (!options.schemaFileType) {
    const usingTs = await fs.pathExists(tsConfigPath)
    // default schema file type is based on the existence of a tsconfig.json
    options = { ...options, schemaFileType: usingTs ? 'ts' : 'js' }
  }

  if (options.verbose) {
    logger.info(logText(`Compiling ${fileName}...`))
  }

  const { schemaFileType: requestedSchemaFileType = 'ts' } = options

  const schemaFileType =
    ((requestedSchemaFileType === 'ts' || requestedSchemaFileType === 'tsx') &&
      'ts') ||
    ((requestedSchemaFileType === 'js' || requestedSchemaFileType === 'jsx') &&
      'js')

  if (!schemaFileType) {
    throw new Error(
      `Requested schema file type '${requestedSchemaFileType}' is not valid. Supported schema file types: 'ts, js, tsx, jsx'`
    )
  }

  // Turns the schema into JS files so they can be run
  try {
    const define = {}
    if (!process.env.NODE_ENV) {
      define['process.env.NODE_ENV'] = options.dev
        ? '"development"'
        : '"production"'
    }
    const inputFile = getPath({
      projectDir: tinaPath,
      filename: fileName,
      allowedTypes: ['js', 'jsx', 'tsx', 'ts'],
      errorMessage: `Must provide a ${fileName}.{js,jsx,tsx,ts}`,
    })
    await transpile(
      inputFile,
      `${fileName}.cjs`,
      tinaTempPath,
      options.verbose,
      define,
      packageJSONFilePath
    )
  } catch (e) {
    await cleanup({ tinaTempPath })
    throw new BuildSchemaError(e)
  }

  // Delete the node require cache for .tina temp folder
  Object.keys(require.cache).map((key) => {
    if (key.startsWith(tinaTempPath)) {
      delete require.cache[require.resolve(key)]
    }
  })
  let returnObject = {}

  try {
    const schemaFunc = require(path.join(tinaTempPath, `${fileName}.cjs`))
    returnObject = schemaFunc.default
    await cleanup({ tinaTempPath })
  } catch (e) {
    // Always remove the temp code
    await cleanup({ tinaTempPath })

    // Keep TinaSchemaValidationErrors around
    if (e instanceof Error) {
      if (e.name === 'TinaSchemaValidationError') {
        throw e
      }
    }

    // Throw an execution error
    throw new ExecuteSchemaError(e)
  }
  return returnObject
}

export const compileSchema = async (options: {
  schemaFileType?: string
  verbose?: boolean
  dev?: boolean
  rootPath: string
}) => {
  const root = options.rootPath
  const tinaPath = path.join(root, '.tina')
  const tinaGeneratedPath = path.join(tinaPath, '__generated__')
  const tinaConfigPath = path.join(tinaGeneratedPath, 'config')

  const schemaExists = fileExists({
    projectDir: tinaPath,
    filename: 'schema',
    allowedTypes: ['js', 'jsx', 'tsx', 'ts'],
  })
  const configExists = fileExists({
    projectDir: tinaPath,
    filename: 'config',
    allowedTypes: ['js', 'jsx', 'tsx', 'ts'],
  })

  // If there is not Schema and no config
  if (!schemaExists && !configExists) {
    throw new Error(
      'No schema or config file found in .tina folder. Please run `npx @tinacms/cli@latest init` to generate a schema file.'
    )
  }

  let schema: any

  // only do this if there is a schema file
  if (schemaExists && !configExists) {
    console.warn(
      `schema.{ts,tsx,js,jsx} will soon be deprecated, in favor of the new config.{ts,tsx,js,jsx}\nSee here for migration steps, see here: https://tina.io/blog/upgrading-to-iframe`
    )

    schema = await compileFile(options, 'schema')
  }
  if (configExists) {
    const config = (await compileFile(options, 'config')) as any
    const configCopy = _.cloneDeep(config)
    delete configCopy.schema
    if (config?.schema) {
      // Merge the schema with the config to maintain backwards compatibility
      // EX: {collections: [], config: {...}}
      schema = { ...config.schema, config: configCopy }
    }
  }
  await fs.outputFile(
    path.join(tinaConfigPath, `schema.json`),
    JSON.stringify(schema, null, 2)
  )

  return schema
}

export const transpile = async (
  inputFile,
  outputFile,
  tempDir,
  verbose,
  define,
  packageJSONFilePath: string,
  platform: Platform = 'neutral'
) => {
  if (verbose) logger.info(logText('Building javascript...'))

  const packageJSON = JSON.parse(
    fs.readFileSync(packageJSONFilePath).toString() || '{}'
  )
  const deps = packageJSON?.dependencies || []
  const peerDeps = packageJSON?.peerDependencies || []
  const devDeps = packageJSON?.devDependencies || []
  const external = Object.keys({ ...deps, ...peerDeps, ...devDeps })

  /**
   * Pre build into an temporary file so we can respect the user's
   * tsconfig (eg. `baseUrl` and `jsx` arguments). We'll then
   * use this file with a custom (empty) tsconfig to ensure
   * we don't get any unexpected behavior.
   *
   * Note that for `viteBuild` we'll want to do something similar as
   * it will be unable to find modules if a user's tsconfig has a `baseurl`
   * configuration.
   */
  const prebuiltInputPath = path.join(tempDir, 'temp-output.jsx')
  await build({
    bundle: true,
    platform,
    target: ['es2020'],
    entryPoints: [inputFile],
    treeShaking: true,
    external: [...external, './node_modules/*'],
    loader: loaders,
    outfile: prebuiltInputPath,
    define: define,
  })

  /**
   * Fake the tsconfig so the `"jsx": "preserve"` setting doesn't
   * bleed into the build. This breaks when users provide JSX in their
   * config.
   *
   * https://github.com/tinacms/tinacms/issues/3091
   */
  const tempTsConfigPath = path.join(tempDir, 'temp-tsconfig.json')
  await fs.outputFileSync(tempTsConfigPath, '{}')

  const outputPath = path.join(tempDir, outputFile)
  await build({
    bundle: true,
    platform,
    target: ['node10.4'],
    entryPoints: [prebuiltInputPath],
    // Since this code is run via CLI, convert it to cjs
    // for simplicity.
    format: 'cjs',
    treeShaking: true,
    external: [...external, './node_modules/*'],
    tsconfig: tempTsConfigPath,
    loader: loaders,
    outfile: outputPath,
    define: define,
  })
  if (verbose) logger.info(logText(`Javascript built`))
}

export const defineSchema = (config: Schema) => {
  return config
}

const loaders: { [ext: string]: Loader } = {
  '.aac': 'file',
  '.css': 'file',
  '.eot': 'file',
  '.flac': 'file',
  '.gif': 'file',
  '.jpeg': 'file',
  '.jpg': 'file',
  '.json': 'json',
  '.mp3': 'file',
  '.mp4': 'file',
  '.ogg': 'file',
  '.otf': 'file',
  '.png': 'file',
  '.svg': 'file',
  '.ttf': 'file',
  '.wav': 'file',
  '.webm': 'file',
  '.webp': 'file',
  '.woff': 'file',
  '.woff2': 'file',
  '.js': 'jsx',
  '.jsx': 'jsx',
  '.tsx': 'tsx',
}
