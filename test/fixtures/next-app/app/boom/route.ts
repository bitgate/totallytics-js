import { withTotallytics } from 'totallytics/next'
import { options } from '../../options'

export const POST = withTotallytics(async () => {
  throw new TypeError('kaboom')
}, options)
