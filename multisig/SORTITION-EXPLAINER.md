# How PollPower governs itself — in plain language

> **Companion to [`SORTITION-TABLE-DESIGN.md`](./SORTITION-TABLE-DESIGN.md).**
> That document is the technical spec; this one is the plain-English version
> for the team, partners, and community. **Everything here is a DEV DRAFT — a
> proposal, not something running today.** The pilot uses a simple fixed
> council; this is the blueprint for how governance scales *after* the pilot.

---

## The problem

As PollPower grows from one pilot village into a network of villages, someone
has to make the important decisions — approving new energy producers, changing
rules, managing keys. We call that group the **council**.

Every council has two classic failure modes:

- **A clique grabs power** and never lets go.
- **The rich buy their way in** and govern in their own interest.

This design is built to prevent both — permanently, and in a way anyone can
verify.

---

## The five ideas, plainly

**1. Governance is a lottery, like jury duty.**
Instead of electing councillors (a popularity contest) or letting the biggest
earners run things (rich-get-richer), we **randomly draw** the council each
term from everyone who qualifies. Random selection among qualified peers is
ancient, proven, and very hard to rig.

**2. "Qualified" means proven, not rich.**
You can't be drawn on day one — that would be like a stranger walking in off
the street to run the co-op. You need to be a verified, active member who's
been around a while (past an age-and-usage threshold). But once you clear that
bar, **everyone is equal in the draw.** A member who traded a little energy has
exactly the same odds as one who traded a lot. We deliberately do *not* give
big earners better odds — that's the trap we're avoiding.

**3. Nobody can cheat the draw.**
This is the heavy technical part, but the idea is simple: the lottery is run so
that **anyone can re-check the result themselves** and confirm it wasn't
tampered with. Both the list of who was eligible *and* the random "dice roll"
are locked in publicly, in an order that makes fixing the outcome impossible.

**4. You can say no.**
Being drawn is a *summons*, not a sentence. Life happens — people are busy,
sick, travelling. So you can **decline, no penalty, no questions.** If you
decline, the lottery simply keeps drawing until the seats are filled. The only
thing that gets a consequence is saying yes and then *ghosting* — because a
no-show councillor jams up decisions for everyone.

**5. Serving pays a little more — and that quietly helps those who need it.**
If you serve, your **share of the community dividend gets a temporary boost.**
Here's why that's clever: a bigger dividend slice barely matters to a
comfortable member, but it *really* matters to someone who's struggling. So the
people who most need the extra income are the ones most motivated to step up —
**without us ever asking anyone about their finances or means-testing them.**
The system quietly supports the people who support it. And because you can't
serve two terms in a row, nobody can turn this into a permanent paycheck.

---

## Why it matters, in one line

**No permanent bosses. No buying power. No rigged lotteries. And a built-in
reason for ordinary members — especially those who need it — to take a turn
steering the ship.** It's designed so the network can grow to hundreds of
villages and *still* be genuinely governed by its members, not captured by a
few.

---

## This is a constitution, not a feature list

Step back and the pieces all point the same direction:

> **Power should be temporary, earned by contribution rather than wealth,
> checkable by anyone, and gently biased toward those who need the system to
> work.**

That isn't a grab-bag of features — it's a **constitution for an energy
commons.** It's worth naming as such, because it reframes PollPower from *a
fintech pilot* into *a governance experiment that happens to move electricity*
— a framing that lands harder with funders, regulators, and the villages
themselves.

**Baseline reference — the Cardano Constitution.** PollPower runs on Cardano,
and Cardano is one of the very few blockchain ecosystems to have ratified a
real written constitution through a delegate convention process (the
constitutional convention, with the global workshop track held in Buenos
Aires). PollPower's founder was a **participant in drafting that constitution
in Argentina**, so this isn't borrowed language — it's the same constitutional
tradition, applied one level down: where the Cardano Constitution governs the
chain, PollPower's governance governs a *community that lives on* the chain.
That is exactly the "nested enterprises" principle Elinor Ostrom identified in
every durable commons — small local institutions nested inside larger ones,
each legitimate in its own right.

> **TODO (Garrett):** anchor the specific parallels to the canonical Cardano
> Constitution text — e.g. its articles on participation, checks on
> concentrated power, amendment/turnout requirements, and the role of the
> constitutional committee — and cite them directly. This section deliberately
> avoids quoting article numbers until they're verified against the ratified
> text. The strongest version pairs each PollPower mechanism above with the
> Cardano constitutional principle it mirrors.

---

## What's *not* decided yet

These are honest open questions, not finished answers:

- The exact qualifying thresholds (how long, how much usage) and how big the
  service boost is — all still to be calibrated.
- Whether big rule-changes should require a **minimum turnout** to count, not
  just a majority of whoever showed up (proposed — see the design doc §10.1).
- Whether the lottery's randomness should be drawn from the **community's own
  energy-trading activity** rather than an external source (an idea we like but
  want to prototype and stress-test first — design doc §10.2).

And the most important caveat: **resist building all of it at once.** The
strength of this design is that each part does one job and interlocks with the
others. The failure mode of clever governance is over-engineering it before
real people have used the simple version. The pilot's flat council is the right
call for now — these are the map for *after* people have actually lived in it.

---

*Plain-language companion authored 2026-07-10. DEV DRAFT — for team discussion.
The technical spec, with everything verified against the contract source, is in
[`SORTITION-TABLE-DESIGN.md`](./SORTITION-TABLE-DESIGN.md).*
