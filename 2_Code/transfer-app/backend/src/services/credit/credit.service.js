import { query } from '../../config/db.js';
import { createEngine, ENGINE_VERSION } from './engine.js';
import { parseTranscript } from './transcript-parser.js';

let enginePromise = null;

/** Builds the engine from the reference tables once, then reuses it. */
async function getEngine() {
  if (!enginePromise) {
    enginePromise = (async () => {
      const [catalog, equivalencies, decisions] = await Promise.all([
        query(`SELECT institution, course_code, title, program, level, description, learning_outcomes, syllabus FROM catalog_courses`),
        query(`SELECT eq_id, institution, course_code, bu_course, outcome FROM equivalencies`),
        query(`SELECT decision_id, institution, course_code, proposed_bu, decision, bu_awarded, reason, TO_CHAR(decided_on, 'YYYY-MM-DD') AS decided_on FROM past_decisions`),
      ]);
      if (catalog.rows.length === 0) throw new Error('Transfer credit reference data is not loaded. Run `npm run db:seed:credit`.');
      return createEngine({
        catalog: catalog.rows,
        equivalencies: equivalencies.rows,
        pastDecisions: decisions.rows,
        syllabi: catalog.rows.filter((c) => c.syllabus).map((c) => ({ institution: c.institution, course_code: c.course_code, syllabus: c.syllabus })),
      });
    })().catch((err) => { enginePromise = null; throw err; });
  }
  return enginePromise;
}

/** Forces the next evaluation to reload reference data (after equivalencies or decisions change). */
export function invalidateEngine() {
  enginePromise = null;
}

/**
 * Reads the course rows from an uploaded transcript PDF into transcript_courses.
 * Courses are appended after any already on the application, keeping transcript order.
 */
export async function importTranscript(applicationId, documentId, buffer) {
  const parsed = await parseTranscript(buffer);
  if (!parsed.institution || parsed.courses.length === 0) return { institution: parsed.institution, courses: 0 };

  // The PDF truncates long titles; use the catalog title when the course is known
  const titles = await query(`SELECT UPPER(course_code) AS code, title FROM catalog_courses WHERE institution = $1`, [parsed.institution]);
  const titleOf = new Map(titles.rows.map((r) => [r.code, r.title]));
  const next = await query(`SELECT COALESCE(MAX(position), 0) AS last FROM transcript_courses WHERE application_id = $1`, [applicationId]);
  let position = Number(next.rows[0].last);

  for (const c of parsed.courses) {
    position += 1;
    await query(
      `INSERT INTO transcript_courses (application_id, document_id, position, institution, course_code, title, term, credit_system, source_credits, grade)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [applicationId, documentId, position, parsed.institution, c.course_code, titleOf.get(c.course_code.toUpperCase()) || c.title,
        c.term, parsed.credit_system, c.source_credits, c.grade]
    );
  }
  return { institution: parsed.institution, courses: parsed.courses.length };
}

/**
 * Runs the engine over the application's transcript courses and stores one row per course.
 * @returns {Promise<{summary, results}|null>} null when no transcript courses have been read yet
 */
export async function evaluateApplicationCredits(application, evaluationId) {
  const { rows: courses } = await query(`SELECT * FROM transcript_courses WHERE application_id = $1 ORDER BY position`, [application.id]);
  if (courses.length === 0) return null;

  const engine = await getEngine();
  const { results, summary } = engine.evaluateTranscript(
    courses.map((c) => ({ ...c, source_credits: Number(c.source_credits) })),
    { major: application.transfer_to_program },
  );

  for (let i = 0; i < courses.length; i++) {
    const r = results[i];
    await query(
      `INSERT INTO course_evaluations (application_id, ai_evaluation_id, transcript_course_id, path, outcome, award, suggestion, bu_credits, confidence,
         rules, precedent_ids, equivalency_id, candidates, reasons, engine_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [application.id, evaluationId, courses[i].id, r.path, r.outcome, r.award, r.suggestion, r.bu_credits, r.confidence,
        r.rules, r.precedent_ids, r.equivalency_id, JSON.stringify(r.candidates), JSON.stringify(r.reasons), ENGINE_VERSION]
    );
  }
  return { summary, results, courses };
}

/** Transcript courses with the given evaluation's result for each (result fields are null before any evaluation). */
export async function getCourseEvaluations(applicationId, evaluationId = null) {
  const result = await query(
    `SELECT tc.id, tc.position, tc.institution, tc.course_code, tc.title, tc.term, tc.credit_system, tc.source_credits, tc.grade,
            ce.path, ce.outcome, ce.award, ce.suggestion, ce.bu_credits, ce.confidence, ce.rules, ce.precedent_ids, ce.equivalency_id,
            ce.candidates, ce.reasons
     FROM transcript_courses tc
     LEFT JOIN course_evaluations ce ON ce.transcript_course_id = tc.id AND ce.ai_evaluation_id = $2
     WHERE tc.application_id = $1
     ORDER BY tc.position`,
    [applicationId, evaluationId]
  );
  return result.rows;
}

export default { importTranscript, evaluateApplicationCredits, getCourseEvaluations, invalidateEngine };
