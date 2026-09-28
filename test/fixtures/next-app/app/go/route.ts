import { redirect } from 'next/navigation'
import { withTotallytics } from 'totallytics/next'
import { options } from '../../options'

export const dynamic = 'force-dynamic'

export const GET = withTotallytics(async () => redirect('/users/1'), options)
