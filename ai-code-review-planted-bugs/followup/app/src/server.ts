import express from 'express'
import { authenticate } from './middleware/authenticate.js'
import { authRouter } from './routes/auth.js'
import { projectsRouter } from './routes/projects.js'
import { invoicesRouter } from './routes/invoices.js'
import { couponsRouter } from './routes/coupons.js'
import { paymentsRouter } from './routes/payments.js'
import { logger } from './lib/logger.js'

const app = express()
app.use(express.json({ limit: '1mb' }))

app.use('/auth', authRouter)

app.use(authenticate)
app.use('/projects', projectsRouter)
app.use('/invoices', invoicesRouter)
app.use('/coupons', couponsRouter)
app.use('/payments', paymentsRouter)

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error('unhandled error', { message: err.message })
  res.status(500).json({ error: 'internal_error' })
})

app.listen(Number(process.env.PORT ?? 3000), () => logger.info('api listening'))
