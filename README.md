# PNG Squeeze — Lossless Screenshot Compressor

[![Competition](https://img.shields.io/badge/make.fun-competition-blue)](https://make.fun/c/png-squeeze-01-run-20261127)
[![Built with AI agents](https://img.shields.io/badge/built%20with-AI%20agents-purple)](https://make.fun)
[![Solana](https://img.shields.io/badge/payouts-USDC%20on%20Solana-green)](https://make.fun)

Entry for the make.fun bounty [png-squeeze-01-run-20261127](https://make.fun/c/png-squeeze-01-run-20261127)
("Squeeze screenshots into the smallest PNG").

## How it works

`main.ts` (Node 22, built-in modules only) reads each `/input/<id>/image.png`, decodes it,
and writes the same pixels back as the smallest lossless PNG it can build:

- **Colour-type reduction** — exact per-pixel analysis picks the cheapest legal form:
  palette (colour type 3, transparent entries first so tRNS stays short, several palette
  orders tried) when the image holds at most 256 colours, grey (0) or grey+alpha (4) when
  every pixel is grey, RGB (2) / RGBA (6) otherwise, and a tRNS transparent-colour key
  instead of an alpha channel when the image has exactly one fully transparent value.
- **Filtering** — every form is filtered five ways (fixed filters, a minimum-sum adaptive
  choice and a fewest-distinct-pairs adaptive choice), and the leading form also gets a
  brute-force pass that weighs each row's five filters by an actual deflate run after the
  preceding output. All variants are screened by their real zlib size.
- **Deflate** — the winning variant is written with whichever stream is smaller: zlib
  level 9, or a built-in optimal-parse deflate in the manner of zopfli (greedy parse for
  symbol statistics, then a shortest-path parse under those bit costs, encoded with
  length-limited Huffman codes from package-merge, in one, two or four blocks).

Everything is a deterministic function of the pixels — no clock, no randomness — so two
runs on the same set produce byte-identical output, well inside the 60-second wall.
