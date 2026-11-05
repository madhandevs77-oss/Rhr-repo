import { api } from './api'

/** Create or update a draft (an unsubmitted form). Returns the draft's id. */
export async function saveDraft({ id, kind, hallId, customerName, data }) {
  const body = { kind, hallId: hallId || null, customerName: (customerName || '').trim(), data }
  const r = id ? await api.put(`/api/drafts/${id}`, body) : await api.post('/api/drafts', body)
  return r.draft.id
}
