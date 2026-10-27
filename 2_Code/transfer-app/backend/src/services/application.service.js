import { v4 as uuidv4 } from 'uuid';
import { query } from '../config/db.js';
import { generateReferenceNumber } from '../utils/reference-number.js';
import { log as auditLog } from './audit.service.js';
import * as notificationService from './notification.service.js';
import * as eligibilityService from './eligibility.service.js';
import { evaluateApplication } from './ai/azure-foundry.service.js';
import { notFound, badRequest, forbidden } from '../utils/errors.js';

export async function createApplication(data, source = 'website', createdBy = null) {
  const referenceNumber = await generateReferenceNumber();
  const secureToken = uuidv4();

  const result = await query(
    `INSERT INTO applications (
       reference_number, source, status, student_name, student_email,
       student_phone, date_of_birth, transfer_from_institution, transfer_from_program,
       transfer_to_program, transfer_to_department, expected_start_term,
       academic_history, personal_statement, additional_info, secure_token,
       created_by, student_profile_id, policy_version
     ) VALUES ($1, $2, 'draft', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
     RETURNING *`,
    [referenceNumber, source, data.student_name, data.student_email, data.student_phone || null,
     data.date_of_birth || null, data.transfer_from_institution, data.transfer_from_program || null,
     data.transfer_to_program, data.transfer_to_department || null, data.expected_start_term || null,
     JSON.stringify(data.academic_history || {}), data.personal_statement || null,
     JSON.stringify(data.additional_info || {}), secureToken, createdBy,
     data.student_profile_id || null, '1.0']
  );

  const application = result.rows[0];

  // Staff-raised applications are filed on the student's behalf, so they're submitted straight away too
  await updateApplicationStatus(application.id, 'submitted', createdBy,
    source === 'evaluator_submitted' ? 'Application raised by staff' : 'Application received');
  application.status = 'submitted';

  await auditLog({ applicationId: application.id, action: 'application_created', actorId: createdBy, actorEmail: data.student_email, newValue: { reference_number: referenceNumber, source, status: application.status }, details: { source } });
  await notificationService.applicationSubmitted(application);
  return application;
}

export async function getApplicationById(id) {
  const appResult = await query(
    `SELECT a.*, p.full_name AS evaluator_name, p.email AS evaluator_email, e.department AS evaluator_department
     FROM applications a LEFT JOIN evaluators e ON e.id = a.assigned_evaluator_id LEFT JOIN profiles p ON p.id = a.assigned_evaluator_id
     WHERE a.id = $1 LIMIT 1`,
    [id]
  );
  if (appResult.rows.length === 0) throw notFound('Application');
  const application = appResult.rows[0];

  const [evalResult, docsResult, infoResult, auditResult] = await Promise.all([
    query(`SELECT * FROM ai_evaluations WHERE application_id = $1 ORDER BY created_at DESC LIMIT 1`, [id]),
    query(`SELECT ad.*, p.full_name AS uploaded_by_name FROM application_documents ad LEFT JOIN profiles p ON p.id = ad.uploaded_by WHERE ad.application_id = $1 ORDER BY ad.created_at ASC`, [id]),
    query(`SELECT ir.*, p.full_name AS requested_by_name FROM information_requests ir LEFT JOIN profiles p ON p.id = ir.requested_by WHERE ir.application_id = $1 ORDER BY ir.created_at DESC`, [id]),
    query(`SELECT al.*, p.full_name AS actor_name FROM audit_logs al LEFT JOIN profiles p ON p.id = al.actor_id WHERE al.application_id = $1 ORDER BY al.created_at DESC LIMIT 20`, [id]),
  ]);

  application.latest_ai_evaluation = evalResult.rows[0] || null;
  application.documents = docsResult.rows;
  application.information_requests = infoResult.rows;
  application.recent_audit = auditResult.rows;
  return application;
}

