import { z } from 'zod'

import { AUTH_TOKEN_KEY, TokenObject, authenticate } from '../auth/authenticate'
//@ts-ignore can't locate BranchChangeEvent
import { BranchChangeEvent, BranchData, EventBus } from '@tinacms/toolkit'
import {
  DocumentNode,
  GraphQLSchema,
  buildClientSchema,
  getIntrospectionQuery,
  print,
  parse,
} from 'graphql'

import gql from 'graphql-tag'
import { TinaSchema, addNamespaceToSchema, Schema } from '@tinacms/schema-tools'

export type OnLoginFunc = (args: { token: TokenObject }) => Promise<void>

export type TinaIOConfig = {
  assetsApiUrlOverride?: string // https://assets.tinajs.io
  frontendUrlOverride?: string // https://app.tina.io
  identityApiUrlOverride?: string // https://identity.tinajs.io
  contentApiUrlOverride?: string // https://content.tinajs.io
}
interface ServerOptions {
  schema?: Schema
  clientId: string
  branch: string
  customContentApiUrl?: string
  getTokenFn?: () => Promise<TokenObject>
  tinaioConfig?: TinaIOConfig
  tokenStorage?: 'MEMORY' | 'LOCAL_STORAGE' | 'CUSTOM'
}

const captureBranchName = /^refs\/heads\/(.*)/
const parseRefForBranchName = (ref: string) => {
  const matches = ref.match(captureBranchName)
  return matches[1]
}

const ListBranchResponse = z
  .object({
    name: z.string(),
    protected: z.boolean(),
    commit: z.object({ sha: z.string(), url: z.string() }),
  })
  .array()

const IndexStatusResponse = z.object({
  status: z
    .union([
      z.literal('complete'),
      z.literal('unknown'),
      z.literal('failed'),
      z.literal('inprogress'),
    ])
    .optional(),
  timestamp: z.number().optional(),
})

/**
 * The function you pass to `asyncPoll` should return a promise
 * that resolves with object that satisfies this interface.
 *
 * The `done` property indicates to the async poller whether to
 * continue polling or not.
 *
 * When done is `true` that means you've got what you need
 * and the poller will resolve with `data`.
 *
 * When done is `false` taht means you don't have what you need
 * and the poller will continue polling.
 */
export interface AsyncData<T> {
  done: boolean
  data?: T
}

/**
 * Your custom function you provide to the async poller should
 * satisfy this interface. Your function returns a promise that
 * resolves with `AsyncData` to indicate to the poller whether
 * you have what you need or we should continue polling.
 */
export interface AsyncFunction<T> extends Function {
  (): PromiseLike<AsyncData<T>>
}

/**
* How to repeatedly call an async function until get a desired result.
*
* Inspired by the following gist:
* https://gist.github.com/twmbx/2321921670c7e95f6fad164fbdf3170e#gistcomment-3053587
* https://davidwalsh.name/javascript-polling
*
* Usage:
  asyncPoll(
      async (): Promise<AsyncData<any>> => {
          try {
              const result = await getYourAsyncResult();
              if (result.isWhatYouWant) {
                  return Promise.resolve({
                      done: true,
                      data: result,
                  });
              } else {
                  return Promise.resolve({
                      done: false
                  });
              }
          } catch (err) {
              return Promise.reject(err);
          }
      },
      500,    // interval
      15000,  // timeout
  );
*/
export async function asyncPoll<T>(
  /**
   * Function to call periodically until it resolves or rejects.
   *
   * It should resolve as soon as possible indicating if it found
   * what it was looking for or not. If not then it will be reinvoked
   * after the `pollInterval` if we haven't timed out.
   *
   * Rejections will stop the polling and be propagated.
   */
  fn: AsyncFunction<T>,
  /**
   * Milliseconds to wait before attempting to resolve the promise again.
   * The promise won't be called concurrently. This is the wait period
   * after the promise has resolved/rejected before trying again for a
   * successful resolve so long as we haven't timed out.
   *
   * Default 5 seconds.
   */
  pollInterval: number = 5 * 1000,
  /**
   * Max time to keep polling to receive a successful resolved response.
   * If the promise never resolves before the timeout then this method
   * rejects with a timeout error.
   *
   * Default 30 seconds.
   */
  pollTimeout: number = 30 * 1000
): Promise<T> {
  const endTime = new Date().getTime() + pollTimeout
  const checkCondition = (resolve: Function, reject: Function): void => {
    Promise.resolve(fn())
      .then((result) => {
        const now = new Date().getTime()
        if (result.done) {
          resolve(result.data)
        } else if (now < endTime) {
          setTimeout(checkCondition, pollInterval, resolve, reject)
        } else {
          reject(new Error('AsyncPoller: reached timeout'))
        }
      })
      .catch((err) => {
        reject(err)
      })
  }
  return new Promise(checkCondition)
}

