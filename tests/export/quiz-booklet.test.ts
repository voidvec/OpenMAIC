import { describe, expect, it } from 'vitest';
import type { Scene } from '@/lib/types/stage';
import {
  listQuizBookletSections,
  quizBookletPath,
  quizSectionAnchor,
  renderQuizBooklet,
  type QuizBookletText,
} from '@/lib/export/quiz-booklet';

/**
 * A quiz has no HTML of its own, so the booklet is the only copy of the
 * questions and the answer key that leaves the deployment. These tests pin the
 * things that would silently make it wrong: dropping a quiz, leaking the key
 * into the question half, and letting a question's own text rewrite the page.
 */
const TEXT: QuizBookletText = {
  title: '随堂测试题册',
  answerSection: '参考答案与解析',
  questionNumber: '第 {{n}} 题',
  questionCount: '共 {{count}} 道题',
  typeLabel: { single: '单选', multiple: '多选', short_answer: '简答' },
  pointsSuffix: '分',
  answerKey: '参考答案',
  noAnswer: '本题无参考答案',
  analysis: '解析',
  gradingPoints: '评分指引',
  aigcLabel: '本内容由 AI 生成',
  lang: 'zh-CN',
  generator: 'OpenMAIC',
};

const NOTICES = { provider: 'Acme 教育', contentId: 'stage-1' };

function quizScene(id: string, questions: unknown[], title = `Quiz ${id}`): Scene {
  return {
    id,
    stageId: 'stage-1',
    type: 'quiz',
    title,
    order: 0,
    content: { type: 'quiz', questions },
  } as unknown as Scene;
}

const single = {
  id: 'q1',
  type: 'single',
  question: '最大的行星是哪一颗？',
  options: [
    { label: '木星', value: 'A' },
    { label: '火星', value: 'B' },
  ],
  answer: ['A'],
  analysis: '木星的质量是其余行星总和的 2.5 倍。',
  points: 5,
};

const shortAnswer = {
  id: 'q2',
  type: 'short_answer',
  question: '简述轨道共振。',
  answer: ['周期呈整数比'],
  commentPrompt: '提到整数比即可给分。',
};

function render(scenes: Scene[], text: Partial<QuizBookletText> = {}): string {
  return renderQuizBooklet({
    text: { ...TEXT, ...text },
    notices: NOTICES,
    sections: listQuizBookletSections(scenes),
  });
}

describe('quizBookletPath', () => {
  it('names the file after the localized title', () => {
    expect(quizBookletPath('随堂测试题册')).toBe('quiz/随堂测试题册.html');
  });

  it('replaces characters that are illegal in a filename on some platform', () => {
    expect(quizBookletPath('Quiz: A/B?')).toBe('quiz/Quiz_ A_B_.html');
  });

  it('falls back to a fixed name when the title is blank', () => {
    expect(quizBookletPath('   ')).toBe('quiz/quiz.html');
    expect(quizBookletPath(undefined)).toBe('quiz/quiz.html');
  });
});

describe('listQuizBookletSections', () => {
  it('keeps one section per quiz, in lesson order', () => {
    const scenes = [
      quizScene('a', [single]),
      { id: 's', stageId: 'stage-1', type: 'slide', title: 'Slide', order: 1, content: {} },
      quizScene('b', [shortAnswer]),
    ] as unknown as Scene[];
    const sections = listQuizBookletSections(scenes);
    expect(sections.map((section) => section.scene.id)).toEqual(['a', 'b']);
    expect(sections.map((section) => section.id)).toEqual(['quiz-1', 'quiz-2']);
    expect(sections[0].id).toBe(quizSectionAnchor(1));
  });

  it('drops a quiz whose questions are all blank, without shifting the anchors', () => {
    const scenes = [
      quizScene('empty', [{ id: 'x', type: 'single', question: '   ' }]),
      quizScene('real', [single]),
    ] as unknown as Scene[];
    const sections = listQuizBookletSections(scenes);
    expect(sections).toHaveLength(1);
    expect(sections[0].scene.id).toBe('real');
    expect(sections[0].id).toBe('quiz-1');
  });

  it('returns nothing for a lesson with no quiz', () => {
    expect(listQuizBookletSections([])).toEqual([]);
  });
});

