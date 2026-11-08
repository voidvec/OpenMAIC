/**
 * The quiz booklet: one printable HTML file holding every quiz of a lesson.
 *
 * A quiz scene is structured data, not a page — unlike an interactive scene it
 * has no HTML of its own — so before this module a quiz reached the customer
 * only as a PPTX placeholder pointing into the online classroom. That link is
 * dead the moment the deck leaves the deployment, which is exactly the case the
 * resource pack exists for.
 *
 * One booklet, not one page per quiz: a lesson's quizzes are handed out
 * together, and a shelf of files is worse to open and worse to print. Each quiz
 * becomes a section, and every answer is collected at the end, so the question
 * pages can be printed for students without the key and the answers printed
 * separately for the teacher.
 *
 * No answering, deliberately: scoring needs a state machine, a retry path and a
 * way to keep the answers out of the reader's hands, and a booklet that pretends
 * to do that would be worse than one that plainly does not. The answers are in
 * the file — this is the teacher's copy, and a deployment that cannot live with
 * that must not ship the booklet rather than ship a broken version of it.
 *
 * Pure by construction: no React, no DOM, no i18n singleton. Every string and
 * identifier arrives from the caller, so the output is deterministic, testable,
 * and reads in the same language as the rest of the export.
 */
import type { QuizQuestion } from '@openmaic/dsl';

import type { Scene } from '@/lib/types/stage';

/** Question types the booklet can lay out, in the order they are introduced. */
type QuestionType = QuizQuestion['type'];

/**
 * The localized strings and identifiers one booklet is written with.
 *
 * Labels the rest of the export already owns (题型, 参考答案, 解析) are passed in
 * rather than re-declared here, so the booklet never grows a second vocabulary
 * for concepts the product has already named.
 */
export interface QuizBookletText {
  /** Document title, e.g. "随堂测试题册". */
  title: string;
  /** Heading of the answer half, e.g. "参考答案与解析". */
  answerSection: string;
  /** "第 {{n}} 题" — `{{n}}` is replaced with the question number. */
  questionNumber: string;
  /** "共 {{count}} 道题" — the cover's one-line summary. */
  questionCount: string;
  /** Per-type badge, keyed by question type. */
  typeLabel: Record<QuestionType, string>;
  /** Suffix after a question's points, e.g. "分". */
  pointsSuffix: string;
  /** "参考答案". */
  answerKey: string;
  /** Shown when a question ships no answer. */
  noAnswer: string;
  /** "解析". */
  analysis: string;
  /** Heading above a short-answer question's grading guidance. */
  gradingPoints: string;
  /** AIGC 显式标识 text; an exported file must carry it (办法第 4 条). */
  aigcLabel: string;
  /** Locale of the document, for `<html lang>`. */
  lang: string;
  /** Signer of the file, written to `<meta name="generator">`. */
  generator: string;
}

/** The AIGC identifiers 《标识办法》§5 requires in the file metadata. */
export interface QuizBookletNotices {
  provider: string;
  contentId: string;
}

export interface QuizBookletSection {
  /** Anchor this section answers to, e.g. `quiz-2`. */
  id: string;
  title: string;
  questions: readonly QuizQuestion[];
}

/** A section plus the scene it came from, for the caller that has to link to it. */
export interface QuizBookletEntry extends QuizBookletSection {
  scene: Scene;
}

export interface QuizBookletInput {
  text: QuizBookletText;
  notices: QuizBookletNotices | null;
  sections: readonly QuizBookletSection[];
}

/** Directory the booklet lives in inside the Resource Pack. */
export const QUIZ_BOOKLET_DIR = 'quiz';

