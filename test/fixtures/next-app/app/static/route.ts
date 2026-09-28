import { withTotallytics } from 'totallytics/next'
import { options } from '../../options'

export const dynamic = 'force-static'

export const GET = withTotallytics(async () => Response.json({ builtAt: Date.now() }), options)
