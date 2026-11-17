import { Router } from 'express'
import { z } from 'zod'
import { pool } from '../db.js'
import { assertProjectAccess } from '../auth/permissions.js'

export const projectsRouter = Router()

projectsRouter.get('/', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.id, p.name, p.created_at FROM projects p
      WHERE p.org_id = $1 AND p.archived_at IS NULL
        AND ($2 <> 'member' OR EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = p.id AND m.user_id = $3))
      ORDER BY p.id`,
    [req.user.orgId, req.user.role, req.user.id],
  )
  res.json({ projects: rows })
})

projectsRouter.get('/:projectId', async (req, res) => {
  const projectId = Number(req.params.projectId)
  await assertProjectAccess(req.user, projectId)
  const { rows } = await pool.query('SELECT id, name, created_at, archived_at FROM projects WHERE id = $1', [projectId])
  res.json(rows[0])
})

projectsRouter.get('/:projectId/events', async (req, res) => {
  const projectId = Number(req.params.projectId)
  await assertProjectAccess(req.user, projectId)
  const { rows } = await pool.query(
    'SELECT id, kind, payload, created_at FROM events WHERE project_id = $1 ORDER BY id DESC LIMIT 100',
    [projectId],
  )
  res.json({ events: rows })
})

const renameSchema = z.object({ name: z.string().min(1).max(200) })

projectsRouter.put('/:projectId', async (req, res) => {
  const projectId = Number(req.params.projectId)
  await assertProjectAccess(req.user, projectId)
  const { name } = renameSchema.parse(req.body)
  const { rows } = await pool.query('UPDATE projects SET name = $1 WHERE id = $2 RETURNING id, name', [name, projectId])
  res.json(rows[0])
})

projectsRouter.delete('/:projectId', async (req, res) => {
  const projectId = Number(req.params.projectId)
  await assertProjectAccess(req.user, projectId)
  await pool.query('UPDATE projects SET archived_at = now() WHERE id = $1', [projectId])
  res.status(204).end()
})