/** Characters that are illegal in a filename on any platform this ships to. */
const ILLEGAL_FILE_NAME_CHARS = /[\\/:*?"<>|]/g;

/**
 * The booklet's path inside the Resource Pack.
 *
 * The file name is the localized title so the pack reads like a pack rather
 * than a pile of Latin directory names; the caller passes the same string to
 * the PPTX placeholder, so a link and its target cannot drift apart.
 */
export function quizBookletPath(title: string | undefined): string {
  const name = (title ?? '').trim().replace(ILLEGAL_FILE_NAME_CHARS, '_') || 'quiz';
  return `${QUIZ_BOOKLET_DIR}/${name}.html`;
}

/** Anchor of the n-th (1-based) quiz section, in lesson order. */
export function quizSectionAnchor(index: number): string {
  return `quiz-${index}`;
}

/**
 * The quizzes that make it into the booklet, in lesson order.
 *
 * A quiz with no usable question is dropped rather than rendered as an empty
 * heading: an export that silently reports "3 组测验" while showing two is worse
 * than one that reports two. The section keeps its 1-based number across the
 * scenes that survive, because the anchors are what the deck links to.
 */
export function listQuizBookletSections(scenes: readonly Scene[]): QuizBookletEntry[] {
  const sections: QuizBookletEntry[] = [];
  for (const scene of scenes) {
    if (scene.content.type !== 'quiz') continue;
    const questions = (scene.content.questions ?? []).filter(
      (question) => typeof question?.question === 'string' && question.question.trim() !== '',
    );
    if (questions.length === 0) continue;
    sections.push({
      scene,
      id: quizSectionAnchor(sections.length + 1),
      title: typeof scene.title === 'string' ? scene.title.trim() : '',
      questions,
    });
  }
  return sections;
}

// ── Rendering ──

/**
 * The five characters that would otherwise become markup.
 *
 * Tolerates a missing string. Every label here comes from the i18n catalogue,
 * and a catalogue is the one input this module cannot police: a locale that
 * lags the source, or a caller whose `t` returns nothing for an unknown key,
 * would otherwise turn "one label is missing" into "the whole Resource Pack
 * fails to export". A blank label is a worse document than a complete one but
 * a better outcome than a failed handover.
 */
function escapeHtml(text: string | undefined | null): string {
  return (typeof text === 'string' ? text : '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Multi-line question text keeps its breaks; a stray newline is not markup. */
function escapeHtmlBlock(text: string): string {
  return escapeHtml(text).replace(/\r?\n/g, '<br>');
}

function isScorable(type: QuestionType): boolean {
  return type === 'single' || type === 'multiple';
}

/** The answer values of a question, as the deck and the player show them. */
function answerValues(question: QuizQuestion): string[] {
  const answer = Array.isArray(question.answer) ? question.answer : [];
  return answer.map((value) => String(value).trim()).filter(Boolean);
}

/** `第 3 题` for a localized template that carries `{{n}}`. */
function questionNumber(template: string | undefined, index: number): string {
  return (template ?? '').replace(/\{\{\s*n\s*\}\}/g, String(index));
}

function pointsNote(question: QuizQuestion, suffix: string | undefined): string {
  const points = typeof question.points === 'number' ? question.points : 1;
  if (!Number.isFinite(points) || points <= 0) return '';
  return `${points} ${suffix ?? ''}`.trim();
}

/** One question in the question half: number, type, points, stem, options. */
function renderQuestion(question: QuizQuestion, index: number, text: QuizBookletText): string {
  const badges = [
    questionNumber(text.questionNumber, index),
    text.typeLabel?.[question.type] ?? question.type,
    pointsNote(question, text.pointsSuffix),
  ].filter(Boolean);
  const options = (question.options ?? [])
    .filter((option) => option && typeof option.label === 'string')
    .map(
      (option) =>
        `<li class="option"><span class="option-tag">${escapeHtml(String(option.value ?? ''))}</span>` +
        `<span class="option-text">${escapeHtmlBlock(option.label)}</span></li>`,
    );
  return [
    '<li class="question">',
    `<p class="question-head">${badges.map((badge) => `<span class="badge">${escapeHtml(badge)}</span>`).join('')}</p>`,
    `<p class="stem">${escapeHtmlBlock(question.question)}</p>`,
    options.length > 0 ? `<ul class="options">${options.join('')}</ul>` : '',
    // Room to write when the page is printed: the booklet is also the answer
    // sheet for a class that has no devices.
    isScorable(question.type) ? '' : '<div class="answer-space"></div>',
    '</li>',
  ].join('');
}

/** One question in the answer half: the key, the explanation, the guidance. */
function renderAnswer(question: QuizQuestion, index: number, text: QuizBookletText): string {
  const values = answerValues(question);
  const key =
    values.length > 0 && question.hasAnswer !== false
      ? isScorable(question.type)
        ? `<span class="key">${values.map((value) => escapeHtml(value)).join('</span><span class="key">')}</span>`
        : escapeHtmlBlock(values.join((text.lang ?? '').startsWith('zh') ? '、' : ', '))
      : `<span class="muted">${escapeHtml(text.noAnswer)}</span>`;
  const analysis =
    typeof question.analysis === 'string' && question.analysis.trim()
      ? `<p class="note"><span class="note-label">${escapeHtml(text.analysis)}</span>${escapeHtmlBlock(question.analysis)}</p>`
      : '';
  const grading =
    question.type === 'short_answer' &&
    typeof question.commentPrompt === 'string' &&
    question.commentPrompt.trim()
      ? `<p class="note"><span class="note-label">${escapeHtml(text.gradingPoints)}</span>${escapeHtmlBlock(question.commentPrompt)}</p>`
      : '';
  return [
    '<li class="answer">',
    `<p class="question-head"><span class="badge">${escapeHtml(questionNumber(text.questionNumber, index))}</span></p>`,
    `<p class="keyline"><span class="note-label">${escapeHtml(text.answerKey)}</span>${key}</p>`,
    analysis,
    grading,
    '</li>',
  ].join('');
}

const BOOKLET_STYLE = `
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;padding:32px 28px 56px;background:#fff;color:#1f2937;
 font:16px/1.7 system-ui,-apple-system,"Segoe UI","Noto Sans CJK SC","PingFang SC",sans-serif}
.page{max-width:820px;margin:0 auto}
.cover{border-bottom:2px solid #1f2937;padding-bottom:16px;margin-bottom:28px}
h1{font-size:26px;line-height:1.35;margin:0 0 6px}
.cover p{margin:0;color:#6b7280;font-size:14px}
h2{font-size:19px;margin:32px 0 12px;padding-left:10px;border-left:4px solid #4f46e5}
h3{font-size:15px;margin:22px 0 8px;color:#374151}
ol,ul{list-style:none;margin:0;padding:0}
.question{border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px;margin:0 0 14px;
 break-inside:avoid;page-break-inside:avoid}
.question-head{margin:0 0 8px;display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.badge{font-size:12px;font-weight:600;color:#4f46e5;background:#eef2ff;border-radius:999px;padding:1px 9px}
.stem{margin:0 0 10px;white-space:normal}
.options{margin:0}
.option{display:flex;gap:8px;padding:2px 0}
.option-tag{flex:0 0 22px;color:#6b7280;font-weight:600}
.option-text{flex:1 1 auto}
.answer-space{height:76px;border-bottom:1px dashed #d1d5db;margin-top:12px}
.answers{margin-top:40px;padding-top:20px;border-top:2px dashed #d1d5db;break-before:page;page-break-before:always}
.answer{padding:0 0 10px;margin:0 0 12px;border-bottom:1px solid #f3f4f6;break-inside:avoid}
.keyline{margin:0 0 6px;display:flex;flex-wrap:wrap;gap:8px;align-items:baseline}
.key{display:inline-block;min-width:26px;text-align:center;font-weight:600;color:#065f46;
 background:#ecfdf5;border-radius:6px;padding:0 8px}
.note-label{color:#6b7280;font-size:13px;margin-right:8px}
.note{margin:4px 0 0;color:#374151}
.muted{color:#9ca3af}
footer{margin-top:36px;padding-top:12px;border-top:1px solid #e5e7eb;color:#9ca3af;font-size:12px}
@media print{
 body{padding:0;font-size:12pt}
 .page{max-width:none}
 .question{border-color:#d1d5db}
}
`.trim();

/**
 * Render the whole booklet.
 *
 * The AIGC notice is a static line at the end of the document rather than a
 * pinned badge: this file is handed over as a document, and 《标识办法》第 4 条
 * asks a text-shaped artifact for the notice at its start, middle or end. A
 * pinned badge also prints badly — browsers disagree on whether a fixed element
 * repeats on every page — while a line at the end is there on paper too.
 */
export function renderQuizBooklet(input: QuizBookletInput): string {
  const { text, notices, sections } = input;
  const total = sections.reduce((sum, section) => sum + section.questions.length, 0);
  const questions = sections.map((section) =>
    [
      `<section id="${escapeHtml(section.id)}">`,
      section.title ? `<h2>${escapeHtmlBlock(section.title)}</h2>` : '',
      `<ol>${section.questions.map((question, index) => renderQuestion(question, index + 1, text)).join('')}</ol>`,
      '</section>',
    ].join(''),
  );
  const answers = sections.map((section) =>
    [
      `<section id="${escapeHtml(section.id)}-answers">`,
      section.title ? `<h3>${escapeHtmlBlock(section.title)}</h3>` : '',
      `<ol>${section.questions.map((question, index) => renderAnswer(question, index + 1, text)).join('')}</ol>`,
      '</section>',
    ].join(''),
  );

  const head = [
    '<!doctype html>',
    `<html lang="${escapeHtml(text.lang)}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta name="generator" content="${escapeHtml(text.generator)}">`,
    // The hidden half of the notice (§6.1): present in the file, not on the page.
    // Both halves follow the same switch, so a booklet cannot end up carrying
    // metadata that says "generated" while the page says nothing.
    ...(notices
      ? [
          '<meta name="ai-generated" content="true">',
          `<meta name="aigc:provider" content="${escapeHtml(notices.provider)}">`,
          `<meta name="aigc:content-id" content="${escapeHtml(notices.contentId)}">`,
        ]
      : []),
    `<title>${escapeHtml(text.title)}</title>`,
    `<style>${BOOKLET_STYLE}</style>`,
    '</head>',
  ];

  return [
    ...head,
    '<body>',
    '<div class="page">',
    '<header class="cover">',
    `<h1>${escapeHtml(text.title)}</h1>`,
    `<p>${escapeHtml(
      (text.questionCount ?? '').replace(/\{\{\s*count\s*\}\}/g, String(total)),
    )}</p>`,
    '</header>',
    '<main>',
    ...questions,
    '</main>',
    answers.length > 0
      ? [
          '<section class="answers">',
          `<h2>${escapeHtml(text.answerSection)}</h2>`,
          ...answers,
          '</section>',
        ].join('')
      : '',
    notices && text.aigcLabel
      ? `<footer>${escapeHtml(text.aigcLabel)} · ${escapeHtml(notices.provider)} · ${escapeHtml(notices.contentId)}</footer>`
      : '',
    '</div>',
    '</body>',
    '</html>',
  ].join('\n');
}