export class Client {
  onLogin?: OnLoginFunc
  onLogout?: () => Promise<void>
  frontendUrl: string
  contentApiUrl: string
  identityApiUrl: string
  assetsApiUrl: string
  gqlSchema: GraphQLSchema
  schema?: TinaSchema
  clientId: string
  contentApiBase: string
  query: string
  setToken: (_token: TokenObject) => void
  private getToken: () => Promise<TokenObject>
  private token: string // used with memory storage
  private branch: string
  private options: ServerOptions
  events = new EventBus() // automatically hooked into global event bus when attached via cms.registerApi

  constructor({ tokenStorage = 'MEMORY', ...options }: ServerOptions) {
    this.onLogin = options.schema?.config?.admin?.auth?.onLogin
    this.onLogout = options.schema?.config?.admin?.auth?.onLogout
    if (options.schema?.config?.admin?.auth?.logout) {
      this.onLogout = options.schema?.config?.admin?.auth?.logout
    }
    if (options.schema?.config?.admin?.auth?.getUser) {
      this.getUser = options.schema?.config?.admin?.auth?.getUser
    }
    if (options.schema?.config?.admin?.auth?.authenticate) {
      this.authenticate = options.schema?.config?.admin?.auth?.authenticate
    }
    if (options.schema) {
      const enrichedSchema = new TinaSchema({
        version: { fullVersion: '', major: '', minor: '', patch: '' },
        meta: { flags: [] },
        ...addNamespaceToSchema({ ...options.schema }, []),
      })
      this.schema = enrichedSchema
    }
    this.options = options

    if (options.schema?.config?.contentApiUrlOverride) {
      this.options.customContentApiUrl =
        options.schema.config.contentApiUrlOverride
    }
    this.setBranch(options.branch)
    this.events.subscribe<BranchChangeEvent>(
      'branch:change',
      ({ branchName }) => {
        this.setBranch(branchName)
      }
    )
    this.clientId = options.clientId

    switch (tokenStorage) {
      case 'LOCAL_STORAGE':
        this.getToken = async function () {
          const tokens = localStorage.getItem(AUTH_TOKEN_KEY) || null
          if (tokens) {
            return await this.getRefreshedToken(tokens)
          } else {
            return {
              access_token: null,
              id_token: null,
              refresh_token: null,
            }
          }
        }
        this.setToken = function (token) {
          localStorage.setItem(AUTH_TOKEN_KEY, JSON.stringify(token, null, 2))
        }
        break
      case 'MEMORY':
        this.getToken = async () => {
          if (this.token) {
            return await this.getRefreshedToken(this.token)
          } else {
            return {
              access_token: null,
              id_token: null,
              refresh_token: null,
            }
          }
        }
        this.setToken = (token) => {
          this.token = JSON.stringify(token, null, 2)
        }
        break
      case 'CUSTOM':
        if (!options.getTokenFn) {
          throw new Error(
            'When CUSTOM token storage is selected, a getTokenFn must be provided'
          )
        }
        this.getToken = options.getTokenFn
        break
    }
    // if the user provides a getToken function in the config we can use that
    if (options.schema?.config?.admin?.auth?.getToken) {
      this.getToken = options.schema?.config?.admin?.auth?.getToken
    }
  }