export async function listApplications({ status, source, search, assignedEvaluatorId, page = 1, limit = 20, sort = 'created_at', order = 'DESC' } = {}) {
  const conditions = [];
  const params = [];
  let idx = 1;

  if (status) { conditions.push(`a.status = $${idx++}`); params.push(status); }
  if (source) { conditions.push(`a.source = $${idx++}`); params.push(source); }
  if (assignedEvaluatorId) { conditions.push(`a.assigned_evaluator_id = $${idx++}`); params.push(assignedEvaluatorId); }
  if (search) {
    conditions.push(`(a.student_name ILIKE $${idx} OR a.student_email ILIKE $${idx} OR a.reference_number ILIKE $${idx} OR a.transfer_from_institution ILIKE $${idx})`);
    params.push(`%${search}%`); idx++;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const allowedSortCols = ['created_at', 'submitted_at', 'status', 'student_name', 'reference_number'];
  const sortCol = allowedSortCols.includes(sort) ? sort : 'created_at';
  const sortDir = order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  const offset = (page - 1) * limit;

  const [dataResult, countResult] = await Promise.all([
    query(
      `SELECT a.id, a.reference_number, a.source, a.status, a.student_name, a.student_email,
              a.transfer_from_institution, a.transfer_to_program, a.transfer_to_department,
              a.expected_start_term, a.submitted_at, a.final_decision, a.decision_date,
              a.assigned_evaluator_id, a.created_at, a.updated_at, p.full_name AS evaluator_name,
              ae.confidence_score AS ai_confidence_score
       FROM applications a
       LEFT JOIN profiles p ON p.id = a.assigned_evaluator_id
       LEFT JOIN LATERAL (
         SELECT confidence_score FROM ai_evaluations
         WHERE application_id = a.id AND status = 'completed'
         ORDER BY created_at DESC LIMIT 1
       ) ae ON true
       ${where} ORDER BY a.${sortCol} ${sortDir} LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset]
    ),
    query(`SELECT COUNT(*) AS total FROM applications a ${where}`, params),
  ]);

  const total = parseInt(countResult.rows[0].total, 10);
  return { applications: dataResult.rows, total, page, limit, pages: Math.ceil(total / limit) };
}

export async function triggerEvaluation(applicationId, triggeredBy) {
  const appResult = await query(`SELECT * FROM applications WHERE id = $1 LIMIT 1`, [applicationId]);
  if (appResult.rows.length === 0) throw notFound('Application');

  const evalResult = await query(
    `INSERT INTO ai_evaluations (application_id, status, policy_version, attempt_number) VALUES ($1, 'pending', '1.0', 1) RETURNING *`,
    [applicationId]
  );
  const evaluation = evalResult.rows[0];

  await updateApplicationStatus(applicationId, 'under_evaluation', triggeredBy, 'AI evaluation triggered');
  await auditLog({ applicationId, action: 'evaluation_triggered', actorId: triggeredBy, details: { evaluation_id: evaluation.id } });

  setImmediate(() => {
    runEvaluation(evaluation.id).catch((err) => {
      console.error(`[AI] Background evaluation failed for eval ${evaluation.id}:`, err.message);
    });
  });

  return { evaluation_id: evaluation.id, status: 'pending' };
}

export async function runEvaluation(evaluationId) {
  await query(`UPDATE ai_evaluations SET status = 'running', started_at = NOW() WHERE id = $1`, [evaluationId]);
  let applicationId;

  try {
    const evalRow = await query(`SELECT * FROM ai_evaluations WHERE id = $1 LIMIT 1`, [evaluationId]);
    if (evalRow.rows.length === 0) throw new Error(`Evaluation record ${evaluationId} not found`);
    applicationId = evalRow.rows[0].application_id;

    const [appResult, docsResult] = await Promise.all([
      query(`SELECT * FROM applications WHERE id = $1 LIMIT 1`, [applicationId]),
      query(`SELECT * FROM application_documents WHERE application_id = $1`, [applicationId]),
    ]);

    const application = appResult.rows[0];
    const documents = docsResult.rows;
    const criteria = await eligibilityService.getCriteria();
    const result = await evaluateApplication(application, documents, criteria);

    await query(
      `UPDATE ai_evaluations SET status = 'completed', criteria_results = $1, missing_documents = $2, flags = $3, recommendations = $4, evaluation_report = $5, confidence_score = $6, completed_at = NOW() WHERE id = $7`,
      [JSON.stringify(result.criteria_results), JSON.stringify(result.missing_documents), JSON.stringify(result.flags), result.recommendations, result.evaluation_report, result.confidence_score, evaluationId]
    );

    await updateApplicationStatus(applicationId, 'evaluation_completed', null, 'AI evaluation completed');
    await notificationService.evaluationComplete(application, evaluationId);
    console.log(`[AI] Evaluation ${evaluationId} completed successfully`);
  } catch (err) {
    console.error(`[AI] Evaluation ${evaluationId} failed:`, err.message);
    await query(`UPDATE ai_evaluations SET status = 'failed', error_message = $1, completed_at = NOW() WHERE id = $2`, [err.message, evaluationId]);
    if (applicationId) await auditLog({ applicationId, action: 'evaluation_failed', details: { evaluation_id: evaluationId, error: err.message } });
  }
}

export async function submitDecision(applicationId, decision, comments, evaluatorId) {
  if (!['approved', 'rejected'].includes(decision)) throw badRequest('Decision must be "approved" or "rejected"');

  const appResult = await query(`SELECT * FROM applications WHERE id = $1 LIMIT 1`, [applicationId]);
  if (appResult.rows.length === 0) throw notFound('Application');
  const application = appResult.rows[0];

  if (application.assigned_evaluator_id && application.assigned_evaluator_id !== evaluatorId) {
    const profileResult = await query(`SELECT role FROM profiles WHERE id = $1 LIMIT 1`, [evaluatorId]);
    if (profileResult.rows[0]?.role !== 'admin') throw forbidden('Only the assigned evaluator or admin may submit a decision');
  }

  const oldStatus = application.status;
  await query(
    `UPDATE applications SET final_decision = $1, evaluator_comments = $2, decision_date = NOW(), status = $3, updated_at = NOW() WHERE id = $4`,
    [decision, comments, decision, applicationId]
  );

  await auditLog({ applicationId, action: 'decision_submitted', actorId: evaluatorId, oldValue: { status: oldStatus }, newValue: { status: decision, final_decision: decision }, details: { comments } });
  const updatedApp = { ...application, status: decision, final_decision: decision };
  await notificationService.decisionMade(updatedApp);
}

export async function createInfoRequest(applicationId, items, message, evaluatorId) {
  const appResult = await query(`SELECT * FROM applications WHERE id = $1 LIMIT 1`, [applicationId]);
  if (appResult.rows.length === 0) throw notFound('Application');
  const application = appResult.rows[0];

  const infoResult = await query(
    `INSERT INTO information_requests (application_id, requested_by, items, message) VALUES ($1, $2, $3, $4) RETURNING *`,
    [applicationId, evaluatorId, JSON.stringify(items), message]
  );
  const infoRequest = infoResult.rows[0];

  await updateApplicationStatus(applicationId, 'information_required', evaluatorId, 'Information requested from student');
  await notificationService.infoRequired(application, infoRequest.id);
  await auditLog({ applicationId, action: 'info_request_created', actorId: evaluatorId, details: { info_request_id: infoRequest.id, item_count: items.length } });
  return infoRequest;
}

export async function updateApplicationStatus(applicationId, newStatus, actorId = null, reason = '') {
  const current = await query(`SELECT status FROM applications WHERE id = $1 LIMIT 1`, [applicationId]);
  const oldStatus = current.rows[0]?.status;

  await query(`UPDATE applications SET status = $1, updated_at = NOW() WHERE id = $2`, [newStatus, applicationId]);
  if (newStatus === 'submitted') {
    await query(`UPDATE applications SET submitted_at = NOW() WHERE id = $1 AND submitted_at IS NULL`, [applicationId]);
  }
  await auditLog({ applicationId, action: 'status_changed', actorId, oldValue: { status: oldStatus }, newValue: { status: newStatus }, details: { reason } });
}

export async function addNote(applicationId, note, actorId, actorEmail) {
  await query(
    `UPDATE applications
     SET additional_info = jsonb_set(
       COALESCE(additional_info, '{}'),
       '{evaluator_notes}',
       COALESCE(additional_info->'evaluator_notes', '[]') ||
       jsonb_build_array(jsonb_build_object('note', $1::text, 'created_at', to_char(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'created_by_id', $2::text))
     ), updated_at = NOW()
     WHERE id = $3`,
    [note, actorId || '', applicationId]
  );
  await auditLog({ applicationId, action: 'note_added', actorId, actorEmail, details: { note_preview: note.slice(0, 50) } });
}

export async function assignEvaluator(applicationId, evaluatorId, assignedBy) {
  await query(`UPDATE applications SET assigned_evaluator_id = $1, updated_at = NOW() WHERE id = $2`, [evaluatorId, applicationId]);
  await auditLog({ applicationId, action: 'evaluator_assigned', actorId: assignedBy, newValue: { assigned_evaluator_id: evaluatorId } });
}

export default { createApplication, getApplicationById, listApplications, triggerEvaluation, runEvaluation, submitDecision, createInfoRequest, updateApplicationStatus, assignEvaluator, addNote };
