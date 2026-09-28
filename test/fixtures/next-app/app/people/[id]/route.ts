import { withTotallytics } from 'totallytics/next'
import { options } from '../../../options'

export const GET = withTotallytics(async () => Response.json({ ok: true }), { ...options, route: '/people/:personId' })
