import { TabTinError } from './types.js'

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE'

export class HttpClient {
  private baseURL: string
  private token: string
  private timeout: number

  constructor(baseURL: string, token: string, timeout = 30000) {
    this.baseURL = baseURL.replace(/\/$/, '')
    this.token = token
    this.timeout = timeout
  }

  async request<T>(method: HttpMethod, path: string, data?: unknown, query?: Record<string, unknown>): Promise<T> {
    const url = this.buildURL(path, query)
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), this.timeout)

    try {
      const response = await fetch(url, {
        method,
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: data ? JSON.stringify(data) : undefined,
        signal: controller.signal,
      })

      clearTimeout(timeoutId)

      const json = await response.json()

      if (!response.ok) {
        throw new TabTinError(
          json?.message || json?.detail || `HTTP ${response.status}`,
          response.status,
          json?.error_code || 'UNKNOWN',
          json?.detail,
        )
      }

      return this.unwrap<T>(json)
    } catch (error) {
      clearTimeout(timeoutId)
      if (error instanceof TabTinError) throw error
      throw new TabTinError(
        error instanceof Error ? error.message : 'Unknown error',
        0,
        'NETWORK_ERROR',
      )
    }
  }

  get<T>(path: string, query?: Record<string, unknown>): Promise<T> {
    return this.request<T>('GET', path, undefined, query)
  }

  post<T>(path: string, data?: unknown): Promise<T> {
    return this.request<T>('POST', path, data)
  }

  patch<T>(path: string, data?: unknown): Promise<T> {
    return this.request<T>('PATCH', path, data)
  }

  delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path)
  }

  /**
   * POST with FormData body (multipart/form-data).
   * Content-Type is intentionally omitted so the runtime sets the boundary automatically.
   */
  async postForm<T>(path: string, formData: FormData): Promise<T> {
    const url = this.buildURL(path)
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), this.timeout)

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          // Do NOT set Content-Type — FormData sets it with the multipart boundary
        },
        body: formData,
        signal: controller.signal,
      })

      clearTimeout(timeoutId)

      const json = await response.json()

      if (!response.ok) {
        throw new TabTinError(
          json?.message || json?.detail || `HTTP ${response.status}`,
          response.status,
          json?.error_code || 'UNKNOWN',
          json?.detail,
        )
      }

      return this.unwrap<T>(json)
    } catch (error) {
      clearTimeout(timeoutId)
      if (error instanceof TabTinError) throw error
      throw new TabTinError(
        error instanceof Error ? error.message : 'Unknown error',
        0,
        'NETWORK_ERROR',
      )
    }
  }

  private buildURL(path: string, query?: Record<string, unknown>): string {
    const url = `${this.baseURL}${path}`
    if (!query) return url

    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) {
        params.append(key, String(value))
      }
    }
    const qs = params.toString()
    return qs ? `${url}?${qs}` : url
  }

  /** Unwrap TabTin {success, data, ...} envelope */
  private unwrap<T>(json: unknown): T {
    if (
      json &&
      typeof json === 'object' &&
      !Array.isArray(json) &&
      'success' in json
    ) {
      const envelope = json as Record<string, unknown>
      if (!envelope.success) {
        throw new TabTinError(
          String(envelope.message || envelope.code || 'Request failed'),
          0,
          String(envelope.error_code || 'UNKNOWN'),
        )
      }
      if ('data' in envelope) {
        return envelope.data as T
      }
    }
    return json as T
  }
}
