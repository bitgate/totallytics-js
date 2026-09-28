import { withTotallytics } from 'totallytics/next'
import { options } from '../../options'

export const revalidate = 1

export const GET = withTotallytics(async () => Response.json({ builtAt: Date.now() }), options)
