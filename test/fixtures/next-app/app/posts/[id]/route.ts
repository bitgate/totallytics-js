import { notFound } from 'next/navigation'
import { withTotallytics } from 'totallytics/next'
import { options } from '../../../options'

export const GET = withTotallytics(async (_request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params
  if (id === 'missing') notFound()
  return Response.json({ id })
}, options)
