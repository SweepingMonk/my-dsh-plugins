/**
 * Exa-backed web access for the DeepSeek Harness.
 *
 * This plugin registers two providers into the host `ctx.web` seam:
 *
 * - `exa-search`  — Exa POST /search, exposed through the stock `web_search` tool.
 * - `exa-fetch`   — Exa POST /contents, exposed through the stock `web_fetch` tool.
 *
 * The model-facing contract (tool names, argument schemas, prompt guidance,
 * HTML→markdown conversion, result caps, and the `web` result cards) belongs to
 * `@deepseek-ai/dsh-tool-web` and is deliberately untouched. Only the backend
 * that executes the operation changes.
 *
 * @module dsh-plugin-web-search-exa
 */

import z from '@deepseek-ai/schemastery'
import { WebError } from '@deepseek-ai/dsh-web'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-exa'

/** The web seam both providers register into. */
export const inject = ['web']

/** Stable ids pinned by this bundle's patch. */
export const EXA_SEARCH_PROVIDER_ID = 'exa-search'
export const EXA_FETCH_PROVIDER_ID = 'exa-fetch'

/** Default Exa REST origin. */
const DEFAULT_BASE_URL = 'https://api.exa.ai'

/** Product user agent sent with every request. */
const USER_AGENT = 'deepseek-harness-web-search-exa/0.1.0'

/** Refuse to buffer an upstream response larger than this, in characters. */
const MAX_RESPONSE_CHARS = 8_000_000

/** Search types accepted by Exa's /search endpoint. */
const SEARCH_TYPES = new Set(['auto', 'neural', 'keyword', 'fast', 'instant', 'deep'])

export const Config = z.object({
  apiKey: z.string().role('secret').default(''),
  apiKeyEnv: z.string().role('credential-ref').default('EXA_API_KEY'),
  baseURL: z.string().default(DEFAULT_BASE_URL),
  timeoutMs: z.number().step(1).min(1).default(25000),
  searchType: z.string().default('auto'),
  searchNumResults: z.number().step(1).min(1).max(100).default(8),
  searchHighlights: z.boolean().default(true),
  searchSummaries: z.boolean().default(false),
  searchMaxSnippetChars: z.number().step(1).min(1).default(600),
  searchIncludeDomains: z.array(z.string()).default([]),
  searchExcludeDomains: z.array(z.string()).default([]),
  fetchMaxCharacters: z.number().step(1).min(1).default(100000),
  fetchMaxAgeHours: z.number().step(1).min(-1).default(0),
  fetchLivecrawlTimeoutMs: z.number().step(1).min(1).default(15000),
})

/**
 * Exa's search provider. `available()` is a local, synchronous configuration
 * check; the API key is resolved per operation so a key stored or rotated
 * through the credentials service reaches the next search without a restart.
 */
class ExaSearchProvider {
  id = EXA_SEARCH_PROVIDER_ID

  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - provider context.
   * @param {z.infer<typeof Config>} config - resolved plugin config.
   */
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
  }

  /** @returns {boolean} whether the endpoint is parseable; never checks a secret value. */
  available() {
    return URL.canParse(this.config.baseURL)
  }

  /**
   * Run one Exa search.
   *
   * @param {{ query: string, maxResults?: number }} request - the seam request.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<{ sources: Array<{ url: string, title?: string, snippet?: string, summary?: string, publishedAt?: string }>, truncated: boolean }>}
   */
  async search(request, signal) {
    throwIfAborted(signal)
    const config = this.config
    const query = typeof request.query === 'string' ? request.query.trim() : ''
    if (query.length === 0) throw new WebError('Exa search requires a non-empty query', 'WEB_PROVIDER_ERROR')

    const count = request.maxResults === undefined
      ? config.searchNumResults
      : Math.min(config.searchNumResults, request.maxResults)
    if (!Number.isInteger(count) || count < 1) {
      throw new WebError(`Exa search received an invalid result limit: ${String(request.maxResults)}`, 'WEB_PROVIDER_ERROR')
    }

    const contents = {}
    if (config.searchHighlights) contents.highlights = true
    if (config.searchSummaries) contents.summary = { query }

    const body = {
      query,
      type: config.searchType,
      numResults: count,
      ...(Object.keys(contents).length > 0 ? { contents } : {}),
      ...(config.searchIncludeDomains.length > 0 ? { includeDomains: config.searchIncludeDomains } : {}),
      ...(config.searchExcludeDomains.length > 0 ? { excludeDomains: config.searchExcludeDomains } : {}),
    }

    const payload = await postJson(this.ctx, config, '/search', body, signal)
    return mapSearchResponse(payload, config)
  }
}

