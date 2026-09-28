import { withTotallytics } from 'totallytics/next'
import { options } from '../../../options'

export const GET = withTotallytics(
  async (_request: Request, { params }: { params: Promise<{ path: string[] }> }) => Response.json(await params),
  options,
)