  public get isLocalMode() {
    return false
  }

  setBranch(branchName: string) {
    const encodedBranch = encodeURIComponent(branchName)
    this.branch = encodedBranch
    this.assetsApiUrl =
      this.options.tinaioConfig?.assetsApiUrlOverride ||
      'https://assets.tinajs.io'
    this.frontendUrl =
      this.options.tinaioConfig?.frontendUrlOverride || 'https://app.tina.io'
    this.identityApiUrl =
      this.options.tinaioConfig?.identityApiUrlOverride ||
      'https://identity.tinajs.io'
    this.contentApiBase =
      this.options.tinaioConfig?.contentApiUrlOverride ||
      `https://content.tinajs.io`
    this.contentApiUrl =
      this.options.customContentApiUrl ||
      `${this.contentApiBase}/content/${this.options.clientId}/github/${encodedBranch}`
  }

  addPendingContent = async (props) => {
    const mutation = `#graphql
mutation addPendingDocumentMutation(
  $relativePath: String!
  $collection: String!
  $template: String
) {
  addPendingDocument(
    relativePath: $relativePath
    template: $template
    collection: $collection
  ) {
    ... on Document {
      _sys {
        relativePath
        path
        breadcrumbs
        collection {
          slug
        }
      }
    }
  }
}`

    const result = await this.request(mutation, {
      variables: props,
    })

    return result
  }

  getSchema = async () => {
    if (!this.gqlSchema) {
      const data = await this.request<any>(getIntrospectionQuery(), {
        variables: {},
      })

      this.gqlSchema = buildClientSchema(data)
    }

    return this.gqlSchema
  }

  /**
   *
   * Returns a version of the query with fragments inlined. Eg.
   * ```graphql
   * {
   *   getPostDocument(relativePath: "") {
   *     data {
   *       ...PostFragment
   *     }
   *   }
   * }
   *
   * fragment PostFragment on Post {
   *   title
   * }
   * ```
   * Turns into
   * ```graphql
   * {
   *   getPostDocument(relativePath: "") {
   *     data {
   *       title
   *     }
   *   }
   * }
   */
  getOptimizedQuery = async (documentNode: DocumentNode) => {
    const data = await this.request<any>(
      `query GetOptimizedQuery($queryString: String!) {
        getOptimizedQuery(queryString: $queryString)
      }`,
      {
        variables: { queryString: print(documentNode) },
      }
    )
    return parse(data.getOptimizedQuery)
  }