/**
 * Exa's contents provider, used by `web_fetch`.
 *
 * Exa returns extracted page text and does not expose the target's HTTP status
 * or its redirect chain, so a successful extraction is reported as HTTP 200 at
 * the requested URL — the same contract the shipped DeepSeek Fetch API provider
 * follows. The body is already markdown-shaped, so it is declared as `text`;
 * `dsh-tool-web` must not run its HTML→markdown conversion over it.
 */
class ExaFetchProvider {
  id = EXA_FETCH_PROVIDER_ID

  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - provider context.
   * @param {z.infer<typeof Config>} config - resolved plugin config.
   */
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
  }

  /** @returns {boolean} whether the endpoint is parseable; never checks a secret value. */
  available() {
    return URL.canParse(this.config.baseURL)
  }

  /**
   * Retrieve one URL's readable content.
   *
   * @param {{ url: string }} request - the seam request.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<{ url: string, statusCode: number, body: { kind: 'text', content: string }, truncated: boolean }>}
   */
  async fetch(request, signal) {
    throwIfAborted(signal)
    const config = this.config
    const url = typeof request.url === 'string' ? request.url.trim() : ''
    if (!isHttpUrl(url)) throw new WebError(`Exa fetch requires an http(s) URL: ${url}`, 'WEB_INVALID_URL')

    const payload = await postJson(this.ctx, config, '/contents', {
      ids: [url],
      text: { maxCharacters: config.fetchMaxCharacters },
      maxAgeHours: config.fetchMaxAgeHours,
      livecrawlTimeout: config.fetchLivecrawlTimeoutMs,
    }, signal)
    return mapContentsResponse(payload, url, config)
  }
}

/**
 * Validate the immutable config once, then register both providers. The
 * registrations are fiber-scoped, so disabling or removing this plugin also
 * removes both provider ids from `ctx.web`.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {z.infer<typeof Config>} config - validated plugin config.
 */
export function apply(ctx, config) {
  if (!URL.canParse(config.baseURL)) {
    throw new Error(`web-search-exa: baseURL is not a valid URL: ${config.baseURL}`)
  }
  if (!SEARCH_TYPES.has(config.searchType)) {
    throw new Error(`web-search-exa: searchType must be one of ${[...SEARCH_TYPES].join(', ')}`)
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.apiKeyEnv)) {
    throw new Error(`web-search-exa: apiKeyEnv must be an environment variable name`)
  }
  ctx.web.registerSearchProvider(new ExaSearchProvider(ctx, config))
  ctx.web.registerFetchProvider(new ExaFetchProvider(ctx, config))
}

/**
 * Project an Exa /search response into the seam's result vocabulary.
 *
 * @param {unknown} payload - untrusted JSON from Exa.
 * @param {z.infer<typeof Config>} config - resolved plugin config.
 * @returns {{ sources: Array<Record<string, string>>, truncated: boolean }} the seam result.
 */
function mapSearchResponse(payload, config) {
  if (!isRecord(payload) || !Array.isArray(payload.results)) {
    throw new WebError('Exa returned an invalid search response', 'WEB_PROVIDER_ERROR')
  }
  const sources = []
  const seen = new Set()
  for (const item of payload.results) {
    if (!isRecord(item) || typeof item.url !== 'string' || !isHttpUrl(item.url) || seen.has(item.url)) continue
    seen.add(item.url)
    const source = { url: item.url }
    const title = nonEmptyString(item.title)
    if (title !== undefined) source.title = title
    const snippet = snippetOf(item, config.searchMaxSnippetChars)
    if (snippet !== undefined) source.snippet = snippet
    if (config.searchSummaries) {
      const summary = nonEmptyString(item.summary)
      if (summary !== undefined) source.summary = summary
    }
    const publishedAt = dateOf(item.publishedDate)
    if (publishedAt !== undefined) source.publishedAt = publishedAt
    sources.push(source)
  }
  return { sources, truncated: false }
}

