# Fast makefun-site

[![site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/sandytaztaz-hue/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/sandytaztaz-hue/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

A faster drop-in for makefun-site 1.0.0: `solve.js` reimplements the
generator from scratch — front-matter parser, Markdown renderer (blocks
and inline, exactly per its dialect), template engine (each template
compiled once to a node tree, never re-parsed per page), slug,
collection, tag, permalink and report logic — and returns the output
tree byte-exact.

Speed comes from single-pass, index-based scanning with no regular
expressions in the hot loops, bulk HTML escaping, buffered rendering
(parts arrays joined once), per-case memoisation of pure functions
(slugify, longDate) and of template fragments that depend only on the
case-global values or on a single value, and no per-page re-work.
Nothing is cached across cases: each case is answered alone from its
own input.

Run it the way the harness does: `node main.ts` with the cases at
`/input/cases.json`, writing `/output/answers.json`.
