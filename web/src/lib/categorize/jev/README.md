# Jev question setup (TypeSafe System One)

`questions.json` is the question set for categorising one transaction with
[Jev](https://docs.typesafe.ai/introduction). It holds only Fulla's budget category
names and hand-written descriptions. The example lines are made up, and there are
no real transactions in it.

- One request per transaction. `state` is `{"transaction": {"description", "amount", "direction"?}}`.
  Leave the bank or institution name out: in testing, "Wealthsimple" pulled
  ordinary purchases into Savings & Investing.
- `questions.parent` is a Choice over the 19 parent categories. Each option is a
  `{what, not_for, examples}` object (docs: Choice > Structured instructions and criteria).
- `questions.sub__*` is one Choice per parent over that parent's subcategories. All 19
  go in the same request (docs: Speculative fan-out). Read the one for the chosen parent
  (`sub_question_ids`), or take argmax of P(parent) × P(sub | parent) over all of them.
- Gate on confidence. If the parent's `confidence` is below 0.8, or the joint probability is below 0.7,
  send the line to review instead of applying the category.
- `fulla_keys` maps each parent to Fulla's starting category (the same as `PARENTS` in
  `../../categorizer.ts`). `null` means it isn't spending (a transfer or a saving).
- The model is pinned to `jev-1.13.0` so the cutoffs stay valid. Re-test before moving to a newer Jev.

## v2 (`questions.v2.json`, tuned October 2026)

- `flat`: one Choice over the 19 parents. Each option is `{includes, examples, excludes}` with
  generic Canadian brand names, following the jev-cookbook "describe every option, say what
  doesn't count" rule. `sub__*`: one Choice per parent, all sent in the same request.
- `state.transaction` carries facts computed in code: direction, an amount band (not the raw
  number), how often the merchant recurs, and day of month. Names, account numbers and bank
  names are stripped first.
- Pick the parent as argmax of `flat`; pick the pair as argmax of P(parent) x P(sub | parent).
  Auto-apply at `flat.confidence >= 0.7`, otherwise send to review.
- Pinned to `jev-1.13.0` so the cutoff stays valid.

## In the app

`questions.v2.json` is the one the app uses (`src/lib/server/jev.ts`, server-side only,
`TYPESAFE_API_KEY`). Order: household rules → transfer and debt patterns → known
merchants → Jev → Other. An answer below 0.7 confidence is not applied: the line goes to
Other with the `fulla:review` tag and shows under History → Review. Debt Payments has
Fulla's subcategories (Personal Loan, Line of Credit, Buy Now Pay Later, Student Loan,
Car Loan, Other Debt); its two credit-card options mean a card bill, which is a transfer.
These subcategories were added after the tuning round and have not been re-scored.
`questions.json` (v1) is kept for reference only.