/**
 * Project an Exa /contents response into the seam's fetch result.
 *
 * @param {unknown} payload - untrusted JSON from Exa.
 * @param {string} requestedUrl - the URL the caller asked for.
 * @param {z.infer<typeof Config>} config - resolved plugin config.
 * @returns {{ url: string, statusCode: number, body: { kind: 'text', content: string }, truncated: boolean }} the seam result.
 */
function mapContentsResponse(payload, requestedUrl, config) {
  if (!isRecord(payload) || !Array.isArray(payload.results)) {
    throw new WebError('Exa returned an invalid contents response', 'WEB_PROVIDER_ERROR')
  }
  const statuses = Array.isArray(payload.statuses) ? payload.statuses.filter(isRecord) : []
  const status = statuses.length === 1
    ? statuses[0]
    : statuses.find((candidate) => candidate.id === requestedUrl)
  if (status !== undefined && status.status !== 'success') {
    const detail = nonEmptyString(status.error)
    throw new WebError(
      `Exa could not retrieve ${requestedUrl}${detail === undefined ? '' : `: ${detail}`}`,
      'WEB_PROVIDER_ERROR',
    )
  }
  const results = payload.results.filter(isRecord)
  const result = results.length === 1
    ? results[0]
    : results.find((candidate) => candidate.url === requestedUrl || candidate.id === requestedUrl) ?? results[0]
  if (result === undefined) {
    throw new WebError(`Exa returned no content for ${requestedUrl}`, 'WEB_PROVIDER_ERROR')
  }
  const content = typeof result.text === 'string' ? result.text : ''
  if (content.trim().length === 0) {
    throw new WebError(`Exa returned empty content for ${requestedUrl}`, 'WEB_PROVIDER_ERROR')
  }
  return {
    url: typeof result.url === 'string' && result.url.length > 0 ? result.url : requestedUrl,
    statusCode: 200,
    body: { kind: 'text', content },
    truncated: content.length >= config.fetchMaxCharacters,
  }
}

/**
 * Resolve the API key for one operation without retaining it on the provider.
 * The managed credentials service is authoritative and itself layers the
 * launching environment, project `.env`, and user `.env` underneath; the
 * launch-environment lookup is the fallback when that service is absent.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - provider context.
 * @param {z.infer<typeof Config>} config - resolved plugin config.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @returns {Promise<string | undefined>} the key, or undefined when none is configured.
 */
