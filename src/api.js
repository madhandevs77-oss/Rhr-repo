// Thin client for the RHR server. Session lives in an HttpOnly cookie; every write carries X-Requested-With (CSRF guard).
export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message || `Request failed (${status})`)
    this.status = status
    this.code = body?.error?.code || 'ERROR'
    this.details = body?.error?.details
  }
}

let onUnauthorized = () => {}
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn }

async function request(method, path, body, { signal } = {}) {
  const headers = { 'X-Requested-With': 'rhr', Accept: 'application/json' }
  let payload
  if (body instanceof FormData) payload = body
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body) }
  let res
  try {
    res = await fetch(path, { method, headers, body: payload, credentials: 'same-origin', signal })
  } catch (e) {
    if (e.name === 'AbortError') throw e
    throw new ApiError(0, { error: { code: 'NETWORK', message: 'Cannot reach the server. Check your connection and try again.' } })
  }
  let json = null
  const text = await res.text()
  try { json = text ? JSON.parse(text) : null } catch { json = null }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth/login')) onUnauthorized()
    throw new ApiError(res.status, json)
  }
  return json
}

const qs = (o = {}) => {
  const p = new URLSearchParams()
  Object.entries(o).forEach(([k, v]) => v !== undefined && v !== null && v !== '' && p.set(k, v))
  const s = p.toString()
  return s ? `?${s}` : ''
}

export const api = {
  get: (p, params, o) => request('GET', p + qs(params), undefined, o),
  post: (p, b = {}) => request('POST', p, b),
  put: (p, b) => request('PUT', p, b),
  patch: (p, b) => request('PATCH', p, b),
  del: (p) => request('DELETE', p),
  /** multipart upload with progress (fetch cannot report upload progress) */
  upload(path, formData, { onProgress, method = 'POST' } = {}) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest()
      x.open(method, path)
      x.setRequestHeader('X-Requested-With', 'rhr')
      x.setRequestHeader('Accept', 'application/json')
      x.upload.onprogress = (e) => e.lengthComputable && onProgress?.(Math.round((e.loaded / e.total) * 100))
      x.onerror = () => reject(new ApiError(0, { error: { code: 'NETWORK', message: 'Upload failed — connection lost.' } }))
      x.onload = () => {
        let json = null
        try { json = JSON.parse(x.responseText) } catch { json = null }
        if (x.status >= 200 && x.status < 300) resolve(json)
        else { if (x.status === 401) onUnauthorized(); reject(new ApiError(x.status, json)) }
      }
      x.send(formData)
    })
  },
}

export const errMsg = (e) => (e instanceof ApiError || e?.message ? e.message : 'Something went wrong')
