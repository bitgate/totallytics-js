import type { NextRequest } from 'next/server'
import { withTotallytics } from 'totallytics/next'
import { options } from '../../../../../options'

export const GET = withTotallytics(
  async (request: NextRequest, { params }: { params: Promise<{ org: string; repo: string }> }) =>
    Response.json({ ...(await params), path: request.nextUrl.pathname }),
  options,
)