  async request<ReturnType>(
    query: ((gqlTag: typeof gql) => DocumentNode) | string,
    { variables }: { variables: object }
  ): Promise<ReturnType> {
    const res = await fetch(this.contentApiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + (await this.getToken()).id_token,
      },
      body: JSON.stringify({
        query: typeof query === 'function' ? print(query(gql)) : query,
        variables,
      }),
    })

    if (res.status !== 200) {
      let errorMessage = `Unable to complete request, ${res.statusText}`
      const resBody = await res.json()
      if (resBody.message) {
        errorMessage = `${errorMessage}, Response: ${resBody.message}`
      }
      throw new Error(errorMessage)
    }

    const json = await res.json()
    if (json.errors) {
      throw new Error(
        `Unable to fetch, errors: \n\t${json.errors
          .map((error) => error.message)
          .join('\n')}`
      )
      return json
    }
    return json.data as ReturnType
  }

  async syncTinaMedia(): Promise<{ assetsSyncing: string[] }> {
    const res = await this.fetchWithToken(
      `${this.contentApiBase}/assets/${this.clientId}/sync/${this.branch}`,
      { method: 'POST' }
    )
    const jsonRes = await res.json()
    return jsonRes
  }

  async checkSyncStatus({
    assetsSyncing,
  }: {
    assetsSyncing: string[]
  }): Promise<{ assetsSyncing: string[] }> {
    const res = await this.fetchWithToken(
      `${this.assetsApiUrl}/v1/${this.clientId}/syncStatus`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ assetsSyncing: assetsSyncing }),
      }
    )
    const jsonRes = await res.json()
    return jsonRes
  }

  async fetchEvents(
    limit?: number,
    cursor?: string
  ): Promise<{
    events: {
      message: string
      timestamp: number
      id: string
      isError: boolean
      isGlobal: boolean
    }[]
    cursor?: string
  }> {
    if (this.isLocalMode) {
      return {
        events: [],
      }
    } else {
      return (
        await this.fetchWithToken(
          `${this.contentApiBase}/events/${this.clientId}/${
            this.branch
          }?limit=${limit || 1}${cursor ? `&cursor=${cursor}` : ''}`,
          { method: 'GET' }
        )
      ).json()
    }
  }

  parseJwt(token) {
    const base64Url = token.split('.')[1]
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/')
    const jsonPayload = decodeURIComponent(
      atob(base64)
        .split('')
        .map(function (c) {
          return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)
        })
        .join('')
    )
    return JSON.parse(jsonPayload)
  }

  async getRefreshedToken(tokens: string): Promise<TokenObject> {
    const { access_token, id_token, refresh_token } = JSON.parse(tokens)
    const { exp, iss, client_id } = this.parseJwt(access_token)

    // if the token is going to expire within the next two minutes, refresh it now
    if (Date.now() / 1000 >= exp - 120) {
      const refreshResponse = await fetch(iss, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-amz-json-1.1',
          'x-amz-target': 'AWSCognitoIdentityProviderService.InitiateAuth',
        },
        body: JSON.stringify({
          ClientId: client_id,
          AuthFlow: 'REFRESH_TOKEN_AUTH',
          AuthParameters: {
            REFRESH_TOKEN: refresh_token,
            DEVICE_KEY: null,
          },
        }),
      })

      if (refreshResponse.status !== 200) {
        throw new Error('Unable to refresh auth tokens')
      }

      const responseJson = await refreshResponse.json()
      const newToken = {
        access_token: responseJson.AuthenticationResult.AccessToken,
        id_token: responseJson.AuthenticationResult.IdToken,
        refresh_token,
      }
      this.setToken(newToken)

      return Promise.resolve(newToken)
    }

    return Promise.resolve({ access_token, id_token, refresh_token })
  }

  async isAuthorized(): Promise<boolean> {
    return this.isAuthenticated() // TODO - check access
  }

  async isAuthenticated(): Promise<boolean> {
    return !!(await this.getUser())
  }

  async logout() {
    this.setToken(null)
  }

  async authenticate() {
    const token = await authenticate(this.clientId, this.frontendUrl)
    this.setToken(token)
    return token
  }
  /**
   * Wraps the normal fetch function with same API but adds the authorization header token.
   *
   * @example
   * const test = await tinaCloudClient.fetchWithToken(`/mycustomAPI/thing/one`) // the token will be passed in the authorization header
   *
   * @param input fetch function input
   * @param init fetch function init
   */
  async fetchWithToken(
    input: RequestInfo,
    init?: RequestInit
  ): Promise<Response> {
    const headers = init?.headers || {}
    return await fetch(input, {
      ...init,
      headers: new Headers({
        Authorization: 'Bearer ' + (await this.getToken()).id_token,
        ...headers,
      }),
    })
  }

  async getUser() {
    if (!this.clientId) {
      return null
    }

    const url = `${this.identityApiUrl}/v2/apps/${this.clientId}/currentUser`

    try {
      const res = await this.fetchWithToken(url, {
        method: 'GET',
      })
      const val = await res.json()
      if (!res.status.toString().startsWith('2')) {
        console.error(val.error)
        return null
      }
      return val
    } catch (e) {
      console.error(e)
      return null
    }
  }
  async getBillingState() {
    if (!this.clientId) {
      return null
    }

    const url = `${this.identityApiUrl}/v2/apps/${this.clientId}/billing/state`

    try {
      const res = await this.fetchWithToken(url, {
        method: 'GET',
      })
      const val = await res.json()
      if (!res.status.toString().startsWith('2')) {
        console.error(val.error)
        return null
      }
      return {
        clientId: val.clientId || this.clientId,
        delinquencyDate: val.delinquencyDate,
        billingState: val.billingState,
      } as {
        clientId: string
        delinquencyDate: number
        billingState: 'current' | 'late' | 'delinquent'
      }
    } catch (e) {
      console.error(e)
      return null
    }
  }

  async waitForIndexStatus({ ref }: { ref: string }) {
    try {
      const result = await asyncPoll(
        async (): Promise<AsyncData<any>> => {
          try {
            const result = await this.getIndexStatus({ ref })
            if (
              !(result.status === 'inprogress' || result.status === 'unknown')
            ) {
              return Promise.resolve({
                done: true,
                data: result,
              })
            } else {
              return Promise.resolve({
                done: false,
              })
            }
          } catch (err) {
            return Promise.reject(err)
          }
        },
        // interval is 5s
        5000, // interval
        //  timeout is 15 min
        900000 // timeout
      )
      return result
    } catch (error) {
      if (error.message === 'AsyncPoller: reached timeout') {
        console.warn(error)
        return {
          status: 'timeout',
        }
      }
      throw error
    }
  }

  async getIndexStatus({ ref }: { ref: string }) {
    const url = `${this.contentApiBase}/db/${this.clientId}/status/${ref}`
    const res = await this.fetchWithToken(url)
    const result = await res.json()
    const parsedResult = IndexStatusResponse.parse(result)
    return parsedResult
  }

  async listBranches() {
    try {
      const url = `${this.contentApiBase}/github/${this.clientId}/list_branches`
      const res = await this.fetchWithToken(url, {
        method: 'GET',
      })
      const branches = await res.json()
      const parsedBranches = ListBranchResponse.parse(branches)
      const indexStatusPromises = parsedBranches.map(async (branch) => {
        const indexStatus = await this.getIndexStatus({ ref: branch.name })
        return {
          ...branch,
          indexStatus,
        }
      })
      const indexStatus = await Promise.all(indexStatusPromises)

      return indexStatus
    } catch (error) {
      console.error('There was an error listing branches.', error)
      throw error
    }
  }
  async createBranch({ baseBranch, branchName }: BranchData) {
    const url = `${this.contentApiBase}/github/${this.clientId}/create_branch`

    try {
      const res = await this.fetchWithToken(url, {
        method: 'POST',
        body: JSON.stringify({
          baseBranch,
          branchName,
        }),
        headers: {
          'Content-Type': 'application/json',
        },
      })
      return await res.json().then((r) => parseRefForBranchName(r.data.ref))
    } catch (error) {
      console.error('There was an error creating a new branch.', error)
      return null
    }
  }
}

