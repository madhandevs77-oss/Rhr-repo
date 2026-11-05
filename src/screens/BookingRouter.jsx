import { api } from '../api'
import { Async } from '../components/common'
import { useLoad } from '../store'
import SectionBooking from './SectionBooking'

/** One booking form for every hall (Mandapam, Mini Hall, any hall added later, and the Outsource sections). Opens a saved draft when given one. */
export default function BookingRouter({ nav, id, hallId, draftId }) {
  const detail = useLoad(() => (id ? api.get(`/api/bookings/${id}`) : Promise.resolve({ booking: null })), [id])
  const draft = useLoad(() => (draftId ? api.get(`/api/drafts/${draftId}`) : Promise.resolve({ draft: null, data: null })), [draftId])
  return (
    <Async res={detail}>
      {({ booking }) => <Async res={draft}>{(dr) => <SectionBooking nav={nav} editing={booking} hallId={hallId} draft={dr.draft ? { id: dr.draft.id, data: dr.data } : null} />}</Async>}
    </Async>
  )
}
