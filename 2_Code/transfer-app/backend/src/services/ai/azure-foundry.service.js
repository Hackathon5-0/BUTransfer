import OpenAI from 'openai';
import { env } from '../../config/env.js';

// Configure for Azure OpenAI / Azure AI Foundry
let client = null;
if (env.AZURE_OPENAI_ENDPOINT && env.AZURE_OPENAI_API_KEY) {
  client = new OpenAI({
    apiKey: env.AZURE_OPENAI_API_KEY,
    baseURL: `${env.AZURE_OPENAI_ENDPOINT}/openai/deployments/${env.AZURE_OPENAI_DEPLOYMENT}`,
    defaultQuery: { 'api-version': env.AZURE_OPENAI_API_VERSION },
    defaultHeaders: { 'api-key': env.AZURE_OPENAI_API_KEY },
  });
}

const SYSTEM_PROMPT = `You are an expert Transfer Credit Evaluator at Boston University (BU).
Your task is to objectively evaluate a student's transfer application against BU's admission criteria and produce a structured evaluation report.

EVALUATION PRINCIPLES:
- Be thorough, fair, and consistent.
- Evaluate each eligibility criterion individually with clear reasoning.
- Identify missing documents or information required for a complete evaluation.
- Flag any exceptional circumstances (positive or negative).
- Your evaluation supports human evaluators who make the final decision.

OUTPUT FORMAT (return ONLY valid JSON, no markdown fences):
{
  "criteria_results": [
    { "criterion_id": "<uuid>", "criterion_name": "<string>", "result": "pass" | "fail" | "unable_to_determine", "score": 0-100, "explanation": "<detailed explanation>" }
  ],
  "missing_documents": [
    { "document_type": "<type>", "description": "<what is needed and why>", "is_blocking": true | false }
  ],
  "flags": [
    { "type": "positive" | "concern" | "critical", "title": "<short title>", "description": "<detailed description>" }
  ],
  "recommendations": "<overall recommendation paragraph, max 300 words>",
  "evaluation_report": "<detailed evaluation narrative, 400-800 words>",
  "confidence_score": 0.0-1.0
}`;

function buildUserMessage(application, documents, criteria) {
  const docSummary = documents.length > 0 ? documents.map((d) => `- ${d.document_type}: ${d.file_name}`).join('\n') : 'No documents uploaded yet.';
  const criteriaSummary = criteria.map((c) =>
    `* [${c.id}] ${c.criterion_name} (${c.rule_type}) - ${c.description}` +
    (c.is_required ? ' [REQUIRED]' : ' [OPTIONAL]') +
    (c.rule_config && Object.keys(c.rule_config).length > 0 ? `\n  Config: ${JSON.stringify(c.rule_config)}` : '')
  ).join('\n');

  return `TRANSFER APPLICATION FOR EVALUATION
====================================
Reference: ${application.reference_number}
Source: ${application.source}
Submitted: ${application.submitted_at || 'Not yet submitted'}

STUDENT:
- Name: ${application.student_name}
- Email: ${application.student_email}
- DOB: ${application.date_of_birth || 'Not provided'}

TRANSFER DETAILS:
- From: ${application.transfer_from_institution}
- Previous Program: ${application.transfer_from_program || 'Not specified'}
- To Program: ${application.transfer_to_program}
- To Department: ${application.transfer_to_department || 'Not specified'}
- Expected Start: ${application.expected_start_term || 'Not specified'}

ACADEMIC HISTORY:
${JSON.stringify(application.academic_history || {}, null, 2)}

PERSONAL STATEMENT:
${application.personal_statement || 'Not provided'}

DOCUMENTS (${documents.length}):
${docSummary}

ELIGIBILITY CRITERIA:
${criteriaSummary}

Please evaluate against all criteria and return structured JSON.`;
}