export const DEFAULT_LOCAL_TINA_GQL_SERVER_URL = 'http://localhost:4001/graphql'

const LOCAL_CLIENT_KEY = 'tina.local.isLogedIn'

export class LocalClient extends Client {
  constructor(
    props?: {
      customContentApiUrl?: string
      schema?: Schema
    } & Omit<ServerOptions, 'clientId' | 'branch'>
  ) {
    const clientProps = {
      ...props,
      clientId: '',
      branch: '',
      customContentApiUrl:
        props && props.customContentApiUrl
          ? props.customContentApiUrl
          : DEFAULT_LOCAL_TINA_GQL_SERVER_URL,
    }
    super(clientProps)
  }

  public get isLocalMode() {
    return true
  }

  // These functions allow the local client to have a login state so that we can correctly call the "OnLogin" callback. This is important for things like preview mode
  async logout() {
    localStorage.removeItem(LOCAL_CLIENT_KEY)
  }

  async authenticate() {
    localStorage.setItem(LOCAL_CLIENT_KEY, 'true')
    return { access_token: 'LOCAL', id_token: 'LOCAL', refresh_token: 'LOCAL' }
  }

  async getUser(): Promise<boolean> {
    return localStorage.getItem(LOCAL_CLIENT_KEY) === 'true'
  }
}