describe('renderQuizBooklet', () => {
  it('renders every question with its options, numbered from one per section', () => {
    const html = render([quizScene('a', [single, shortAnswer])]);
    expect(html).toContain('最大的行星是哪一颗？');
    expect(html).toContain('简述轨道共振。');
    expect(html).toContain('第 1 题');
    expect(html).toContain('第 2 题');
    // Options keep the key the grader compares against.
    expect(html).toContain('>A</span>');
    expect(html).toContain('木星');
    expect(html).toContain('单选');
    expect(html).toContain('5 分');
  });

  it('collects the answers in a section of their own, after the questions', () => {
    const html = render([quizScene('a', [single])]);
    const questionsEnd = html.indexOf('</main>');
    const answersStart = html.indexOf('参考答案与解析');
    expect(questionsEnd).toBeGreaterThan(-1);
    expect(answersStart).toBeGreaterThan(questionsEnd);
    // The key itself is below the divider, never beside the question.
    expect(html.slice(questionsEnd)).toContain('木星的质量');
  });

  it('states the total question count on the cover', () => {
    const html = render([quizScene('a', [single, shortAnswer]), quizScene('b', [single])]);
    expect(html).toContain('共 3 道题');
  });

  it('anchors each section so the deck can deep-link into it', () => {
    const html = render([quizScene('a', [single]), quizScene('b', [single])]);
    expect(html).toContain('<section id="quiz-1">');
    expect(html).toContain('<section id="quiz-2">');
    expect(html).toContain('<section id="quiz-1-answers">');
  });

  it('gives a short answer room to write on paper, a scorable one none', () => {
    const html = render([quizScene('a', [single])]);
    expect(html).not.toContain('class="answer-space"');
    expect(render([quizScene('a', [shortAnswer])])).toContain('class="answer-space"');
  });

  it('carries the grading guidance for a short answer', () => {
    const html = render([quizScene('a', [shortAnswer])]);
    expect(html).toContain('评分指引');
    expect(html).toContain('提到整数比即可给分。');
  });

  it('says so when a question ships no answer instead of leaving it blank', () => {
    const html = render([
      quizScene('a', [{ id: 'q', type: 'short_answer', question: '开放题', hasAnswer: false }]),
    ]);
    expect(html).toContain('本题无参考答案');
  });

  it('escapes question, option and answer text so a stem cannot write markup', () => {
    const html = render([
      quizScene('a', [
        {
          id: 'q',
          type: 'single',
          question: '<img src=x onerror="alert(1)">',
          options: [{ label: '<b>bold</b>', value: 'A<' }],
          answer: ['A<'],
          analysis: '</section><script>alert(2)</script>',
        },
      ]),
    ]);
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;img src=x');
    expect(html).toContain('&lt;b&gt;bold&lt;/b&gt;');
  });

  it('keeps the line breaks of a multi-line stem without opening a tag', () => {
    const html = render([quizScene('a', [{ id: 'q', type: 'short_answer', question: '一\n二' }])]);
    expect(html).toContain('一<br>二');
  });

  it('signs the file as AI-generated, visibly and in its metadata', () => {
    const html = render([quizScene('a', [single])]);
    expect(html).toContain('本内容由 AI 生成');
    expect(html).toContain('<meta name="ai-generated" content="true">');
    expect(html).toContain(`<meta name="aigc:provider" content="${NOTICES.provider}">`);
    expect(html).toContain(`<meta name="aigc:content-id" content="${NOTICES.contentId}">`);
    expect(html).toContain('<meta name="generator" content="OpenMAIC">');
    expect(html).toContain('lang="zh-CN"');
  });

  it('joins short answers with the locale’s own separator', () => {
    const question = { id: 'q', type: 'short_answer', question: 'Q', answer: ['甲', '乙'] };
    expect(render([quizScene('a', [question])])).toContain('甲、乙');
    expect(render([quizScene('a', [question])], { lang: 'en-US' })).toContain('甲, 乙');
  });

  it('still renders when a label is missing from the catalogue', () => {
    // A locale that lags the source must cost a blank heading, not a failed
    // export: this is the one input the module cannot validate.
    const html = renderQuizBooklet({
      text: { ...TEXT, title: undefined, questionNumber: undefined, lang: undefined } as never,
      notices: NOTICES,
      sections: listQuizBookletSections([quizScene('a', [single])]),
    });
    expect(html).toContain('最大的行星是哪一颗？');
  });
});