function normaliseResult(parsed, criteria) {
  return {
    criteria_results: Array.isArray(parsed.criteria_results) ? parsed.criteria_results : criteria.map((c) => ({
      criterion_id: c.id, criterion_name: c.criterion_name, result: 'unable_to_determine', score: 50, explanation: 'Could not be evaluated with available information.',
    })),
    missing_documents: Array.isArray(parsed.missing_documents) ? parsed.missing_documents : [],
    flags: Array.isArray(parsed.flags) ? parsed.flags : [],
    recommendations: parsed.recommendations || 'No recommendations provided.',
    evaluation_report: parsed.evaluation_report || 'Evaluation report not generated.',
    confidence_score: typeof parsed.confidence_score === 'number' ? Math.min(1, Math.max(0, parsed.confidence_score)) : 0.5,
  };
}

export async function evaluateApplication(application, documents, criteria) {
  if (!client) {
    console.warn('[AI] Azure OpenAI not configured - returning mock evaluation');
    return getMockEvaluation(application, criteria);
  }
  const userMessage = buildUserMessage(application, documents, criteria);
  try {
    const response = await client.chat.completions.create({
      model: env.AZURE_OPENAI_DEPLOYMENT,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: userMessage }],
      temperature: 0.2,
      max_tokens: 3000,
      response_format: { type: 'json_object' },
    });
    const raw = response.choices[0]?.message?.content;
    if (!raw) throw new Error('Empty response from Azure OpenAI');
    return normaliseResult(JSON.parse(raw), criteria);
  } catch (err) {
    console.error('[AI] Azure OpenAI evaluation failed:', err.message);
    throw err;
  }
}

export function getMockEvaluation(application, criteria) {
  const resultOptions = ['pass', 'pass', 'pass', 'fail', 'unable_to_determine'];
  const criteriaResults = criteria.map((criterion, index) => {
    const result = resultOptions[index % resultOptions.length];
    const score = result === 'pass' ? 80 + Math.floor(Math.random() * 20) : result === 'fail' ? 30 : 50;
    return {
      criterion_id: criterion.id,
      criterion_name: criterion.criterion_name,
      result,
      score,
      explanation: `Evaluation of ${criterion.criterion_name} (${criterion.rule_type}) based on available application information. ${result === 'pass' ? 'Criterion satisfied.' : result === 'fail' ? 'Criterion not met - additional documentation required.' : 'Cannot determine without additional documentation.'}`,
    };
  });

  const passCount = criteriaResults.filter((r) => r.result === 'pass').length;
  const failCount = criteriaResults.filter((r) => r.result === 'fail').length;

  return {
    criteria_results: criteriaResults,
    missing_documents: failCount > 0 ? [
      { document_type: 'transcript', description: 'Official transcripts from all previously attended institutions are required.', is_blocking: true },
      { document_type: 'syllabus', description: 'Course syllabi for transfer credit equivalency assessment.', is_blocking: false },
    ] : [],
    flags: [
      { type: 'positive', title: 'Application Received', description: `${application.student_name} has submitted a transfer application from ${application.transfer_from_institution}.` },
      ...(failCount > 0 ? [{ type: 'concern', title: 'Incomplete Documentation', description: `${failCount} criteria could not be fully evaluated due to missing documentation.` }] : []),
    ],
    recommendations: failCount === 0
      ? `This application meets core eligibility requirements for transfer to ${application.transfer_to_program}. Recommend proceeding with departmental review.`
      : `Additional documentation is required before a final determination. Recommend sending an information request to the student.`,
    evaluation_report: `TRANSFER EVALUATION REPORT\nApplication: ${application.reference_number}\nStudent: ${application.student_name}\nFrom: ${application.transfer_from_institution}\nTo: ${application.transfer_to_program} at Boston University\n\nSUMMARY: ${passCount}/${criteria.length} criteria passed. ${failCount} failed. ${criteria.length - passCount - failCount} undetermined.\n\nNote: This is an AI-assisted pre-evaluation. All final decisions must be made by a qualified human evaluator.`,
    confidence_score: parseFloat((passCount / (criteria.length || 1)).toFixed(2)),
  };
}

export default { evaluateApplication, getMockEvaluation };
