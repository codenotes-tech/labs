import { pool } from '../db.js'
import type { AuthUser } from '../middleware/authenticate.js'

export class ForbiddenError extends Error {
  status = 403
}

// Throws unless the user's organization owns the project and the user is an
// org admin/owner or a member of that project.
export async function assertProjectAccess(user: AuthUser, projectId: number): Promise<void> {
  const { rows } = await pool.query(
    `SELECT p.org_id,
            EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = p.id AND m.user_id = $2) AS is_member
       FROM projects p WHERE p.id = $1`,
    [projectId, user.id],
  )
  const project = rows[0]
  if (!project || project.org_id !== user.orgId) throw new ForbiddenError('project not found')
  if (user.role === 'member' && !project.is_member) throw new ForbiddenError('not a project member')
}
