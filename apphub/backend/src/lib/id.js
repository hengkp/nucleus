import { randomBytes } from 'node:crypto'

export const newId = (prefix) => `${prefix}-${randomBytes(6).toString('hex')}`
export const newToken = () => randomBytes(24).toString('base64url')