async function resolveApiKey(ctx, config, signal) {
  if (config.apiKey !== undefined && config.apiKey.length > 0) return config.apiKey
  const ref = credentialRef(config.apiKeyEnv)
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    try {
      const resolved = await credentials.resolve(ref)
      if (resolved !== undefined && resolved.value.length > 0) return resolved.value
    } catch (error) {
      throwIfAborted(signal)
      throw new WebError(`Exa credential resolution failed: ${describeError(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }
  const ambient = launchEnvironmentOf(ctx).get(ref)
  if (ambient !== undefined && ambient.value.length > 0) return ambient.value
  return undefined
}

/**
 * POST one JSON request to Exa and decode the response.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - provider context.
 * @param {z.infer<typeof Config>} config - resolved plugin config.
 * @param {string} path - endpoint path, such as `/search`.
 * @param {Record<string, unknown>} body - JSON request body.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @returns {Promise<unknown>} parsed JSON.
 */
async function postJson(ctx, config, path, body, signal) {
  const apiKey = await resolveApiKey(ctx, config, signal)
  if (apiKey === undefined) throw missingApiKey(config)
  throwIfAborted(signal)

  const endpoint = `${config.baseURL.replace(/\/+$/u, '')}${path}`
  const timeout = AbortSignal.timeout(config.timeoutMs)
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])

  let response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'x-api-key': apiKey,
        'content-type': 'application/json',
        'accept': 'application/json',
        'user-agent': USER_AGENT,
      },
      body: JSON.stringify(body),
      signal: combined,
    })
  } catch (error) {
    if (signal?.aborted === true) throw aborted(signal, error)
    if (timeout.aborted) {
      throw new WebError(`Exa request timed out after ${config.timeoutMs}ms`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
    throw new WebError(`Exa request failed: ${describeError(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
  }

  if (signal?.aborted === true) throw aborted(signal)
  const text = await readResponseText(response, signal)
  if (!response.ok) {
    const detail = errorDetail(text)
    throw new WebError(
      `Exa API error (HTTP ${response.status})${detail === undefined ? '' : `: ${detail}`}`,
      response.status === 401 || response.status === 403 ? 'WEB_PROVIDER_CREDENTIAL_MISSING' : 'WEB_PROVIDER_ERROR',
    )
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new WebError('Exa returned invalid JSON', 'WEB_PROVIDER_ERROR', { cause: error })
  }
}

/**
 * Build the actionable missing-key failure. `available()` intentionally does
 * not check the secret value, so this error is how a keyless deployment learns
 * what to configure instead of seeing a generic "provider unavailable".
 *
 * @param {z.infer<typeof Config>} config - resolved plugin config.
 * @returns {WebError} the structured failure.
 */
function missingApiKey(config) {
  return new WebError(
    `Exa has no API key. Set ${config.apiKeyEnv} in the launching environment (or ~/.dsh/.env), or set "apiKey" in the web-search-exa plugin config, then retry.`,
    'WEB_PROVIDER_CREDENTIAL_MISSING',
  )
}

/**
 * Read a response body under the size bound, mapping cancellation and oversize
 * failures to stable web errors.
 *
 * @param {Response} response - the upstream response.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @returns {Promise<string>} the body text.
 */
async function readResponseText(response, signal) {
  let text
  try {
    text = await response.text()
  } catch (error) {
    if (signal?.aborted === true) throw aborted(signal, error)
    throw new WebError(`Exa response read failed: ${describeError(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
  }
  if (text.length > MAX_RESPONSE_CHARS) {
    throw new WebError(`Exa response exceeded ${MAX_RESPONSE_CHARS} characters`, 'WEB_PROVIDER_ERROR')
  }
  return text
}

/** Throw the provider's stable cancellation error when the caller already aborted. */
function throwIfAborted(signal) {
  if (signal?.aborted === true) throw aborted(signal)
}

/** Build the provider's stable cancellation error while retaining the caller's reason. */
function aborted(signal, fallback) {
  return new WebError('Exa web request aborted', 'WEB_ABORTED', {
    cause: signal?.aborted === true ? signal.reason : fallback,
  })
}

/** Render one error without leaking a response body or a credential. */
function describeError(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Extract a short, human-readable upstream error detail.
 *
 * @param {string} text - response body text.
 * @returns {string | undefined} the detail, capped for the tool result.
 */
function errorDetail(text) {
  const trimmed = text.trim()
  if (trimmed.length === 0) return undefined
  try {
    const parsed = JSON.parse(trimmed)
    if (isRecord(parsed)) {
      const detail = typeof parsed.error === 'string'
        ? parsed.error
        : typeof parsed.message === 'string' ? parsed.message : undefined
      if (detail !== undefined && detail.length > 0) return clip(detail.replace(/\s+/gu, ' '), 500)
    }
  } catch {
    // Not JSON: fall through to the bounded raw text.
  }
  return clip(trimmed.replace(/\s+/gu, ' '), 500)
}

/** Whether a value is a plain, non-array object. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether a string is an absolute http(s) URL. */
function isHttpUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** Trimmed non-empty string, or undefined. */
function nonEmptyString(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Build one source excerpt: joined highlights when Exa returned them, else the
 * page text prefix, whitespace-collapsed and clipped to the configured cap.
 */
function snippetOf(item, maxChars) {
  const highlights = Array.isArray(item.highlights)
    ? item.highlights.filter((highlight) => typeof highlight === 'string' && highlight.trim().length > 0)
    : []
  const raw = highlights.length > 0
    ? highlights.join(' … ')
    : typeof item.text === 'string' ? item.text : ''
  const collapsed = raw.replace(/\s+/gu, ' ').trim()
  if (collapsed.length === 0) return undefined
  return clip(collapsed, maxChars)
}

/** Reduce an ISO timestamp to its calendar date; omit unparseable values. */
function dateOf(value) {
  if (typeof value !== 'string') return undefined
  const match = /^(\d{4}-\d{2}-\d{2})/u.exec(value)
  return match === null ? undefined : match[1]
}

/** Clip text to a character count without splitting a surrogate pair. */
function clip(text, max) {
  if (text.length <= max) return text
  return `${Array.from(text).slice(0, Math.max(1, max - 1)).join('')}…`
}
