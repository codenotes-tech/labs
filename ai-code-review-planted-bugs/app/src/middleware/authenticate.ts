import type { Request, Response, NextFunction } from 'express'
import { verifySessionToken } from '../auth/session.js'

export interface AuthUser {
  id: number
  orgId: number
  role: 'owner' | 'admin' | 'member'
}

declare global {
  namespace Express {
    interface Request {
      user: AuthUser
    }
  }
}

// Proves who the caller is. It does not check what they may access.
export async function authenticate(req: Request, res: Response, next: NextFunction) {
  const header = req.header('authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  const user = token ? await verifySessionToken(token) : null
  if (!user) return res.status(401).json({ error: 'unauthenticated' })
  req.user = user
  next()
}
