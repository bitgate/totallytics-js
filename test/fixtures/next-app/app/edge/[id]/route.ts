import { withTotallytics } from 'totallytics/next'
import { options } from '../../../options'

export const runtime = 'edge'

export const GET = withTotallytics(
  async (_request: Request, { params }: { params: Promise<{ id: string }> }) => Response.json(await params),
  options,
)
