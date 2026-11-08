---
name: contest-entry
title: "参赛材料包"
description: A competition entry pack — a submission-ready micro-lesson whose slides carry the teaching, three to five interactive pages carry the hard concept, and exactly one quiz produces the printable question booklet that the entry form asks for. Use when the ask is 参赛、报送、微课比赛、优质课、赛课、教学能力比赛、赛题定制, a submission with a fixed page or duration budget, or any request that names a competition or an evaluation form. Not for a self-study course (that is `lecture-style`) and not for a mechanism-first exploratory course (that is `deep-interactive`).
---

# Competition entry pack

You are building **one entry**, not one course. Three things follow from that
and they govern everything below: a reviewer sees the deck first and may never
open a browser, the entry form asks for a printable quiz, and the whole thing
has to fit a stated page or duration budget rather than run as long as the topic
deserves.

`stage-design` still governs how the stage is built — plan, roster, one page per
`generate_scene`, audio before done. This skill governs what the entry contains.

## The shape

Ten to twelve pages, and the mix is not a preference — it is what the submission
is read as. That page budget is the one number here nothing checks: no skill caps
total length, because a course's length follows its material. In an entry the
form does cap it, so hold the budget while you plan rather than discovering it at
page fourteen.

- **Scene 1 is a `slide`**: the课题, the学段/学科, and the one problem the lesson
  solves. No agenda page, no 「教学目标」list read aloud.
- **The body is `slide` pages**, and they are the majority. A reviewer who prints
  the deck gets the lesson; anything that only exists inside an interactive page
  is a page they cannot read.
- **Three to five `interactive` pages**, all at the points where a static diagram
  genuinely fails — the transformation, the parameter that changes the shape, the
  step that must be wrong before it is right. These are the entry's evidence that
  it uses digital means, and evidence is worth more concentrated than spread.
- **Exactly one `quiz` page**, placed after the body has taught the thing and
  before the closing summary. See 「The quiz is the booklet」 below — the number
  one is load-bearing.
- **Close on a `slide`** that states what the learner can now do, not a bullet
  recap of the titles.

## Why the caps are where they are

- **Slides ≥ half.** Every `interactive` scene becomes a placeholder slide in the
  exported deck — a page that says 「此页为交互页面，点击打开」. Two or three of
  those read as design; seven read as a deck that is mostly holes, and the
  reviewer's copy is the deck.
- **Interactive ≤ 5.** Beyond five the pages stop being the hard concept and
  start being variety for its own sake, which costs render time and buys nothing
  a reviewer scores.
- **Quiz = 1.** A submitted entry carries one 随堂练习. Two quiz pages produce one
  booklet with two sections, which the entry form does not ask for and the
  reviewer reads as padding.

## The quiz is the booklet

The deliverable's question booklet is generated from `quiz` scenes — the booklet
*is* the quiz scene, laid out for printing, questions first and the answer key
after. Zero quiz pages means no booklet at all, and the entry arrives missing the
one attachment the form lists.

So when this skill is active, the quiz page is not optional and not a checkpoint
in the middle of the body: it is a real 随堂测试 with six to eight questions
(`quizConfig.questionCount`), a mix of `single` for the fast checks and
`short_answer` for the ones that show understanding, every question carrying an
`analysis`. Write the analysis as the sentence a teacher would say while marking,
not as a restatement of the answer — it is printed next to the answer key and it
is the part that reads as professional.

## Page density

Four to six `keyPoints` per body page, as propositions rather than labels —
「先看开口方向，再看对称轴，最后代一个点」rather than 「判断方法」. One page
carries one step of the lesson plus the reason it is that step.

Narration is what a reviewer hears in the first thirty seconds, so it carries the
entry more than any single page does:

- Every page gets continuous teacher speech, three to five sentences, moving the
  lesson forward rather than describing the page.
- Name the mistake before correcting it — 「很多同学看到 a>0 就直接画开口向上，其实
  这一题要先配方」. A lesson that never acknowledges the wrong answer sounds like a
  script being read.
- No teacher identity on slides or in titles. The title page of the submission is
  a separate printed card the operator supplies; the deck stays about the subject.

## Naming and sequencing

Titles are the lesson's own steps, in the subject's language — 「先配方，再看对称轴」
「为什么顶点式比一般式好用」「四个交点，一个都别丢」. Sequencing follows the
teaching order, not a template: an interactive page sits where the concept is
hard, not where the layout would look balanced.

## Handing it over

Facts the operator needs and the agent must not promise:

- The booklet, the deck, the script and the subtitles come out of the export menu;
  the booklet exists **only** if the quiz page does.
- The submission's frame rate, resolution and file-naming rules are decided
  **before** rendering — they are render parameters, and a 25 fps requirement
  discovered after a 30-minute render means rendering again.
- A 片头页 (title card) is not produced by the product; it is a separate artefact.

## If the request is not a competition entry

If nothing is being submitted — no deadline, no form, no page or duration budget —
say so in one sentence and use `lecture-style` (teaching a subject) or
`deep-interactive` (understanding a mechanism) instead. The caps in this skill
are submission constraints; applied to a course nobody is judging, they only make
it shorter than it should be.
